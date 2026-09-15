/**
 * Application error mapped to the `ApiError` contract by the HTTP error handler.
 * Codes: validation_error (400) · unauthorized (401) · forbidden (403) · not_found (404)
 *        conflict (409) · llm_unavailable (502) · graph_unavailable (503) · internal_error (500)
 */
export type ApiErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "llm_unavailable"
  | "graph_unavailable"
  | "internal_error";

const STATUS: Record<ApiErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  llm_unavailable: 502,
  graph_unavailable: 503,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }

  static validation(message: string, details?: unknown) {
    return new AppError("validation_error", message, details);
  }
  static unauthorized(message = "Authentication required") {
    return new AppError("unauthorized", message);
  }
  static forbidden(message = "Insufficient permissions") {
    return new AppError("forbidden", message);
  }
  static notFound(what = "Resource") {
    return new AppError("not_found", `${what} not found`);
  }
  static conflict(message: string) {
    return new AppError("conflict", message);
  }
  static llmUnavailable(message = "The AI model is unavailable", details?: unknown) {
    return new AppError("llm_unavailable", message, details);
  }
  static graphUnavailable(message = "Microsoft Graph is unavailable") {
    return new AppError("graph_unavailable", message);
  }
}

/** Raised by the LLM adapters when the model cannot be reached or returns garbage. */
export class LlmError extends Error {
  readonly kind: "network" | "timeout" | "http" | "output";
  readonly status?: number;
  constructor(kind: LlmError["kind"], message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}

/** Raised by the Graph adapter when GRAPH_ENABLED=false (services fall back to client execution). */
export class GraphDisabledError extends Error {
  constructor(message = "Microsoft Graph integration is disabled (GRAPH_ENABLED=false)") {
    super(message);
    this.name = "GraphDisabledError";
  }
}
