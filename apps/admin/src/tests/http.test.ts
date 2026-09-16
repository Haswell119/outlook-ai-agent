import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  OrchestratorError: class OrchestratorError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
      readonly correlationId?: string,
    ) {
      super(message);
      this.name = "OrchestratorError";
    }
  },
  newCorrelationId: () => "adm-generated",
}));

vi.mock("@/lib/session", () => ({
  ForbiddenError: class ForbiddenError extends Error {
    readonly status = 403;
  },
  UnauthorizedError: class UnauthorizedError extends Error {
    readonly status = 401;
  },
}));

describe("route-handler error mapping", () => {
  it("always carries a correlation id, generated when the backend gave none", async () => {
    const { errorResponse } = await import("@/lib/http");
    const res = errorResponse("validation_error", "bad payload", 400);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { correlationId: string } };
    expect(body.error.correlationId).toBe("adm-generated");
    expect(res.headers.get("x-correlation-id")).toBe("adm-generated");
  });

  it("maps auth failures to 401 / 403 with the contract's ApiError shape", async () => {
    const { handleRouteError } = await import("@/lib/http");
    const { ForbiddenError, UnauthorizedError } = await import("@/lib/session");

    const forbidden = handleRouteError(new ForbiddenError("nope"), "failed");
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("forbidden");

    const unauthorized = handleRouteError(new UnauthorizedError(), "failed");
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error.code).toBe("unauthorized");
  });

  it("propagates the orchestrator's status, code and correlation id", async () => {
    const { handleRouteError } = await import("@/lib/http");
    const { OrchestratorError } = await import("@/lib/api");

    const res = handleRouteError(
      new OrchestratorError("escalation not found", 404, "not_found", "req-7"),
      "decision_failed",
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; correlationId: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.correlationId).toBe("req-7");
  });

  it("falls back to 502 for an unexpected error", async () => {
    const { handleRouteError } = await import("@/lib/http");
    const res = handleRouteError(new Error("boom"), "decision_failed");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "decision_failed", message: "boom" });
  });
});
