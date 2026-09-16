import "../../env-file.js";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ADVISORY_LOCKS, type PgPool } from "./pool.js";
import { ensureVectorIndex } from "./vector-index.js";

// Re-exported for callers that historically imported it from here.
export { ensureVectorIndex };

/**
 * Plain-SQL migration runner: applies `migrations/*.sql` in lexical order,
 * each file inside its own transaction, and records it in `schema_migrations`.
 *
 * Production notes
 *  - The whole run is serialised by a Postgres **advisory lock**, so N replicas
 *    of the same image starting together do not migrate concurrently: the first
 *    one migrates, the others wait and then find everything applied.
 *  - `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so the pgvector
 *    HNSW index is built by `ensureVectorIndex()` *after* the transactional
 *    migrations, outside any transaction, and never fails the boot.
 */
export interface MigrateOptions {
  embeddingDimensions: number;
  migrationsDir?: string;
  logger?: { info: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
  /** Skip the advisory lock (single-process tooling / tests). */
  skipLock?: boolean;
  /** Skip the post-migration concurrent index build. */
  skipVectorIndex?: boolean;
}

export const defaultMigrationsDir = (): string => fileURLToPath(new URL("../../../migrations/", import.meta.url));

export async function runMigrations(pool: PgPool, opts: MigrateOptions): Promise<string[]> {
  const dir = opts.migrationsDir ?? defaultMigrationsDir();
  const log = opts.logger ?? { info: () => undefined };

  const lock = opts.skipLock ? undefined : await pool.connect();
  try {
    if (lock) {
      // `pg_advisory_lock` blocks until the lock is free. The pool sets
      // `statement_timeout` (15 s by default) on every connection, so with
      // several replicas booting together the ones that wait would be cancelled
      // mid-wait and crash-loop while the first replica is still migrating.
      // The wait is deliberately unbounded here; it ends when the leader commits.
      await lock.query("SET statement_timeout = 0");
      await lock.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCKS.migrations]);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await pool.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const done: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Settings consumed by the SQL (see the DO block in 0001_init.sql). set_config avoids quoting issues.
        await client.query(`SELECT set_config('oao.embedding_dimensions', $1, true)`, [String(opts.embeddingDimensions)]);
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        done.push(file);
        log.info({ file }, "migration applied");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      } finally {
        client.release();
      }
    }
    if (!opts.skipVectorIndex) await ensureVectorIndex(pool, log);
    return done;
  } finally {
    if (lock) {
      await lock.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCKS.migrations]).catch(() => undefined);
      // Destroy rather than return to the pool: this connection no longer has
      // the pool's `statement_timeout`, and a runaway query on it would never
      // be cancelled.
      lock.release(true);
    }
  }
}

/** True when every migration file on disk is recorded as applied (readiness probe). */
export async function migrationsUpToDate(pool: PgPool, migrationsDir = defaultMigrationsDir()): Promise<{ ok: boolean; missing: string[] }> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  const missing = files.filter((f) => !applied.has(f));
  return { ok: missing.length === 0, missing };
}

/** CLI entry: `pnpm db:migrate` */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { loadConfig, isMemoryDatabase } = await import("../../config.js");
  const { createPool } = await import("./pool.js");
  const cfg = loadConfig();
  if (isMemoryDatabase(cfg)) {
    console.log("DATABASE_URL=memory: nothing to migrate.");
    process.exit(0);
  }
  const { ensureVectorDimensions } = await import("./vector-dimensions.js");
  const pool = createPool(cfg.DATABASE_URL, { max: 2, statementTimeoutMs: 600_000 });
  const logger = { info: (o: unknown, m?: string) => console.log(m, o), warn: (o: unknown, m?: string) => console.warn(m, o), error: (o: unknown, m?: string) => console.error(m, o) };
  try {
    const done = await runMigrations(pool, { embeddingDimensions: cfg.EMBEDDING_DIMENSIONS, logger });
    console.log(done.length ? `Applied: ${done.join(", ")}` : "Database is up to date.");
    /*
     * The migration job is also the place where a *changed* EMBEDDING_DIMENSIONS
     * is applied: `0001_init.sql` only creates the column, it never resizes it.
     * Running `pnpm db:migrate` is therefore the documented remediation for the
     * `vector dimension mismatch` that `/ready` reports when DB_AUTO_MIGRATE is
     * off, so the guard here always re-dimensions (autoMigrate: true).
     */
    const vectors = await ensureVectorDimensions(pool, {
      configuredDimensions: cfg.EMBEDDING_DIMENSIONS,
      autoMigrate: true,
      embeddingModel: cfg.LLM_PROVIDER === "mock" ? undefined : cfg.EMBEDDING_MODEL,
      logger,
    });
    console.log(`Vector store: ${vectors.detail}`);
    if (vectors.redimensioned) console.warn("WARNING: stored embeddings were discarded — re-index the mailboxes (the add-in re-indexes on use, or run `pnpm smoke --full --reindex`).");
    if (vectors.mismatch) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
