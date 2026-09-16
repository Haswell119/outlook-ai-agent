import { beforeEach, describe, expect, it } from "vitest";
import { EmailAnalysisSchema, DraftReplySchema, ThreadSynthesisSchema } from "@oao/shared";
import { createTestContainer, ctx, sampleEmail, type TestContainer } from "../helpers.js";
import { sampleEmails, DEMO_CONVERSATION_ID } from "../../src/seed/emails.js";

let c: TestContainer;
beforeEach(async () => {
  c = await createTestContainer();
});

describe("AnalyzeEmailService", () => {
  it("returns a contract-valid analysis with phishing screening and writes an audit event", async () => {
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail(), includeThread: false });
    expect(() => EmailAnalysisSchema.parse(r)).not.toThrow();
    expect(r.summary).toContain("Sarah Johnson");
    expect(r.pendingTasks.length).toBeGreaterThan(0);
    expect(r.suggestedActions.map((a) => a.type)).toEqual(expect.arrayContaining(["draft_reply", "create_reminder", "flag"]));
    expect(r.phishing?.verdict).toBe("clean");
    expect(r.confidence).toBeGreaterThan(0.7);
    const audit = c.repos.audit.events;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ type: "summary_generated", user: { id: "dev.user@northbridge.example" }, source: { emailId: "email-1" }, approvalStatus: "auto_approved" });
    expect(audit[0]!.details.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit[0]!.details.prompt).toBeUndefined(); // AUDIT_STORE_CONTENT=false
    expect((audit[0]!.details.analysis as { summary: string }).summary).toBe(r.summary);
  });

  it("force bypasses the rule-based triage and the cache (explicit user request)", async () => {
    const newsletter = sampleEmail({ id: "nl-1", subject: "Weekly market newsletter", from: { name: "Market News", address: "noreply@news.example" }, body: "This week in markets… Unsubscribe here: https://news.example/unsub" });
    const triaged = await c.services.analyzeEmail.analyze(ctx(), { email: newsletter, includeThread: false, force: false });
    expect(triaged.source).toBe("heuristic");
    expect(triaged.triage?.kind).toBe("newsletter");
    const forced = await c.services.analyzeEmail.analyze(ctx(), { email: newsletter, includeThread: false, force: true });
    expect(forced.source).toBe("llm");
    // A second forced call must not be served from the cache either.
    const forcedAgain = await c.services.analyzeEmail.analyze(ctx(), { email: newsletter, includeThread: false, force: true });
    expect(forcedAgain.source).toBe("llm");
    // …but a normal call after that benefits from the entry the forced call wrote.
    const normal = await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail(), includeThread: false, force: false });
    const cachedNormal = await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail(), includeThread: false, force: false });
    expect(normal.source).toBe("llm");
    expect(cachedNormal.source).toBe("cache");
  });

  it("answers in French when asked", async () => {
    const r = await c.services.analyzeEmail.analyze(ctx(undefined, "fr"), { email: sampleEmail(), includeThread: false });
    expect(r.language).toBe("fr");
    expect(r.suggestedActions.some((a) => /Rédiger|rappel/i.test(a.title))).toBe(true);
  });

  it("flags phishing and adds an escalation action for a suspicious email", async () => {
    const phish = sampleEmail({ from: { name: "Northbridge IT Support", address: "it-support@northbridqe-finance.com" }, subject: "URGENT: password expires", body: "Verify your account immediately at http://185.203.116.42/owa and confirm your password. Final notice.", attachments: [] });
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: phish, includeThread: false });
    expect(r.phishing?.verdict).toBe("likely_phishing");
    expect(r.risks[0]?.code).toBe("phishing_suspected");
    expect(r.suggestedActions.map((a) => a.type)).toContain("escalate_compliance");
    expect(c.repos.audit.events[0]!.riskLevel).toBe("high");
  });

  it("degrades gracefully when the model is down: heuristics, confidence ≤ 0.3, error audit", async () => {
    c.llm.failing = true;
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail(), includeThread: false });
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.risks.map((x) => x.code)).toContain("ai_output_unreliable");
    expect(r.summary.length).toBeGreaterThan(10);
    expect(c.repos.audit.events.map((e) => e.type)).toEqual(["summary_generated", "error"]);
    expect(c.repos.audit.events[0]!.details.degraded).toBe(true);
  });

  it("stores raw prompt/response when AUDIT_STORE_CONTENT=true", async () => {
    const cc = await createTestContainer({ AUDIT_STORE_CONTENT: "true" });
    await cc.services.analyzeEmail.analyze(ctx(), { email: sampleEmail(), includeThread: false });
    expect(typeof cc.repos.audit.events[0]!.details.prompt).toBe("string");
  });
});

describe("SynthesizeThreadService", () => {
  it("synthesises the Project Horizon conversation: missing document, tasks, deadlines, next step", async () => {
    const messages = sampleEmails(new Date("2025-06-10T12:00:00Z")).filter((e) => e.conversationId === DEMO_CONVERSATION_ID).slice(0, 15);
    const r = await c.services.synthesizeThread.synthesize(ctx(), { thread: { conversationId: DEMO_CONVERSATION_ID, subject: "Project Horizon – ABC Capital", messages } });
    expect(() => ThreadSynthesisSchema.parse(r)).not.toThrow();
    expect(r.executiveSummary).toContain("Project Horizon");
    expect(r.missingDocuments.length).toBeGreaterThan(0);
    expect(r.openTasks.some((t) => t.critical)).toBe(true);
    expect(r.recommendedNextStep?.action?.type).toBe("draft_reply");
    expect(r.sources).toHaveLength(15);
    expect(c.repos.audit.events[0]).toMatchObject({ type: "thread_synthesis_generated", source: { conversationId: DEMO_CONVERSATION_ID } });
  });

  it("degrades when the model fails", async () => {
    c.llm.failing = true;
    const r = await c.services.synthesizeThread.synthesize(ctx(), { thread: { conversationId: "x", subject: "S", messages: [sampleEmail()] } });
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.risks.map((x) => x.code)).toContain("ai_output_unreliable");
  });
});

describe("DraftReplyService", () => {
  it("drafts a reply for each intent/tone in both languages, never sends", async () => {
    for (const intent of ["accept", "decline", "acknowledge", "follow_up", "request_info", "custom"] as const) {
      const r = await c.services.draftReply.draft(ctx(undefined, intent === "decline" ? "fr" : "en"), { email: sampleEmail(), intent, tone: intent === "accept" ? "friendly" : "formal", instructions: intent === "custom" ? "Ask for a call on Monday." : undefined });
      expect(() => DraftReplySchema.parse(r)).not.toThrow();
      expect(r.subject).toMatch(/^R[Ee]: /);
      expect(r.body.length).toBeGreaterThan(30);
      if (intent === "custom") expect(r.body).toContain("call on Monday");
      if (intent === "decline") expect(r.body).toContain("Bonjour");
    }
    const audits = c.repos.audit.events.filter((e) => e.type === "draft_reply_generated");
    expect(audits).toHaveLength(6);
    expect(audits[0]!.approvalStatus).toBe("pending");
  });
  it("falls back to a template when the model is down", async () => {
    c.llm.failing = true;
    const r = await c.services.draftReply.draft(ctx(), { email: sampleEmail(), intent: "acknowledge", tone: "formal" });
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.body).toContain("Q2 vendor risk assessment");
  });
});
