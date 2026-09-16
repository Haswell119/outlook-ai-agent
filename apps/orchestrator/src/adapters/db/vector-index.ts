import type { PgPool } from "./pool.js";

/**
 * Build the HNSW index on `email_index.embedding` without locking writes.
 *
 * `CREATE INDEX CONCURRENTLY` must run outside a transaction, so it lives here
 * rather than in a migration file. It is idempotent (`IF NOT EXISTS`) and never
 * fatal: without the index, vector search degrades to a sequential scan, which
 * is perfectly fine for ~50 mailboxes. A concurrent build that is interrupted
 * leaves an INVALID index, which we detect and drop before retrying.
 */
export async function ensureVectorIndex(pool: PgPool, logger?: { info: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void }): Promise<"created" | "present" | "skipped"> {
  const log = logger ?? { info: () => undefined };
  try {
    const hasVector = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    if (!hasVector.rowCount) return "skipped";
    const hasColumn = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'email_index' AND column_name = 'embedding'`);
    if (!hasColumn.rowCount) return "skipped";

    const invalid = await pool.query(
      `SELECT c.relname FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'email_index_embedding_idx' AND NOT i.indisvalid`,
    );
    if (invalid.rowCount) {
      log.warn?.({}, "dropping an invalid email_index_embedding_idx left by an interrupted concurrent build");
      await pool.query(`DROP INDEX IF EXISTS email_index_embedding_idx`);
    }

    const exists = await pool.query(`SELECT 1 FROM pg_class WHERE relname = 'email_index_embedding_idx'`);
    if (exists.rowCount) return "present";

    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS email_index_embedding_idx ON email_index USING hnsw (embedding vector_cosine_ops)`);
    log.info({}, "pgvector HNSW index created concurrently");
    return "created";
  } catch (e) {
    log.warn?.({ err: (e as Error).message }, "vector index not created — vector search will use a sequential scan");
    return "skipped";
  }
}
