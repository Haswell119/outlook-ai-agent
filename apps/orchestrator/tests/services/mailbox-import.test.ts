import { afterEach, describe, expect, it, vi } from "vitest";
import { MAILBOX_IMPORT_MAX_BATCH_BYTES, MailboxImportRequestSchema, MailboxImportResponseSchema, Routes, type MailboxImportRequest } from "@oao/shared";
import { buildApp } from "../../src/app.js";
import { adminTokenIdentity } from "../../src/auth/dev.js";
import { ctx, createTestContainer, sampleEmail, user, type TestContainer } from "../helpers.js";
import { eml, msg } from "../mail-fixtures.js";

const MAILBOX = "defi-ia@outlook.com";
const admin = adminTokenIdentity(["admin@northbridge.example"]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const invoice = () =>
  eml({ messageId: "<invoice@supplier.example>", subject: "Invoice 2026-091 overdue", text: "Hello, invoice 2026-091 is overdue. Please confirm the payment date before Friday.", date: "Tue, 29 Sep 2026 09:00:00 +0200" });
const newsletter = () =>
  eml({ messageId: "<digest@news.example>", from: "Market Watch <news@marketwatch.example>", subject: "Weekly digest", text: "Markets moved.\r\n\r\nUnsubscribe here." });
const outlookMsg = () =>
  msg({ subject: "Mandate KYC pack", body: "Please send the signed KYC pack; the mandate cannot proceed without it.", senderName: "Client", senderSmtp: "ops@client.example", headers: "Message-ID: <kyc@client.example>\r\n", deliveredAt: "2026-09-29T07:30:00Z", to: [{ email: MAILBOX }] });

const request = (files: Array<{ name: string; bytes: Uint8Array; folder?: string }>, over: Partial<MailboxImportRequest> = {}): MailboxImportRequest =>
  MailboxImportRequestSchema.parse({ importId: "imp_test_0001", mailbox: MAILBOX, files: files.map((f) => ({ name: f.name, folder: f.folder, contentBase64: b64(f.bytes) })), ...over });

afterEach(() => vi.restoreAllMocks());

describe("MailboxImportService", () => {
  it("indexes .eml and .msg files like a Graph sync page, per file results, content never audited", async () => {
    const c = await createTestContainer();
    const r = await c.services.mailboxImport.import(
      admin,
      request([
        { name: "invoice.eml", bytes: invoice(), folder: "Inbox/Suppliers" },
        { name: "kyc.msg", bytes: outlookMsg() },
        { name: "photo.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) },
      ]),
    );
    expect(MailboxImportResponseSchema.parse(r)).toBeTruthy();
    expect(r).toMatchObject({ mailbox: MAILBOX, userId: MAILBOX, mode: "hybrid", counts: { files: 3, imported: 2, duplicate: 0, rejected: 1, failed: 0, analysed: 0 } });
    expect(r.results.map((x) => [x.name, x.status])).toEqual([
      ["invoice.eml", "imported"],
      ["kyc.msg", "imported"],
      ["photo.jpg", "rejected"],
    ]);
    expect(r.results[2]!.reason).toMatch(/not an \.eml or \.msg/);

    // Stored under the mailbox owner (AUTH_MODE=dev: the address the add-in sends), searchable, with its folder.
    expect(await c.deps.repos.emailIndex.count(MAILBOX)).toBe(2);
    const found = await c.services.search.search(ctx(user(MAILBOX)), { query: "invoice overdue payment", limit: 5 });
    expect(found.results[0]).toMatchObject({ emailId: r.results[0]!.emailId, subject: "Invoice 2026-091 overdue" });
    const [chunk] = await c.deps.repos.emailIndex.listReceivedBetween(MAILBOX, "2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z", 10).then((l) => l.filter((x) => x.emailId === r.results[0]!.emailId));
    expect(chunk).toMatchObject({ folder: "Inbox/Suppliers", fromAddress: "jean@client.example" });

    // Nothing was analysed: no model call unless asked.
    expect(c.llm.calls).toBe(0);
    expect(await c.deps.repos.analysisCache.countPrecomputed(MAILBOX)).toBe(0);

    // One audit event per batch, by the admin, with counts only.
    const page = await c.services.audit.query(admin, { page: 1, pageSize: 50, type: "emails_indexed" });
    const event = page.items.find((e) => e.details?.stage === "mailbox_import");
    expect(event).toMatchObject({ user: { id: "admin-dashboard" }, approvalStatus: "auto_approved", details: { importId: "imp_test_0001", mailbox: MAILBOX, userId: MAILBOX, imported: 2, rejected: 1, analyze: false } });
    expect(JSON.stringify(event)).not.toMatch(/overdue|KYC pack|invoice\.eml/i);

    const metrics = await c.metrics.registry.getSingleMetricAsString("oao_mailbox_import_files_total");
    expect(metrics).toMatch(/outcome="imported"} 2/);
    expect(metrics).toMatch(/outcome="rejected"} 1/);
  });

  it("re-importing is idempotent; analyze=true then precomputes, and triage still saves the newsletter", async () => {
    const c = await createTestContainer();
    const files = [
      { name: "invoice.eml", bytes: invoice() },
      { name: "digest.eml", bytes: newsletter() },
    ];
    await c.services.mailboxImport.import(admin, request(files));
    const again = await c.services.mailboxImport.import(admin, request([...files, { name: "invoice (copy).eml", bytes: invoice() }], { analyze: true }));
    expect(again.counts).toMatchObject({ files: 3, imported: 0, duplicate: 3, analysed: 2, skippedByTriage: 1 });
    expect(await c.deps.repos.emailIndex.count(MAILBOX)).toBe(2);
    // Stored as the sync worker stores them: found by email id, as precomputed.
    expect(await c.deps.repos.analysisCache.countPrecomputed(MAILBOX)).toBe(1);
    expect(again.results.filter((x) => x.analysed)).toHaveLength(2);
  });

  it("an analysis failure keeps the message imported and says so", async () => {
    const c = await createTestContainer();
    vi.spyOn(c.services.analyzeEmail, "analyze").mockRejectedValueOnce(new Error("model down"));
    const r = await c.services.mailboxImport.import(admin, request([{ name: "invoice.eml", bytes: invoice() }], { analyze: true }));
    expect(r.counts).toMatchObject({ imported: 1, analysed: 0, failed: 0 });
    expect(r.results[0]).toMatchObject({ status: "imported", analysed: false, reason: expect.stringMatching(/analysis failed/) });
  });

  it("refuses a batch whose decoded size exceeds the limit", async () => {
    const c = await createTestContainer();
    const half = new Uint8Array(MAILBOX_IMPORT_MAX_BATCH_BYTES / 2 + 1);
    await expect(c.services.mailboxImport.import(admin, request([{ name: "a.eml", bytes: half }, { name: "b.eml", bytes: half }]))).rejects.toMatchObject({ code: "validation_error", message: expect.stringMatching(/Batch too large/) });
  });

  it("AUTH_MODE=aad: stored under the Entra object id the add-in presents; an unknown mailbox falls back to its address with a warning", async () => {
    const c = await createTestContainer({ AUTH_MODE: "aad", AAD_TENANT_ID: "tenant", AAD_CLIENT_ID: "client" });
    await c.services.audit.record({ user: { id: "oid-ana", email: "ana@northbridge.example", displayName: "Ana" }, type: "summary_generated" });
    const known = await c.services.mailboxImport.import(admin, request([{ name: "i.eml", bytes: invoice() }], { mailbox: "Ana@Northbridge.example" }));
    expect(known).toMatchObject({ mailbox: "ana@northbridge.example", userId: "oid-ana" });
    expect(known.warning).toBeUndefined();
    const unknown = await c.services.mailboxImport.import(admin, request([{ name: "i.eml", bytes: invoice() }], { mailbox: "new@northbridge.example" }));
    expect(unknown).toMatchObject({ userId: "new@northbridge.example", warning: expect.stringMatching(/has not used the add-in yet/) });
  });
});

describe("one message stored under two ids", () => {
  it("search and the daily brief count an imported message once when it is also opened in Outlook", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    const r = await c.services.mailboxImport.import(admin, request([{ name: "invoice.eml", bytes: invoice() }], { analyze: true }));
    // The add-in indexes the same mail under its Outlook id when it is opened.
    const opened = sampleEmail({ id: "AAMkOutlookId", internetMessageId: "<invoice@supplier.example>", subject: "Invoice 2026-091 overdue", body: "Hello, invoice 2026-091 is overdue. Please confirm the payment date before Friday.", receivedAt: "2026-09-29T07:00:00.000Z", attachments: [] });
    await c.services.indexEmails.index(ctx(user(MAILBOX)), [opened], { audit: false });
    expect(await c.deps.repos.emailIndex.count(MAILBOX)).toBe(2);

    const found = await c.services.search.search(ctx(user(MAILBOX)), { query: "invoice overdue", limit: 5 });
    expect(found.results).toHaveLength(1);

    const brief = await c.services.dailyBrief.generate(ctx(user(MAILBOX)), { date: "2026-09-30" });
    expect(brief.stats).toMatchObject({ newEmails: 1, analysed: 1 });
    expect(r.results[0]!.analysed).toBe(true);
  });
});

describe(`POST ${Routes.mailboxImport}`, () => {
  const H = { "content-type": "application/json" };
  const asAdmin = { ...H, authorization: "Bearer test-admin-token" };
  const withApp = async (fn: (app: Awaited<ReturnType<typeof buildApp>>, c: TestContainer) => Promise<void>) => {
    const c = await createTestContainer();
    const app = await buildApp(c, { logger: false });
    try {
      await fn(app, c);
    } finally {
      await app.close();
    }
  };

  it("admin only, validated with the shared contract, contract-valid answer", async () => {
    await withApp(async (app) => {
      const payload = request([{ name: "invoice.eml", bytes: invoice() }]);
      const asUser = await app.inject({ method: "POST", url: Routes.mailboxImport, headers: { ...H, "x-user-email": MAILBOX }, payload });
      expect(asUser.statusCode).toBe(403);
      const bad = await app.inject({ method: "POST", url: Routes.mailboxImport, headers: asAdmin, payload: { ...payload, importId: "x", files: [] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["importId", "files"]));
      const ok = await app.inject({ method: "POST", url: Routes.mailboxImport, headers: asAdmin, payload });
      expect(ok.statusCode).toBe(200);
      expect(MailboxImportResponseSchema.parse(ok.json()).counts.imported).toBe(1);
    });
  });

  it("accepts more than the global 2 MB body limit, which still applies elsewhere with its own message", async () => {
    await withApp(async (app) => {
      const big = eml({ messageId: "<big@x.example>", subject: "Scan", text: "See the scan.", attachment: { name: "scan.pdf", base64: Buffer.alloc(2_500_000, 7).toString("base64") } });
      const ok = await app.inject({ method: "POST", url: Routes.mailboxImport, headers: asAdmin, payload: request([{ name: "big.eml", bytes: big }]) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().results[0]).toMatchObject({ status: "imported" });
      const elsewhere = await app.inject({ method: "POST", url: Routes.search, headers: asAdmin, payload: { query: "x".repeat(3 * 1024 * 1024) } });
      expect(elsewhere.statusCode).toBe(413);
      expect(elsewhere.json().error.message).toBe("Request body too large (max 2 MB)");
    });
  });
});
