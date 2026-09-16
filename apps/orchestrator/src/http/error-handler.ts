import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { isDatabaseError } from "../adapters/db/errors.js";
import { AppError, GraphDisabledError, LlmError } from "../errors.js";

/** Maps every error to the `ApiError` contract. */
export function errorHandler(error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const correlationId = req.id;
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details, correlationId } });
  }
  if (error instanceof ZodError) {
    return reply.status(400).send({ error: { code: "validation_error", message: "Request validation failed", details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), correlationId } });
  }
  if (error instanceof LlmError) {
    // `error.message` embeds the upstream response body and the internal
    // endpoint the request was made to. That belongs in the log, not in a
    // response the add-in (or anyone who can reach the API) receives.
    req.log.warn({ err: error.message, kind: error.kind, status: error.status }, "llm call failed");
    return reply.status(502).send({ error: { code: "llm_unavailable", message: "The AI model is unavailable", details: { kind: error.kind }, correlationId } });
  }
  if (error instanceof GraphDisabledError) {
    return reply.status(503).send({ error: { code: "graph_unavailable", message: error.message, correlationId } });
  }
  if (isDatabaseError(error)) {
    // The driver message can quote SQL, column names and row values (pgvector's
    // "expected 1024 dimensions, not 1536" is the mild case) — it belongs in the
    // log next to the correlation id, not in the response body. The client gets
    // a stable `database_error` code it can act on instead of a generic
    // "unhandled error".
    req.log.error({ err: error, code: (error as { code?: string }).code, detail: (error as { detail?: string }).detail, table: (error as { table?: string }).table, constraint: (error as { constraint?: string }).constraint }, "database error");
    return reply.status(500).send({ error: { code: "database_error", message: "A database error occurred while processing the request", details: { sqlState: (error as { code?: string }).code }, correlationId } });
  }
  const fe = error as FastifyError;
  if (fe.statusCode === 429) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests", correlationId } });
  if (fe.statusCode === 413) return reply.status(413).send({ error: { code: "validation_error", message: "Request body too large (max 2 MB)", correlationId } });
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ error: { code: fe.statusCode === 404 ? "not_found" : "validation_error", message: fe.message, correlationId } });
  }
  req.log.error({ err: error }, "unhandled error");
  return reply.status(500).send({ error: { code: "internal_error", message: "Internal server error", correlationId } });
}
