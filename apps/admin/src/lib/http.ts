/**
 * Shared plumbing for the route handlers under `src/app/api/*`.
 *
 * Every handler re-checks the role (`requireRoles`) even though the middleware
 * already did: a route handler is reachable by anything that can send an HTTP
 * request, and defence in depth is a requirement of `docs/SECURITY.md` §5.
 */
import { NextResponse } from "next/server";
import { OrchestratorError, newCorrelationId } from "./api";
import { ForbiddenError, UnauthorizedError } from "./session";

export interface ErrorPayload {
  error: { code: string; message: string; correlationId?: string; details?: unknown };
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  correlationId?: string,
  details?: unknown,
): NextResponse<ErrorPayload> {
  const payload: ErrorPayload = {
    error: { code, message, correlationId: correlationId ?? newCorrelationId() },
  };
  if (details !== undefined) payload.error.details = details;
  return NextResponse.json(payload, {
    status,
    headers: { "x-correlation-id": payload.error.correlationId ?? "" },
  });
}

/** Maps any thrown error to the `ApiError` shape of the contract. */
export function handleRouteError(error: unknown, fallbackCode: string): NextResponse<ErrorPayload> {
  if (error instanceof UnauthorizedError) {
    return errorResponse("unauthorized", "Sign-in required", 401);
  }
  if (error instanceof ForbiddenError) {
    return errorResponse("forbidden", error.message, 403);
  }
  if (error instanceof OrchestratorError) {
    return errorResponse(
      error.code ?? fallbackCode,
      error.message,
      error.status >= 400 && error.status <= 599 ? error.status : 502,
      error.correlationId,
    );
  }
  return errorResponse(
    fallbackCode,
    error instanceof Error ? error.message : "Unexpected error",
    502,
  );
}
