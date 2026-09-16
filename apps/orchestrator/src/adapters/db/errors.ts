/**
 * Postgres error classification.
 *
 * `pg` throws `DatabaseError` (a plain `Error` subclass carrying the SQLSTATE in
 * `code`). Two things are done with it here:
 *
 *  - the HTTP error handler maps it to a proper `ApiError` (`database_error`)
 *    instead of the generic "unhandled error";
 *  - the indexing path recognises the *vector* failures it can recover from by
 *    storing the chunk without its embedding.
 *
 * `instanceof` is deliberately not the only test: an error can cross a driver
 * boundary (a wrapped pool error, a different `pg` copy hoisted by the package
 * manager) and still be a Postgres error. The shape — a 5-character SQLSTATE in
 * `code` plus a `severity` or a `routine` — is what identifies it reliably.
 */

/** Minimal view of a Postgres error, whatever copy of `pg` produced it. */
export interface PgErrorLike extends Error {
  /** SQLSTATE, e.g. `22000` (data_exception) or `42P01` (undefined_table). */
  code?: string;
  severity?: string;
  routine?: string;
  detail?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** True for an error raised by the Postgres driver (SQLSTATE present). */
export function isDatabaseError(e: unknown): e is PgErrorLike {
  if (!(e instanceof Error)) return false;
  const c = e as PgErrorLike;
  if (typeof c.code === "string" && SQLSTATE_RE.test(c.code) && (typeof c.severity === "string" || typeof c.routine === "string")) return true;
  // Connection-level failures (`ECONNREFUSED`, `ENOTFOUND`, pool timeouts) carry
  // no SQLSTATE; they are still database errors as far as a client is concerned.
  return e.name === "DatabaseError" || /^(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EPIPE)$/.test(String(c.code ?? "")) || /timeout exceeded when trying to connect|Connection terminated/i.test(e.message);
}

/**
 * True when the failure is about the pgvector column, i.e. something the caller
 * can retry **without** the embedding.
 *
 * The canonical case is the dimension mismatch, raised by pgvector as
 * `data_exception` (22000): `expected 1024 dimensions, not 1536`. Also covered:
 * an invalid vector literal (22P02), a type mismatch after a manual schema
 * change (42804), and a dropped extension/column (42883 / 42703 / 42704).
 */
export function isVectorWriteError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as PgErrorLike).code;
  if (/dimension/i.test(e.message)) return true;
  if (/\bvector\b/i.test(e.message) && /type|operator|function|does not exist/i.test(e.message)) return true;
  return code === "22000" || code === "22P02" || code === "42804" || code === "42883" || code === "42703" || code === "42704";
}
