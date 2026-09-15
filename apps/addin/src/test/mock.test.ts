import { ActionProposalSchema, ApproveActionsResponseSchema, AutomationSchema, ChatResponseSchema, ComplianceCheckResponseSchema, DraftReplySchema, EmailAnalysisSchema, EscalationSchema, ThreadSynthesisSchema } from "@oao/shared";
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
