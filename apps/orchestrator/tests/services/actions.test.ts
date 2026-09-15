import { beforeEach, describe, expect, it } from "vitest";
import { ActionProposalSchema, ApproveActionsResponseSchema } from "@oao/shared";
import type { GraphClient } from "../../src/ports/graph.js";
import { DisabledGraphClient } from "../../src/adapters/graph/client.js";
import { clientInstruction } from "../../src/services/ActionsService.js";
import { createTestContainer, ctx, sampleEmail, user, type TestContainer } from "../helpers.js";

let c: TestContainer;
beforeEach(async () => {
  c = await createTestContainer();
});

describe("ActionsService.propose", () => {
  it("converts the analysis into governed proposed actions with a 30-minute expiry", async () => {
    const p = await c.services.actions.propose(ctx(), { email: sampleEmail() });
    expect(() => ActionProposalSchema.parse(p)).not.toThrow();
    expect(p.humanValidationRequired).toBe(true);
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(30 * 60 * 1000);
    const byType = Object.fromEntries(p.actions.map((a) => [a.type, a]));
    expect(byType.draft_reply).toMatchObject({ executionTarget: "client", riskLevel: "low", requiresApproval: true, source: { kind: "email", emailId: "email-1" } });
    expect(byType.create_reminder).toMatchObject({ executionTarget: "server", riskLevel: "medium" });
    expect(byType.escalate_compliance).toMatchObject({ riskLevel: "high", requiresComplianceApproval: true, selectedByDefault: false });
    expect(p.actions.every((a) => a.type !== ("send_email" as string))).toBe(true);
    expect(c.repos.audit.events.map((e) => e.type)).toEqual(["summary_generated", "actions_proposed"]);
  });

  it("re-uses an existing analysis via analysisAuditId and rejects foreign / wrong ids", async () => {
    const a = await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail(), includeThread: false });
    const p = await c.services.actions.propose(ctx(), { analysisAuditId: a.auditId });
    expect(p.actions.length).toBe(a.suggestedActions.length);
    expect(c.repos.audit.events.filter((e) => e.type === "summary_generated")).toHaveLength(1);
    await expect(c.services.actions.propose(ctx(user("other@longbow.ch")), { analysisAuditId: a.auditId })).rejects.toMatchObject({ code: "not_found" });
    await expect(c.services.actions.propose(ctx(), { analysisAuditId: p.auditId })).rejects.toMatchObject({ code: "validation_error" });
    await expect(c.services.actions.propose(ctx(), {})).rejects.toMatchObject({ code: "validation_error" });
  });

  it("proposes from a thread", async () => {
    const p = await c.services.actions.propose(ctx(), { thread: { conversationId: "conv-1", subject: "T", messages: [sampleEmail()] } });
    expect(p.actions.length).toBeGreaterThan(0);
    expect(p.actions[0]!.source.kind).toBe("thread");
  });
});

describe("ActionsService.approve", () => {
  it("executes approved actions: client instructions when Graph is disabled, escalation for compliance, rejection of unselected", async () => {
    const p = await c.services.actions.propose(ctx(), { email: sampleEmail() });
    const ids = (t: string) => p.actions.filter((a) => a.type === t).map((a) => a.id);
    const selected = [...ids("draft_reply"), ...ids("create_reminder"), ...ids("escalate_compliance"), ...ids("classify_email")];
    const r = await c.services.actions.approve(ctx(), { proposalId: p.proposalId, actionIds: selected, comment: "ok" });
    expect(() => ApproveActionsResponseSchema.parse(r)).not.toThrow();
    const by = Object.fromEntries(r.results.map((x) => [x.type, x]));
    expect(by.draft_reply).toMatchObject({ status: "pending_client", clientInstruction: { operation: "displayReplyForm" } });
    expect(by.create_reminder).toMatchObject({ status: "pending_client", clientInstruction: { operation: "displayNewAppointmentForm" } });
    expect(by.classify_email).toMatchObject({ status: "pending_client", clientInstruction: { operation: "addCategory", parameters: { category: expect.any(String) } } });
    expect(by.escalate_compliance!.status).toBe("pending_compliance");
    expect(await c.repos.escalations.list({})).toHaveLength(1);
    const types = c.repos.audit.events.map((e) => e.type);
    expect(types.filter((t) => t === "action_approved")).toHaveLength(4);
    expect(types).toContain("compliance_escalated");
    expect(types.filter((t) => t === "action_rejected")).toHaveLength(p.actions.length - 4);
    // Second approval of the same action reports its current status instead of re-executing.
    const again = await c.services.actions.approve(ctx(), { proposalId: p.proposalId, actionIds: [ids("draft_reply")[0]!] });
    expect(again.results[0]!.message).toMatch(/already/);
  });

  it("executes server actions through Graph when enabled, with client fallback on failure", async () => {
    const calls: string[] = [];
    const graph: GraphClient = Object.assign(new DisabledGraphClient(), {
      enabled: true,
      createCalendarEvent: async () => {
        calls.push("event");
        return { id: "ev1" };
      },
      updateCategories: async () => {
        calls.push("cat");
        throw new Error("Graph 503");
      },
    });
    const cc = await createTestContainer({}, { graph });
    const u = user("dev.user@longbow.ch", ["user"], { token: "user-token" });
    const p = await cc.services.actions.propose(ctx(u), { email: sampleEmail() });
    const reminder = p.actions.find((a) => a.type === "create_reminder")!;
    const classify = p.actions.find((a) => a.type === "classify_email")!;
    // classify_email is a client action; force a server one through a custom proposal to test the fallback path.
    const stored = await cc.repos.actions.getProposal(p.proposalId);
    stored!.actions.find((a) => a.action.id === classify.id)!.action.executionTarget = "server";
    await cc.repos.actions.saveProposal(stored!);
    const r = await cc.services.actions.approve(ctx(u), { proposalId: p.proposalId, actionIds: [reminder.id, classify.id] });
    expect(r.results.find((x) => x.actionId === reminder.id)).toMatchObject({ status: "executed", message: expect.stringContaining("ev1") });
    expect(r.results.find((x) => x.actionId === classify.id)).toMatchObject({ status: "pending_client", clientInstruction: { operation: "addCategory" } });
    expect(calls).toEqual(["event", "cat"]);
    expect(cc.repos.audit.events.some((e) => e.type === "action_failed")).toBe(true);
  });

  it("refuses foreign, unknown and expired proposals", async () => {
    const p = await c.services.actions.propose(ctx(), { email: sampleEmail() });
    await expect(c.services.actions.approve(ctx(user("x@longbow.ch")), { proposalId: p.proposalId, actionIds: [p.actions[0]!.id] })).rejects.toMatchObject({ code: "not_found" });
    await expect(c.services.actions.approve(ctx(), { proposalId: "nope", actionIds: ["a"] })).rejects.toMatchObject({ code: "not_found" });
    const stored = await c.repos.actions.getProposal(p.proposalId);
    stored!.expiresAt = new Date(Date.now() - 1000).toISOString();
    await c.repos.actions.saveProposal(stored!);
    await expect(c.services.actions.approve(ctx(), { proposalId: p.proposalId, actionIds: [p.actions[0]!.id] })).rejects.toMatchObject({ code: "conflict" });
    const r = await c.services.actions.approve(ctx(), { proposalId: (await c.services.actions.propose(ctx(), { email: sampleEmail() })).proposalId, actionIds: ["unknown-id"] });
    expect(r.results[0]).toMatchObject({ status: "failed", message: "Unknown action id" });
  });

  it("report: the add-in reports the client-side outcome", async () => {
    const p = await c.services.actions.propose(ctx(), { email: sampleEmail() });
    const draft = p.actions.find((a) => a.type === "draft_reply")!;
    await c.services.actions.approve(ctx(), { proposalId: p.proposalId, actionIds: [draft.id] });
    const r = await c.services.actions.report(ctx(), draft.id, { status: "executed", message: "Reply form opened" });
    expect(r.status).toBe("executed");
    expect((await c.repos.actions.getAction(draft.id))!.status).toBe("executed");
    const cancelled = await c.services.actions.report(ctx(), draft.id, { status: "cancelled" });
    expect(cancelled.status).toBe("rejected");
    await expect(c.services.actions.report(ctx(user("x@longbow.ch")), draft.id, { status: "executed" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("clientInstruction covers every action type", () => {
    const base = { id: "1", title: "t", explanation: "e", source: { kind: "email" as const, label: "l" }, riskLevel: "low" as const, requiresApproval: true, requiresComplianceApproval: false, executionTarget: "client" as const, selectedByDefault: true };
    expect(clientInstruction({ ...base, type: "archive", parameters: {} }, "en")).toEqual({ operation: "openMoveDialog", parameters: { folder: "Archive" } });
    expect(clientInstruction({ ...base, type: "apply_label", parameters: { label: "Internal" } }, "en").parameters.label).toBe("Internal");
    expect(clientInstruction({ ...base, type: "remove_attachment", parameters: { attachmentIds: ["a"] } }, "en").operation).toBe("removeAttachment");
    expect(clientInstruction({ ...base, type: "request_document", parameters: {} }, "fr").parameters.intent).toBe("request_info");
    expect(clientInstruction({ ...base, type: "flag", parameters: {} }, "en").operation).toBe("flag");
    expect(clientInstruction({ ...base, type: "notify", parameters: {} }, "en").operation).toBe("none");
  });
});
