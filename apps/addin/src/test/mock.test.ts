import {
  ActionProposalSchema,
  ApproveActionsResponseSchema,
  AutomationSchema,
  ChatResponseSchema,
  ComplianceCheckResponseSchema,
  DailyBriefSchema,
  DraftReplySchema,
  EmailAnalysisSchema,
  EscalationSchema,
  FeatureFlagsSchema,
  MailboxSyncStatusSchema,
  ThreadSynthesisSchema,
} from "@oao/shared";
import { describe, expect, it } from "vitest";
import { createMockClient } from "@/api/mock";
import { sampleCompose, sampleEmail, sampleThread } from "@/office/sample";

const api = createMockClient(() => "en", 0);

describe("mock API responses validate against the shared schemas", () => {
  it("analyzeEmail", async () => {
    const r = await api.analyzeEmail({ email: sampleEmail, includeThread: false });
    expect(EmailAnalysisSchema.safeParse(r).success).toBe(true);
    expect(Math.round(r.confidence * 100)).toBe(92);
    expect(r.suggestedActions).toHaveLength(4);
  });
  it("analyzeThread", async () => {
    const r = await api.analyzeThread({ thread: sampleThread });
    expect(ThreadSynthesisSchema.safeParse(r).success).toBe(true);
    expect(r.missingDocuments[0]?.name).toMatch(/Account Mandate/);
    expect(r.sources).toHaveLength(10);
  });
  it("chat", async () => {
    const r = await api.chat({ message: "Find the email where the client approved the mandate.", scope: {} });
    expect(ChatResponseSchema.safeParse(r).success).toBe(true);
    expect(r.sources.map((s) => Math.round(s.relevance * 100))).toEqual([95, 78, 62]);
  });
  it("proposeActions / approveActions", async () => {
    const p = await api.proposeActions({ email: sampleEmail });
    expect(ActionProposalSchema.safeParse(p).success).toBe(true);
    expect(p.actions).toHaveLength(5);
    const a = await api.approveActions({ proposalId: p.proposalId, actionIds: p.actions.map((x) => x.id) });
    expect(ApproveActionsResponseSchema.safeParse(a).success).toBe(true);
    expect(a.results.filter((r) => r.status === "pending_client").every((r) => r.clientInstruction)).toBe(true);
  });
  it("complianceCheck, escalation, draftReply, automations", async () => {
    const c = await api.complianceCheck({ draft: sampleCompose });
    expect(ComplianceCheckResponseSchema.safeParse(c).success).toBe(true);
    expect(c.issues).toHaveLength(4);
    expect(EscalationSchema.safeParse(await api.createEscalation({ reason: "test", issues: c.issues })).success).toBe(true);
    expect(DraftReplySchema.safeParse(await api.draftReply({ email: sampleEmail, intent: "acknowledge", tone: "formal" })).success).toBe(true);
    const autos = await api.listAutomations();
    expect(autos.every((a) => AutomationSchema.safeParse(a).success)).toBe(true);
    const sim = await api.simulateAutomation(autos[0]!.id, { sampleSize: 10 });
    expect(AutomationSchema.safeParse(sim).success).toBe(true);
    expect(sim.lastSimulation?.checks).toHaveLength(4);
    expect(sim.stats.estimatedMinutesSavedPerWeek).toBe(18);
  });
});

describe("new endpoints (precomputation, brief, sync, features)", () => {
  it("analysisByEmail returns a precomputed analysis for a known id and null otherwise", async () => {
    const precomputed = await api.analysisByEmail(sampleEmail.id);
    expect(precomputed).not.toBeNull();
    expect(EmailAnalysisSchema.safeParse(precomputed).success).toBe(true);
    expect(precomputed!.source).toBe("precomputed");
    // 404 → null, which is what sends the caller down the POST path.
    expect(await api.analysisByEmail("msg-never-seen-42")).toBeNull();
  });

  it("analysisByEmail returns a triaged analysis for bulk senders", async () => {
    const triaged = await api.analysisByEmail("msg-newsletter-weekly");
    expect(triaged?.triage?.kind).toBe("newsletter");
    expect(triaged?.source).toBe("heuristic");
    expect(triaged?.suggestedActions).toHaveLength(0);
    expect(EmailAnalysisSchema.safeParse(triaged).success).toBe(true);
  });

  it("an analysed email becomes available through the id lookup", async () => {
    const fresh = createMockClient(() => "en", 0);
    expect(await fresh.analysisByEmail("msg-brand-new")).toBeNull();
    await fresh.analyzeEmail({ email: { ...sampleEmail, id: "msg-brand-new" }, includeThread: false });
    expect(await fresh.analysisByEmail("msg-brand-new")).not.toBeNull();
  });

  it("dailyBrief and generateDailyBrief validate and mark their source", async () => {
    const stored = await api.dailyBrief({ date: "2025-05-26" });
    expect(DailyBriefSchema.safeParse(stored).success).toBe(true);
    expect(stored!.source).toBe("precomputed");
    expect(stored!.priorityEmails).toHaveLength(3);
    expect(stored!.stats.newEmails).toBe(42);

    const fresh = await api.generateDailyBrief({ date: "2025-05-26", refresh: true });
    expect(DailyBriefSchema.safeParse(fresh).success).toBe(true);
    expect(fresh.source).toBe("llm");
  });

  it("mailboxSync and syncNow validate", async () => {
    const status = await api.mailboxSync();
    expect(MailboxSyncStatusSchema.safeParse(status).success).toBe(true);
    expect(status.enabled).toBe(true);
    const syncing = await api.syncNow();
    expect(MailboxSyncStatusSchema.safeParse(syncing).success).toBe(true);
    expect(syncing.state).toBe("syncing");
  });

  it("features validates and exposes the new flags", async () => {
    const flags = await api.features();
    expect(FeatureFlagsSchema.safeParse(flags).success).toBe(true);
    expect(flags.precomputeEnabled).toBe(true);
    expect(flags.dailyBriefEnabled).toBe(true);
    expect(flags.llmFastModel).toBeTruthy();
    expect(flags.organizationName).toBe("Northbridge Capital");
  });
});
