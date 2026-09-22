import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgRepositories } from "../../src/adapters/db/index.js";
import { runMigrations } from "../../src/adapters/db/migrate.js";
import { createPool, type PgPool } from "../../src/adapters/db/pool.js";
import { ensureVectorDimensions, readVectorColumns } from "../../src/adapters/db/vector-dimensions.js";

/**
 * Integration test for the vector dimension guard, against a real PostgreSQL.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a **disposable** database — it
 * runs the migrations and rewrites `email_index.embedding`:
 *
 *   docker run -d --name oao-pgtest -p 5433:5432 \
 *     -e POSTGRES_USER=oao -e POSTGRES_PASSWORD=oao -e POSTGRES_DB=oao_test pgvector/pgvector:pg16
 *   TEST_DATABASE_URL=postgres://oao:oao@localhost:5433/oao_test \
 *     npm run test -w @oao/orchestrator
 *
 * Without pgvector in the image every case below still runs: the guard reports
 * lexical-only instead of re-dimensioning.
 */
const url = process.env.TEST_DATABASE_URL;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe.skipIf(!url)("vector dimension guard on a real database", () => {
  let pool: PgPool;
  let pgvector = false;

  beforeAll(async () => {
    pool = createPool(url!, { max: 2, statementTimeoutMs: 120_000 });
    await runMigrations(pool, { embeddingDimensions: 1024, logger: silent });
    pgvector = (await readVectorColumns(pool)).pgvector;
    // Repeatable start state: the migrations only *create* the column, so on a
    // database left behind by a previous run it may already be 1536. Use the
    // guard itself to put it back to 1024 — which is also a first idempotency
    // check of the re-dimensioning path.
    if (pgvector) await ensureVectorDimensions(pool, { configuredDimensions: 1024, autoMigrate: true, logger: silent });
    await pool.query(`DELETE FROM email_index WHERE user_id = 'guard-test-user'`);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("reads the declared dimension from the catalog", async () => {
    const { columns } = await readVectorColumns(pool);
    if (!pgvector) return expect(columns).toEqual([]);
    expect(columns.find((c) => c.table === "email_index" && c.column === "embedding")?.dimensions).toBe(1024);
  });

  it("re-dimensions with DB_AUTO_MIGRATE=true, discards the vectors, and is idempotent", async () => {
    if (!pgvector) {
      const state = await ensureVectorDimensions(pool, { configuredDimensions: 1536, autoMigrate: true, logger: silent });
      expect(state).toMatchObject({ pgvector: false, usable: false });
      return;
    }
    const repos = createPgRepositories(pool, { embeddingDimensions: 1024 });
    await repos.emailIndex.upsertEmail("guard-test-user", [
      { userId: "guard-test-user", emailId: "guard-1", subject: "Atlas budget", bodyText: "Confirm the revised budget.", chunkNo: 0, hasAttachments: false, attachmentNames: [], embedding: Array.from({ length: 1024 }, () => 0.01) },
    ]);
    const before = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM email_index WHERE embedding IS NOT NULL`);
    expect(Number(before.rows[0]!.n)).toBeGreaterThan(0);

    const state = await ensureVectorDimensions(pool, { configuredDimensions: 1536, autoMigrate: true, embeddingModel: "text-embedding-3-small", logger: silent });
    expect(state).toMatchObject({ usable: true, redimensioned: true, columnDimensions: 1536 });
    expect((await readVectorColumns(pool)).columns.find((c) => c.column === "embedding")?.dimensions).toBe(1536);
    // The rows survive (lexical search keeps working), the vectors do not.
    const after = await pool.query<{ rows: string; vectors: string }>(`SELECT count(*)::text AS rows, count(embedding)::text AS vectors FROM email_index`);
    expect(Number(after.rows[0]!.rows)).toBeGreaterThan(0);
    expect(Number(after.rows[0]!.vectors)).toBe(0);
    // The HNSW index is back.
    expect((await pool.query(`SELECT 1 FROM pg_class WHERE relname = 'email_index_embedding_idx'`)).rowCount).toBe(1);

    // Second run: nothing to do.
    const again = await ensureVectorDimensions(pool, { configuredDimensions: 1536, autoMigrate: true, logger: silent });
    expect(again).toMatchObject({ action: "ok", usable: true, columnDimensions: 1536 });
    expect(again.redimensioned).toBeUndefined();

    await pool.query(`DELETE FROM email_index WHERE user_id = 'guard-test-user'`);
  }, 120_000);

  it("refuses with DB_AUTO_MIGRATE=false and leaves the column untouched", async () => {
    const state = await ensureVectorDimensions(pool, { configuredDimensions: 999, autoMigrate: false, logger: silent });
    if (!pgvector) return expect(state.usable).toBe(false);
    expect(state.action).toBe("refuse");
    expect(state.mismatch).toBe("vector dimension mismatch: column 1536, config 999 — run the migration job or set EMBEDDING_DIMENSIONS=1536");
    expect((await readVectorColumns(pool)).columns.find((c) => c.column === "embedding")?.dimensions).toBe(1536);
  });

  it("refuses to write a vector of the wrong size, and the write without one succeeds", async () => {
    if (!pgvector) return;
    const repos = createPgRepositories(pool, { embeddingDimensions: 1024 }); // column is 1536 now
    expect(await repos.emailIndex.supportsVectors()).toBe(false);
    await repos.emailIndex.upsertEmail("guard-test-user", [
      { userId: "guard-test-user", emailId: "guard-2", subject: "Atlas", bodyText: "Body", chunkNo: 0, hasAttachments: false, attachmentNames: [], embedding: Array.from({ length: 1024 }, () => 0.01) },
    ]);
    const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM email_index WHERE email_id = 'guard-2' AND embedding IS NULL`);
    expect(Number(r.rows[0]!.n)).toBe(1);
    await pool.query(`DELETE FROM email_index WHERE user_id = 'guard-test-user'`);
  }, 60_000);
});
