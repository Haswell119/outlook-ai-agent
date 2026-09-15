import pg from "pg";

const { Pool } = pg;
export type PgPool = InstanceType<typeof Pool>;

export function createPool(connectionString: string): PgPool {
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}
