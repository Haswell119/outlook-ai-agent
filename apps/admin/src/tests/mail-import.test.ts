import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxImportRequestSchema } from "@oao/shared";
import { dictionaries, type MessageKey } from "@/lib/i18n";
import {
  IMPORT_BATCH_BYTES,
  IMPORT_BATCH_FILES,
  folderOf,
  isMailFile,
  newImportId,
  planBatches,
  reasonKey,
  retryAfterSeconds,
} from "@/lib/mail-import";

describe("mail import — client planning", () => {
  it("keeps only .eml / .msg files from a folder upload, and their folder", () => {
    expect(["a.eml", "B.MSG", "notes.txt", "desktop.ini", "archive.eml.zip"].filter(isMailFile)).toEqual(["a.eml", "B.MSG"]);
    expect(folderOf("Export/Inbox/Clients/a.eml")).toBe("Export/Inbox/Clients");
    expect(folderOf("a.eml")).toBeUndefined();
    expect(folderOf(undefined)).toBeUndefined();
    expect(folderOf(`${"x/".repeat(200)}a.eml`)!.length).toBe(260);
  });

  it("batches by count and size; one message per request when each one is analysed", () => {
    const files = (n: number, size = 1000) => Array.from({ length: n }, (_, i) => ({ name: `${i}.eml`, size }));
    expect(planBatches(files(25), { analyze: false }).map((b) => b.length)).toEqual([IMPORT_BATCH_FILES, IMPORT_BATCH_FILES, 5]);
    expect(planBatches(files(3), { analyze: true }).map((b) => b.length)).toEqual([1, 1, 1]);
    const big = { name: "big.msg", size: IMPORT_BATCH_BYTES + 1 };
    const half = { name: "half.eml", size: IMPORT_BATCH_BYTES / 2 };
    expect(planBatches([half, big, half, half, half], { analyze: false }).map((b) => b.map((f) => f.name))).toEqual([
      ["half.eml"],
      ["big.msg"],
      ["half.eml", "half.eml"],
      ["half.eml"],
    ]);
    expect(planBatches([], { analyze: false })).toEqual([]);
  });

  it("the orchestrator's reasons are shown in the dashboard's language; unknown ones as they are", () => {
    const reasons = [
      "empty file",
      "larger than 25 MB",
      "not an .eml or .msg message",
      "not a readable Outlook message (Unsupported file type!)",
      "not a readable email (unexpected end)",
      "no subject and no text: nothing to index",
      "the file could not be read",
      "imported, but the analysis failed (it will run when the message is opened)",
    ];
    for (const reason of reasons) {
      const key = reasonKey(reason) as MessageKey | undefined;
      expect(key, reason).toBeDefined();
      expect(dictionaries.fr[key!], reason).toBeTruthy();
      expect(dictionaries.en[key!], reason).toBeTruthy();
    }
    expect(reasonKey("something new")).toBeUndefined();
  });

  it("import ids satisfy the contract; Retry-After is bounded", () => {
    const id = newImportId();
    expect(MailboxImportRequestSchema.shape.importId.safeParse(id).success).toBe(true);
    expect(newImportId()).not.toBe(id);
    expect(retryAfterSeconds("7")).toBe(7);
    expect(retryAfterSeconds("600")).toBe(60);
    expect(retryAfterSeconds(null)).toBe(10);
    expect(retryAfterSeconds("soon")).toBe(10);
  });
});

/* ------------------------------------------------------------------------- */

const importMailFiles = vi.fn();
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

vi.mock("@/lib/api", () => ({ importMailFiles, OrchestratorError, newCorrelationId: () => "adm-test-correlation" }));
vi.mock("@/lib/session", () => ({ requireRoles, ForbiddenError, UnauthorizedError }));

const body = {
  importId: "imp_0123456789abcdef",
  mailbox: "Defi-IA@Outlook.com",
  analyze: false,
  files: [{ name: "a.eml", contentBase64: Buffer.from("From: a@b.example\r\n\r\nhi").toString("base64") }],
};
const post = (payload: unknown, contentType = "application/json") =>
  new Request("http://admin.local/api/import", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

describe("POST /api/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRoles.mockResolvedValue({ email: "admin@northbridge.example", roles: ["admin"] });
  });

  it("validates with the shared contract and forwards to the orchestrator", async () => {
    const { POST } = await import("@/app/api/import/route");
    importMailFiles.mockResolvedValue({ importId: body.importId, counts: { imported: 1 } });
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(requireRoles).toHaveBeenCalledWith("admin");
    // Normalised by the contract before it leaves the dashboard.
    expect(importMailFiles).toHaveBeenCalledWith(expect.objectContaining({ mailbox: "defi-ia@outlook.com", analyze: false }));
    expect(await res.json()).toMatchObject({ counts: { imported: 1 } });
  });

  it("refuses non-JSON bodies (cross-site form posts) and invalid payloads, without echoing content", async () => {
    const { POST } = await import("@/app/api/import/route");
    const form = await POST(post(JSON.stringify(body), "text/plain"));
    expect(form.status).toBe(415);
    const invalid = await POST(post({ ...body, importId: "x", files: [{ name: "a.eml", contentBase64: "" }] }));
    expect(invalid.status).toBe(400);
    const json = await invalid.json();
    expect(json.error.details.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["importId", "files.0.contentBase64"]));
    expect(importMailFiles).not.toHaveBeenCalled();
  });

  it("admin only; orchestrator errors keep their status and code", async () => {
    const { POST } = await import("@/app/api/import/route");
    requireRoles.mockRejectedValueOnce(new ForbiddenError("requires one of: admin"));
    expect((await POST(post(body))).status).toBe(403);
    importMailFiles.mockRejectedValueOnce(new OrchestratorError("The import needs a reachable orchestrator", 503, "demo_mode"));
    const demo = await POST(post(body));
    expect(demo.status).toBe(503);
    expect((await demo.json()).error.code).toBe("demo_mode");
  });
});
