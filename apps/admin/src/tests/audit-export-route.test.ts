import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@oao/shared";
import { store } from "@/lib/mock-data";

const streamAuditExport = vi.fn();
const getAuditEventsForExport = vi.fn();
const requireRoles = vi.fn();

class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

class ForbiddenError extends Error {
  readonly status = 403;
}
class UnauthorizedError extends Error {
  readonly status = 401;
}

vi.mock("@/lib/api", () => ({
  streamAuditExport,
  getAuditEventsForExport,
  OrchestratorError,
  newCorrelationId: () => "adm-test-correlation",
}));

vi.mock("@/lib/session", () => ({ requireRoles, ForbiddenError, UnauthorizedError }));

const url = "http://admin.local/api/audit/export?range=last7";

beforeEach(() => {
  vi.clearAllMocks();
  requireRoles.mockResolvedValue({ email: "admin@northbridge.example", roles: ["admin"] });
});

describe("GET /api/audit/export", () => {
  it("names the file after the period and marks it as an attachment", async () => {
    const { GET, exportFilename } = await import("@/app/api/audit/export/route");
    expect(exportFilename("2025-05-12T00:00:00.000Z", "2025-05-18T23:59:59.000Z")).toBe(
      "audit-log-2025-05-12_2025-05-18.csv",
    );

    streamAuditExport.mockResolvedValue(null);
    getAuditEventsForExport.mockResolvedValue(store().events.slice(0, 3) as AuditEvent[]);

    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(
      'attachment; filename="audit-log-2025-05-12_2025-05-18.csv"',
    );
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    // UTF-8 BOM, so Excel opens the accented columns correctly.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const body = await res.text();
    expect(body.split("\r\n")[0]).toContain("correlationId");
    expect(body.split("\r\n")).toHaveLength(4);
  });

  it("streams the orchestrator's own CSV straight through when available", async () => {
    const { GET } = await import("@/app/api/audit/export/route");
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id,timestamp\r\naud-1,2025-05-18"));
        controller.close();
      },
    });
    streamAuditExport.mockResolvedValue({ body: upstream, contentType: "text/csv" });

    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(await res.text()).toBe("id,timestamp\r\naud-1,2025-05-18");
    // Nothing was buffered locally.
    expect(getAuditEventsForExport).not.toHaveBeenCalled();
  });

  it("refuses a role that may not read the audit trail", async () => {
    const { GET } = await import("@/app/api/audit/export/route");
    requireRoles.mockRejectedValue(new ForbiddenError("requires one of: admin, compliance"));

    const res = await GET(new Request(url));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; correlationId?: string } };
    expect(body.error.code).toBe("forbidden");
    expect(streamAuditExport).not.toHaveBeenCalled();
  });

  it("surfaces the orchestrator's correlation id when the export fails", async () => {
    const { GET } = await import("@/app/api/audit/export/route");
    streamAuditExport.mockResolvedValue(null);
    getAuditEventsForExport.mockRejectedValue(
      new OrchestratorError("audit store unavailable", 503, "orchestrator_unavailable", "req-42"),
    );

    const res = await GET(new Request(url));
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string; correlationId?: string };
    };
    expect(body.error.code).toBe("orchestrator_unavailable");
    expect(body.error.message).toBe("audit store unavailable");
    expect(body.error.correlationId).toBe("req-42");
    expect(res.headers.get("x-correlation-id")).toBe("req-42");
  });
});
