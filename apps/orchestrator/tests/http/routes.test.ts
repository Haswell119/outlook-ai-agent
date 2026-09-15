import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AnalyzeEmailRequestSchema, ActionProposalSchema, ApproveActionsResponseSchema, AuditStatsSchema, ChatResponseSchema, ComplianceCheckResponseSchema, DraftReplySchema, EmailAnalysisSchema, HealthSchema, FeatureFlagsSchema, Routes, AutomationSchema, EscalationSchema, AuditPageSchema } from "@oao/shared";
import { buildApp } from "../../src/app.js";
import { createTestContainer, sampleEmail, type TestContainer } from "../helpers.js";
import { sampleEmails, DEMO_PEOPLE } from "../../src/seed/emails.js";

let c: TestContainer;
let app: FastifyInstance;
const H = { "content-type": "application/json", "accept-language": "en" };
const asUser = (email = "dev.user@longbow.ch") => ({ ...H, "x-user-email": email, "x-user-name": "Test User" });
const asAdmin = { ...H, authorization: "Bearer test-admin-token" };

beforeAll(async () => {
  c = await createTestContainer();
  app = await buildApp(c, { logger: false });
  await app.ready();
});
afterAll(async () => app.close());

describe("system & auth", () => {
  it("health / features are public and contract-valid", async () => {
    const h = await app.inject({ method: "GET", url: Routes.health });
    expect(h.statusCode).toBe(200);
    expect(HealthSchema.parse(h.json()).status).toBe("ok");
    expect(h.headers["x-correlation-id"]).toBeTruthy();
    const f = await app.inject({ method: "GET", url: Routes.features });
    expect(FeatureFlagsSchema.parse(f.json())).toMatchObject({ llmProvider: "mock", authMode: "dev" });
  });
  it("dev identity from headers; admin token → admin roles; roles gate admin routes (403)", async () => {
    const me = await app.inject({ method: "GET", url: Routes.me, headers: asUser("jane.smith@longbow.ch") });
    expect(me.json()).toMatchObject({ email: "jane.smith@longbow.ch", roles: ["user"] });
    const admin = await app.inject({ method: "GET", url: Routes.me, headers: asAdmin });
    expect(admin.json().roles).toEqual(expect.arrayContaining(["admin", "compliance"]));
    const forbidden = await app.inject({ method: "GET", url: Routes.adminUsers, headers: asUser() });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("forbidden");
    const ok = await app.inject({ method: "GET", url: Routes.adminUsers, headers: asAdmin });
    expect(ok.statusCode).toBe(200);
    const compliance = await app.inject({ method: "GET", url: Routes.auditStats, headers: asUser("compliance@longbow.ch") });
    expect(compliance.statusCode).toBe(200);
  });
  it("aad mode returns 401 without a bearer token, still accepts the admin token", async () => {
    const cc = await createTestContainer({ AUTH_MODE: "aad", AAD_TENANT_ID: "tenant", AAD_CLIENT_ID: "client" });
    const aadApp = await buildApp(cc, { logger: false });
    const r = await aadApp.inject({ method: "GET", url: Routes.me, headers: asUser() });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
    const bad = await aadApp.inject({ method: "GET", url: Routes.me, headers: { authorization: "Bearer not-a-jwt" } });
    expect(bad.statusCode).toBe(401);
    const admin = await aadApp.inject({ method: "GET", url: Routes.me, headers: asAdmin });
    expect(admin.statusCode).toBe(200);
    await aadApp.close();
  });
  it("validation errors → 400 with details; unknown route → 404", async () => {
    const r = await app.inject({ method: "POST", url: Routes.analyzeEmail, headers: asUser(), payload: { email: { subject: 1 } } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: "validation_error", details: expect.any(Array) });
    expect((await app.inject({ method: "GET", url: "/api/v1/nope", headers: asUser() })).statusCode).toBe(404);
  });
});

describe("analysis routes", () => {
  it("POST analyze/email", async () => {
    const payload = AnalyzeEmailRequestSchema.parse({ email: sampleEmail() });
    const r = await app.inject({ method: "POST", url: Routes.analyzeEmail, headers: asUser(), payload });
    expect(r.statusCode).toBe(200);
    expect(() => EmailAnalysisSchema.parse(r.json())).not.toThrow();
  });
  it("POST analyze/thread and draft/reply (Accept-Language fr)", async () => {
    const t = await app.inject({ method: "POST", url: Routes.analyzeThread, headers: asUser(), payload: { thread: { conversationId: "c", subject: "S", messages: [sampleEmail()] } } });
    expect(t.statusCode).toBe(200);
    const d = await app.inject({ method: "POST", url: Routes.draftReply, headers: { ...asUser(), "accept-language": "fr-CH" }, payload: { email: sampleEmail(), intent: "acknowledge" } });
    expect(d.statusCode).toBe(200);
    expect(DraftReplySchema.parse(d.json()).language).toBe("fr");
  });
});

describe("search / chat / index routes", () => {
  it("index then chat with citations; get session", async () => {
    const idx = await app.inject({ method: "POST", url: Routes.indexEmails, headers: asUser(), payload: { emails: sampleEmails() } });
    expect(idx.statusCode).toBe(200);
    expect(idx.json().indexed).toBe(40);
    const s = await app.inject({ method: "GET", url: `${Routes.search}?query=signed%20account%20mandate&limit=3`, headers: asUser() });
    expect(s.statusCode).toBe(200);
    expect(s.json().results).toHaveLength(3);
    const chat = await app.inject({ method: "POST", url: Routes.chat, headers: asUser(), payload: { message: "Find the email where the client approved the mandate" } });
    expect(chat.statusCode).toBe(200);
    const body = ChatResponseSchema.parse(chat.json());
    expect(body.sources.length).toBeGreaterThan(0);
    const session = await app.inject({ method: "GET", url: Routes.chatSession(body.sessionId), headers: asUser() });
    expect(session.json().messages).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: Routes.chatSession(body.sessionId), headers: asUser("other@longbow.ch") })).statusCode).toBe(404);
  });
});

describe("compliance routes", () => {
  it("POST compliance/check, phishing, escalations flow with role guard on decision", async () => {
    const check = await app.inject({ method: "POST", url: Routes.complianceCheck, headers: asUser(), payload: { draft: { to: [{ address: "michael.brown@clientco.com" }], subject: "Q2", body: "Attached the Q2 performance report of your portfolio.", attachments: [{ name: "Client A – Q2 Performance Report.pdf" }] } } });
    expect(check.statusCode).toBe(200);
    expect(ComplianceCheckResponseSchema.parse(check.json()).issues.length).toBeGreaterThanOrEqual(3);
    const ph = await app.inject({ method: "POST", url: Routes.phishingCheck, headers: asUser(), payload: { email: sampleEmail() } });
    expect(ph.json().verdict).toBe("clean");
    const esc = await app.inject({ method: "POST", url: Routes.escalations, headers: asUser(), payload: { reason: "External send", issues: [] } });
    expect(esc.statusCode).toBe(201);
    const e = EscalationSchema.parse(esc.json());
    expect((await app.inject({ method: "GET", url: Routes.escalation(e.id), headers: asUser() })).statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: Routes.escalationDecision(e.id), headers: asUser(), payload: { decision: "approved" } });
    expect(denied.statusCode).toBe(403);
    const decided = await app.inject({ method: "POST", url: Routes.escalationDecision(e.id), headers: asUser("compliance@longbow.ch"), payload: { decision: "rejected", comment: "no" } });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("rejected");
    const list = await app.inject({ method: "GET", url: `${Routes.escalations}?status=rejected`, headers: asAdmin });
    expect(list.json().length).toBeGreaterThanOrEqual(1);
  });
});

describe("actions routes", () => {
  it("propose → approve → report", async () => {
    const p = await app.inject({ method: "POST", url: Routes.proposeActions, headers: asUser(), payload: { email: sampleEmail() } });
    expect(p.statusCode).toBe(200);
    const proposal = ActionProposalSchema.parse(p.json());
    const a = await app.inject({ method: "POST", url: Routes.approveActions, headers: asUser(), payload: { proposalId: proposal.proposalId, actionIds: proposal.actions.slice(0, 2).map((x) => x.id) } });
    expect(a.statusCode).toBe(200);
    const res = ApproveActionsResponseSchema.parse(a.json());
    expect(res.results).toHaveLength(2);
    const rep = await app.inject({ method: "POST", url: Routes.reportActionResult(res.results[0]!.actionId), headers: asUser(), payload: { status: "executed" } });
    expect(rep.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: Routes.approveActions, headers: asUser("x@longbow.ch"), payload: { proposalId: proposal.proposalId, actionIds: ["a"] } })).statusCode).toBe(404);
  });
});

describe("automations routes", () => {
  it("observe → detect → simulate → approve / reject / patch", async () => {
    const emails = sampleEmails().filter((e) => e.from?.address === DEMO_PEOPLE.reports.address).slice(0, 4);
    const events = emails.flatMap((e, i) =>
      (["save_attachment", "categorize", "create_reminder"] as const).map((type, j) => ({ type, occurredAt: new Date(Date.now() - (i + 1) * 86_400_000 + j * 60_000).toISOString(), email: { id: e.id, fromAddress: e.from!.address, fromDomain: "abccapital.com", subject: e.subject, hasAttachments: true }, parameters: type === "save_attachment" ? { folder: "\\\\Reports\\ABC" } : type === "categorize" ? { category: "ABC" } : {} })),
    );
    expect((await app.inject({ method: "POST", url: Routes.automationsObserve, headers: asUser(), payload: { events } })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: Routes.automationsObserve, headers: asUser(), payload: events.slice(0, 1) })).statusCode).toBe(202);
    const det = await app.inject({ method: "POST", url: Routes.automationDetect, headers: asUser() });
    expect(det.statusCode).toBe(200);
    const [auto] = det.json() as unknown[];
    const a = AutomationSchema.parse(auto);
    const sim = await app.inject({ method: "POST", url: Routes.automationSimulate(a.id), headers: asUser(), payload: { sampleSize: 5 } });
    expect(sim.json().lastSimulation.sampleSize).toBeLessThanOrEqual(5);
    const patched = await app.inject({ method: "PATCH", url: Routes.automation(a.id), headers: asUser(), payload: { name: "My rule" } });
    expect(patched.json().name).toBe("My rule");
    const approved = await app.inject({ method: "POST", url: Routes.automationApprove(a.id), headers: asUser(), payload: {} });
    expect(approved.json().status).toBe("active");
    expect((await app.inject({ method: "GET", url: Routes.automations, headers: asUser() })).json()).toHaveLength(1);
    const rejected = await app.inject({ method: "POST", url: Routes.automationReject(a.id), headers: asUser(), payload: { comment: "stop" } });
    expect(rejected.json().status).toBe("rejected");
    expect((await app.inject({ method: "GET", url: Routes.automation(a.id), headers: asUser("other@longbow.ch") })).statusCode).toBe(404);
  });
});

describe("audit & admin routes", () => {
  it("audit list (scoped), stats, export csv, feedback, policy get/put", async () => {
    const list = await app.inject({ method: "GET", url: `${Routes.audit}?page=1&pageSize=5`, headers: asUser() });
    expect(list.statusCode).toBe(200);
    const page = AuditPageSchema.parse(list.json());
    expect(page.items.every((e) => e.user.id === "dev.user@longbow.ch")).toBe(true);
    expect(page.pageSize).toBe(5);
    const stats = await app.inject({ method: "GET", url: Routes.auditStats, headers: asAdmin });
    expect(stats.statusCode).toBe(200);
    expect(() => AuditStatsSchema.parse(stats.json())).not.toThrow();
    expect((await app.inject({ method: "GET", url: Routes.auditStats, headers: asUser() })).statusCode).toBe(403);
    const csv = await app.inject({ method: "GET", url: `${Routes.auditExport}?type=summary_generated`, headers: asAdmin });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n").length).toBeGreaterThan(1);
    const one = await app.inject({ method: "GET", url: Routes.auditEvent(page.items[0]!.id), headers: asUser() });
    expect(one.statusCode).toBe(200);
    const fb = await app.inject({ method: "POST", url: Routes.feedback, headers: asUser(), payload: { auditId: page.items[0]!.id, rating: "down", comment: "meh" } });
    expect(fb.statusCode).toBe(201);
    const policy = await app.inject({ method: "GET", url: Routes.adminPolicy, headers: asAdmin });
    expect(policy.json().internalDomains).toContain("longbow.ch");
    const put = await app.inject({ method: "PUT", url: Routes.adminPolicy, headers: asAdmin, payload: { ...policy.json(), blockOnHighRisk: true } });
    expect(put.statusCode).toBe(200);
    expect(put.json().blockOnHighRisk).toBe(true);
    expect((await app.inject({ method: "PUT", url: Routes.adminPolicy, headers: asUser("compliance@longbow.ch"), payload: policy.json() })).statusCode).toBe(403);
  });
});
