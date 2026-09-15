import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PgPool } from "./pool.js";

/**
 * Plain-SQL migration runner: applies `migrations/*.sql` in lexical order,
 * each file inside its own transaction, and records it in `schema_migrations`.
 */
export interface MigrateOptions {
  embeddingDimensions: number;
  migrationsDir?: string;
  logger?: { info: (obj: unknown, msg?: string) => void };
}

export const defaultMigrationsDir = (): string => fileURLToPath(new URL("../../../migrations/", import.meta.url));

export async function runMigrations(pool: PgPool, opts: MigrateOptions): Promise<string[]> {
  const dir = opts.migrationsDir ?? defaultMigrationsDir();
  const log = opts.logger ?? { info: () => undefined };
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
  return done;
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
  const pool = createPool(cfg.DATABASE_URL);
  try {
    const done = await runMigrations(pool, { embeddingDimensions: cfg.EMBEDDING_DIMENSIONS, logger: { info: (o, m) => console.log(m, o) } });
    console.log(done.length ? `Applied: ${done.join(", ")}` : "Database is up to date.");
  } finally {
    await pool.end();
  }
}
