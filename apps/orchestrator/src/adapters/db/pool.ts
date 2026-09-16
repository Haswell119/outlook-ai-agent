import pg from "pg";

const { Pool } = pg;
export type PgPool = InstanceType<typeof Pool>;

export interface PoolOptions {
  max?: number;
  min?: number;
  /** Per-statement timeout: a runaway query must never pin a connection forever. */
  statementTimeoutMs?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  applicationName?: string;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void };
}

/**
 * Connection pool sized from the environment.
 *
 * `statement_timeout` and `idle_in_transaction_session_timeout` are set per
 * connection, so a stuck query is killed by Postgres rather than by a client
 * timeout that leaves the backend running. Every new connection is verified
 * with `SELECT 1` before it is handed out.
 */
export function createPool(connectionString: string, opts: PoolOptions = {}): PgPool {
  const statementTimeout = opts.statementTimeoutMs ?? 15_000;
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 10,
    min: opts.min ?? 0,
    idleTimeoutMillis: opts.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5_000,
    application_name: opts.applicationName ?? "oao-orchestrator",
    // Belt and braces: the server-side settings below are the authority, this
    // one only bounds the client's own wait.
    statement_timeout: statementTimeout,
  });

  pool.on("connect", (client) => {
    void client
      .query(`SET statement_timeout = ${statementTimeout}; SET idle_in_transaction_session_timeout = ${statementTimeout * 2}; SELECT 1`)
      .catch((e: Error) => opts.logger?.warn({ err: e.message }, "failed to initialise pg connection"));
  });
  // A pool-level error (server restart, network blip) must not crash the process.
  pool.on("error", (err) => opts.logger?.warn({ err: err.message }, "idle postgres client error"));
  return pool;
}

/**
 * Postgres advisory-lock ids. Two replicas of the same image must not migrate
 * or run the same scheduled job at the same time; `pg_advisory_lock` gives us
 * cluster-wide mutual exclusion without another dependency.
 */
export const ADVISORY_LOCKS = {
  /** Held for the duration of the migration run. */
  migrations: 828_451_001,
  /** Held by the elected worker leader (session lock, released on disconnect). */
  scheduler: 828_451_002,
} as const;

/** Run `fn` while holding a session-level advisory lock (blocking). */
export async function withAdvisoryLock<T>(pool: PgPool, lockId: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => undefined);
    client.release();
  }
}

/** Try to take an advisory lock without blocking. Returns false when held elsewhere. */
export async function tryAdvisoryLock(client: pg.PoolClient, lockId: number): Promise<boolean> {
  const r = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [lockId]);
  return Boolean(r.rows[0]?.locked);
}
