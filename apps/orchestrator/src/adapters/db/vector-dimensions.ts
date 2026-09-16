import { ADVISORY_LOCKS, type PgPool } from "./pool.js";
import { ensureVectorIndex } from "./vector-index.js";

/**
 * Vector dimension guard.
 *
 * The pgvector column `email_index.embedding` is created as `vector(N)` by the
 * very first migration, with `N = EMBEDDING_DIMENSIONS` **at that moment**. If
 * the configuration later changes — the classic case being a database migrated
 * before the `.env` existed (default 1024) and then an `.env` that selects
 * `text-embedding-3-small` (1536) — every insert of an embedding fails with
 *
 *     DatabaseError: expected 1024 dimensions, not 1536   (SQLSTATE 22000)
 *
 * which used to surface as a 500 "unhandled error" on `POST /index/emails`.
 *
 * This module detects the disagreement *at boot* (and in the `db:migrate` job)
 * and, depending on `DB_AUTO_MIGRATE`:
 *   - `true`  (dev / demo): re-dimensions the column, discarding the stored
 *     vectors (they were computed by another model anyway) and invalidating the
 *     `embedding_cache` entries that no longer match the model/dimension.
 *   - `false` (production): changes nothing and makes the instance **unready**
 *     with an actionable message, so an operator decides.
 *
 * The decision itself is a pure function (`decideVectorDimensions`) so it can be
 * unit-tested without a database.
 */

/** A `vector(N)` column found in the database. */
export interface VectorColumn {
  table: string;
  column: string;
  /** `null` when the column is an unconstrained `vector` (no dimension). */
  dimensions: number | null;
}

export interface VectorDimensionInput {
  /** Is the pgvector extension installed in this database? */
  pgvector: boolean;
  /** Every `vector(N)` column of the current schema. */
  columns: VectorColumn[];
  /** `EMBEDDING_DIMENSIONS`. */
  configuredDimensions: number;
  /** `DB_AUTO_MIGRATE`. */
  autoMigrate: boolean;
}

export type VectorDimensionAction = "no_pgvector" | "ok" | "redimension" | "refuse";

export interface VectorDimensionDecision {
  action: VectorDimensionAction;
  /** Can embeddings be written / queried as configured? */
  usable: boolean;
  /** Human-readable detail for `/health`, `/ready` and the boot log. */
  detail: string;
  /** Dimension of `email_index.embedding` (or of the first mismatching column). */
  columnDimensions?: number;
  /** Columns whose dimension disagrees with the configuration. */
  mismatched: VectorColumn[];
}

/** The exact operator-facing message for a dimension mismatch. */
export const mismatchMessage = (columnDimensions: number, configuredDimensions: number): string =>
  `vector dimension mismatch: column ${columnDimensions}, config ${configuredDimensions} — run the migration job or set EMBEDDING_DIMENSIONS=${columnDimensions}`;

/** The primary embedding column — the one that decides whether vectors work at all. */
export const EMBEDDING_COLUMN = { table: "email_index", column: "embedding" } as const;

const isPrimary = (c: VectorColumn) => c.table === EMBEDDING_COLUMN.table && c.column === EMBEDDING_COLUMN.column;

/**
 * Decide what to do about the stored vector dimensions. Pure: no I/O, no throw.
 *
 * `vector` columns without an explicit dimension are accepted as-is: pgvector
 * validates nothing on them, so they can hold whatever the model produces.
 */
export function decideVectorDimensions(input: VectorDimensionInput): VectorDimensionDecision {
  const { pgvector, columns, configuredDimensions, autoMigrate } = input;
  if (!pgvector) {
    return { action: "no_pgvector", usable: false, detail: "pgvector extension not installed — lexical search only (embeddings disabled)", mismatched: [] };
  }
  const primary = columns.find(isPrimary);
  if (!primary) {
    return { action: "no_pgvector", usable: false, detail: "pgvector installed but email_index.embedding is missing — lexical search only", mismatched: [] };
  }
  const mismatched = columns.filter((c) => c.dimensions !== null && c.dimensions !== configuredDimensions);
  if (!mismatched.length) {
    return { action: "ok", usable: true, detail: `vector(${primary.dimensions ?? "unconstrained"}) matches EMBEDDING_DIMENSIONS=${configuredDimensions}`, columnDimensions: primary.dimensions ?? undefined, mismatched: [] };
  }
  // Report the primary column when it is part of the problem: it is the number
  // the operator sees in the pgvector error message.
  const reported = (mismatched.find(isPrimary) ?? mismatched[0])!.dimensions!;
  if (autoMigrate) {
    return {
      action: "redimension",
      usable: true,
      detail: `re-dimensioning ${mismatched.map((c) => `${c.table}.${c.column} vector(${c.dimensions})`).join(", ")} to vector(${configuredDimensions}); stored embeddings are discarded and will be recomputed at the next indexing (pnpm smoke --full --reindex)`,
      columnDimensions: reported,
      mismatched,
    };
  }
  return { action: "refuse", usable: false, detail: mismatchMessage(reported, configuredDimensions), columnDimensions: reported, mismatched };
}

/* -------------------------------------------------------------------------- */
/*  Database reads                                                            */
/* -------------------------------------------------------------------------- */

const DIMENSION_RE = /^vector\((\d+)\)$/;

/**
 * Every `vector` column of the current schema, with its declared dimension read
 * from the catalog (`pg_attribute` + `format_type`) rather than guessed from the
 * configuration.
 */
export async function readVectorColumns(pool: PgPool): Promise<{ pgvector: boolean; columns: VectorColumn[] }> {
  const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
  if (!ext.rowCount) return { pgvector: false, columns: [] };
  const { rows } = await pool.query<{ table_name: string; column_name: string; type_name: string }>(
    `SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE t.typname = 'vector'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p')
        AND n.nspname = ANY (current_schemas(false))
      ORDER BY c.relname, a.attname`,
  );
  return {
    pgvector: true,
    columns: rows.map((r) => {
      const m = DIMENSION_RE.exec(r.type_name);
      return { table: r.table_name, column: r.column_name, dimensions: m ? Number(m[1]) : null };
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Boot / migration guard                                                    */
/* -------------------------------------------------------------------------- */

/** Runtime state of the vector store, surfaced by `/ready`, `/health` and `/config/features`. */
export interface VectorStoreState {
  /** pgvector extension present **and** the embedding column exists. */
  pgvector: boolean;
  /** Vectors can be written and queried with the configured dimension. */
  usable: boolean;
  configuredDimensions: number;
  columnDimensions?: number;
  /** Set (and only set) when the column disagrees with the config and nothing was changed. */
  mismatch?: string;
  /** True when this boot re-dimensioned the column (embeddings were discarded). */
  redimensioned?: boolean;
  detail: string;
  action: VectorDimensionAction;
}

export interface VectorGuardOptions {
  configuredDimensions: number;
  /** `DB_AUTO_MIGRATE`: true re-dimensions, false refuses and reports. */
  autoMigrate: boolean;
  /** Current embedding model — `embedding_cache` rows of any other model are invalidated. */
  embeddingModel?: string;
  logger?: { info: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void; error?: (obj: unknown, msg?: string) => void };
  /** Skip the advisory lock (single-process tooling / tests). */
  skipLock?: boolean;
  /** Skip the post-change concurrent index rebuild. */
  skipVectorIndex?: boolean;
}

/** State used when there is nothing to check (memory repositories, or the probe failed). */
export const unknownVectorStore = (configuredDimensions: number, detail: string): VectorStoreState => ({ pgvector: false, usable: false, configuredDimensions, detail, action: "no_pgvector" });

/**
 * Compare the stored vector dimensions with `EMBEDDING_DIMENSIONS` and, when
 * `autoMigrate` is set, re-dimension the columns.
 *
 * Idempotent: a second run finds everything in order and does nothing. Safe to
 * run from several replicas at once — the whole change is serialised by the
 * migration advisory lock and the columns are re-read *inside* the lock, so the
 * replicas that were waiting simply find the work already done.
 *
 * Never throws: a probe failure is reported as "unknown" rather than crashing a
 * boot, because lexical search keeps working either way.
 */
export async function ensureVectorDimensions(pool: PgPool, opts: VectorGuardOptions): Promise<VectorStoreState> {
  const log = opts.logger ?? { info: () => undefined };
  let first: { pgvector: boolean; columns: VectorColumn[] };
  try {
    first = await readVectorColumns(pool);
  } catch (e) {
    const detail = `could not read the vector column dimensions: ${(e as Error).message}`;
    log.warn?.({ err: (e as Error).message }, "vector dimension guard skipped");
    return unknownVectorStore(opts.configuredDimensions, detail);
  }

  const decision = decideVectorDimensions({ pgvector: first.pgvector, columns: first.columns, configuredDimensions: opts.configuredDimensions, autoMigrate: opts.autoMigrate });

  if (decision.action === "no_pgvector") {
    log.info({ detail: decision.detail }, "vector store unavailable");
    return { pgvector: false, usable: false, configuredDimensions: opts.configuredDimensions, detail: decision.detail, action: decision.action };
  }
  if (decision.action === "ok") {
    return { pgvector: true, usable: true, configuredDimensions: opts.configuredDimensions, columnDimensions: decision.columnDimensions, detail: decision.detail, action: "ok" };
  }
  if (decision.action === "refuse") {
    // Production: never rewrite a column behind the operator's back.
    log.error?.({ columnDimensions: decision.columnDimensions, configuredDimensions: opts.configuredDimensions, autoMigrate: false }, decision.detail);
    return { pgvector: true, usable: false, configuredDimensions: opts.configuredDimensions, columnDimensions: decision.columnDimensions, mismatch: decision.detail, detail: decision.detail, action: "refuse" };
  }

  /* ------------------------- action: redimension ------------------------- */
  log.warn?.({ columnDimensions: decision.columnDimensions, configuredDimensions: opts.configuredDimensions }, `vector dimension mismatch: ${decision.detail}`);
  const lock = opts.skipLock ? undefined : await pool.connect();
  try {
    if (lock) {
      await lock.query("SET statement_timeout = 0");
      await lock.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCKS.migrations]);
    }
    // Re-read under the lock: another replica may already have done the work.
    const current = await readVectorColumns(pool);
    const now = decideVectorDimensions({ pgvector: current.pgvector, columns: current.columns, configuredDimensions: opts.configuredDimensions, autoMigrate: true });
    if (now.action !== "redimension") {
      log.info({ action: now.action }, "vector dimensions already re-dimensioned by another process");
      return { pgvector: now.action === "ok", usable: now.action === "ok", configuredDimensions: opts.configuredDimensions, columnDimensions: now.columnDimensions, detail: now.detail, action: now.action };
    }

    const client = await pool.connect();
    let cacheDeleted = 0;
    try {
      await client.query("SET statement_timeout = 0");
      await client.query("BEGIN");
      // The HNSW index is bound to the column type, so it has to go first. It is
      // rebuilt (concurrently, outside the transaction) once the type is changed.
      await client.query(`DROP INDEX IF EXISTS email_index_embedding_idx`);
      for (const col of now.mismatched) {
        // USING NULL: the stored vectors were produced by a model with another
        // output size, so they are meaningless under the new configuration.
        // There is no conversion that would keep them correct.
        await client.query(`ALTER TABLE ${quoteIdent(col.table)} ALTER COLUMN ${quoteIdent(col.column)} TYPE vector(${Number(opts.configuredDimensions)}) USING NULL`);
      }
      cacheDeleted = await invalidateEmbeddingCache(client, opts.configuredDimensions, opts.embeddingModel);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      const detail = `${mismatchMessage(decision.columnDimensions!, opts.configuredDimensions)} (automatic re-dimensioning failed: ${(e as Error).message})`;
      log.error?.({ err: (e as Error).message }, "automatic re-dimensioning of the vector column failed");
      return { pgvector: true, usable: false, configuredDimensions: opts.configuredDimensions, columnDimensions: decision.columnDimensions, mismatch: detail, detail, action: "refuse" };
    } finally {
      client.release(true);
    }

    if (!opts.skipVectorIndex) await ensureVectorIndex(pool, log);
    const detail = `email_index.embedding re-dimensioned from vector(${decision.columnDimensions}) to vector(${opts.configuredDimensions})`;
    log.warn?.(
      { from: decision.columnDimensions, to: opts.configuredDimensions, embeddingCacheRowsDeleted: cacheDeleted },
      `${detail}: the stored embeddings were DISCARDED and will be recomputed at the next indexing (re-index the mailbox, e.g. "pnpm smoke --full --reindex")`,
    );
    return { pgvector: true, usable: true, configuredDimensions: opts.configuredDimensions, columnDimensions: opts.configuredDimensions, redimensioned: true, detail, action: "redimension" };
  } finally {
    if (lock) {
      await lock.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCKS.migrations]).catch(() => undefined);
      lock.release(true);
    }
  }
}

/**
 * Drop the `embedding_cache` rows that no longer match the current model or
 * dimension. The cache stores `real[]` (no declared dimension, so it never
 * *fails*), which is precisely why it has to be invalidated explicitly: a stale
 * 1024-value vector would otherwise be served for a `vector(1536)` column and
 * fail on insert forever.
 */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

async function invalidateEmbeddingCache(client: Queryable, dimensions: number, model?: string): Promise<number> {
  const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'embedding_cache' AND table_schema = ANY (current_schemas(false))`);
  if (!exists.rowCount) return 0;
  const r = model
    ? await client.query(`DELETE FROM embedding_cache WHERE dims IS DISTINCT FROM $1 OR model <> $2`, [dimensions, model])
    : await client.query(`DELETE FROM embedding_cache WHERE dims IS DISTINCT FROM $1`, [dimensions]);
  return r.rowCount ?? 0;
}

/** Quote an identifier read from `pg_class` / `pg_attribute` before interpolating it. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
