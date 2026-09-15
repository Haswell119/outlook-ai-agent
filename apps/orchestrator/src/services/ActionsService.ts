import type { ActionProposal, ActionResult, ActionType, ApproveActionsRequest, ApproveActionsResponse, DetectedRisk, EmailContext, ProposeActionsRequest, ProposedAction, ReportActionResultRequest, RiskLevel, SuggestedAction } from "@oao/shared";
import { ActionProposalSchema, ApproveActionsResponseSchema } from "@oao/shared";
import { actionLabel, govern, maxRisk } from "../domain/risk/governance.js";
import { AppError, GraphDisabledError } from "../errors.js";
import type { StoredAction, StoredProposal } from "../ports/repositories.js";
import { newId, nowIso } from "../util/ids.js";
import type { AnalyzeEmailService } from "./AnalyzeEmailService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import type { EscalationService } from "./EscalationService.js";
import type { PolicyService } from "./PolicyService.js";
import type { SynthesizeThreadService } from "./SynthesizeThreadService.js";

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** Operations the add-in knows how to execute with Office.js (clientInstruction.operation). */
export type ClientOperation = "displayReplyForm" | "addCategory" | "flag" | "displayNewAppointmentForm" | "openMoveDialog" | "applyLabel" | "removeAttachment" | "none";

interface AnalysisLike {
  suggestedActions: SuggestedAction[];
  risks: DetectedRisk[];
  sourceKind: "email" | "thread";
  sourceLabel: string;
  emailId?: string;
  conversationId?: string;
  phishingVerdict?: string;
  auditId: string;
}

export class ActionsService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly analyzer: AnalyzeEmailService,
    private readonly synthesizer: SynthesizeThreadService,
    private readonly escalations: EscalationService,
  ) {}

  /* ------------------------------ propose ------------------------------ */

  async propose(ctx: RequestContext, req: ProposeActionsRequest): Promise<ActionProposal> {
    const { user, language, correlationId } = ctx;
    const policy = await this.policy.get();
    const analysis = await this.resolveAnalysis(ctx, req);
    const contextRisk: RiskLevel = analysis.risks.some((r) => r.severity === "high") ? "medium" : "low";

    const actions: ProposedAction[] = analysis.suggestedActions.map((s) => {
      const g = govern(s.type, policy, contextRisk);
      const kind: ProposedAction["source"]["kind"] = s.parameters.reason === "phishing_suspected" || s.parameters.rule ? "rule" : analysis.sourceKind;
      return {
        id: newId(),
        type: s.type,
        title: s.title || actionLabel(s.type, language),
        explanation: s.description,
        source: { kind, label: kind === "rule" ? (language === "fr" ? "Règle interne" : "Internal rule") : analysis.sourceLabel, detail: kind === "rule" ? String(s.parameters.reason ?? s.parameters.rule ?? "") : undefined, emailId: analysis.emailId },
        riskLevel: g.riskLevel,
        requiresApproval: g.requiresApproval,
        requiresComplianceApproval: g.requiresComplianceApproval,
        executionTarget: g.executionTarget,
        parameters: { ...s.parameters, emailId: analysis.emailId, conversationId: analysis.conversationId },
        selectedByDefault: g.riskLevel !== "high",
      };
    });

    const now = nowIso();
    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS).toISOString();
    const event = await this.audit.record({
      user,
      type: "actions_proposed",
      source: { label: analysis.sourceLabel, emailId: analysis.emailId, conversationId: analysis.conversationId },
      riskLevel: maxRisk(...actions.map((a) => a.riskLevel)),
      approvalStatus: "pending",
      correlationId,
      details: { analysisAuditId: analysis.auditId, actions: actions.map((a) => ({ id: a.id, type: a.type, riskLevel: a.riskLevel, executionTarget: a.executionTarget })) },
    });
    const proposal: StoredProposal = { id: newId(), userId: user.id, auditId: event.id, emailId: analysis.emailId, conversationId: analysis.conversationId, createdAt: now, expiresAt, actions: actions.map((a) => ({ action: a, proposalId: "", status: "proposed", updatedAt: now })) };
    proposal.actions.forEach((a) => (a.proposalId = proposal.id));
    await this.deps.repos.actions.saveProposal(proposal);
    return ActionProposalSchema.parse({ proposalId: proposal.id, actions, humanValidationRequired: true, auditId: event.id, createdAt: now, expiresAt });
  }

  private async resolveAnalysis(ctx: RequestContext, req: ProposeActionsRequest): Promise<AnalysisLike> {
    if (req.analysisAuditId) {
      const event = await this.audit.get(ctx.user, req.analysisAuditId);
      const a = event.details.analysis as { suggestedActions?: SuggestedAction[]; recommendedActions?: SuggestedAction[]; risks?: DetectedRisk[] } | undefined;
      if (!a || (event.type !== "summary_generated" && event.type !== "thread_synthesis_generated")) throw AppError.validation("analysisAuditId does not reference an analysis");
      return {
        suggestedActions: a.suggestedActions ?? a.recommendedActions ?? [],
        risks: a.risks ?? [],
        sourceKind: event.type === "summary_generated" ? "email" : "thread",
        sourceLabel: event.source?.label ?? "",
        emailId: event.source?.emailId,
        conversationId: event.source?.conversationId,
        auditId: event.id,
      };
    }
    if (req.email) {
      const a = await this.analyzer.analyze(ctx, { email: req.email, language: req.language, includeThread: false });
      return { suggestedActions: a.suggestedActions, risks: a.risks, sourceKind: "email", sourceLabel: sourceLabelOf(req.email), emailId: req.email.id, conversationId: req.email.conversationId, phishingVerdict: a.phishing?.verdict, auditId: a.auditId };
    }
    if (req.thread) {
      const s = await this.synthesizer.synthesize(ctx, { thread: req.thread, language: req.language });
      const last = req.thread.messages[req.thread.messages.length - 1];
      return { suggestedActions: s.recommendedActions, risks: s.risks, sourceKind: "thread", sourceLabel: req.thread.subject || last?.subject || "", emailId: last?.id, conversationId: req.thread.conversationId, auditId: s.auditId };
    }
    throw AppError.validation("Provide email, thread or analysisAuditId");
  }

  /* ------------------------------ approve ------------------------------ */

  async approve(ctx: RequestContext, req: ApproveActionsRequest): Promise<ApproveActionsResponse> {
    const { user } = ctx;
    const proposal = await this.deps.repos.actions.getProposal(req.proposalId);
    if (!proposal || proposal.userId !== user.id) throw AppError.notFound("Proposal");
    if (Date.parse(proposal.expiresAt) < Date.now()) throw AppError.conflict("Proposal expired — please request a new proposal");

    const results: ActionResult[] = [];
    const selected = new Set(req.actionIds);
    for (const stored of proposal.actions) {
      if (!selected.has(stored.action.id)) {
        if (stored.status === "proposed") {
          const ev = await this.audit.record({ user, type: "action_rejected", source: sourceOf(proposal), riskLevel: stored.action.riskLevel, approvalStatus: "rejected", approvedBy: user.email, correlationId: ctx.correlationId, details: { actionId: stored.action.id, actionType: stored.action.type, comment: req.comment } });
          await this.deps.repos.actions.updateAction(stored.action.id, "rejected", `Not selected by ${user.email}`, ev.timestamp);
        }
        continue;
      }
      if (stored.status !== "proposed") {
        results.push({ actionId: stored.action.id, type: stored.action.type, status: stored.status === "cancelled" ? "rejected" : (stored.status as ActionResult["status"]), message: `Action already ${stored.status}`, auditId: proposal.auditId });
        continue;
      }
      results.push(await this.execute(ctx, proposal, stored, req.comment));
    }
    for (const id of req.actionIds) if (!proposal.actions.some((a) => a.action.id === id)) results.push({ actionId: id, type: "notify", status: "failed", message: "Unknown action id", auditId: proposal.auditId });
    return ApproveActionsResponseSchema.parse({ proposalId: proposal.id, results });
  }

  private async execute(ctx: RequestContext, proposal: StoredProposal, stored: StoredAction, comment?: string): Promise<ActionResult> {
    const { user, language } = ctx;
    const action = stored.action;
    const approved = await this.audit.record({ user, type: "action_approved", source: sourceOf(proposal), riskLevel: action.riskLevel, approvalStatus: "approved", approvedBy: user.email, correlationId: ctx.correlationId, details: { actionId: action.id, actionType: action.type, executionTarget: action.executionTarget, comment } });

    const finish = async (status: ActionResult["status"], message: string, clientInstruction?: ActionResult["clientInstruction"], auditType: "action_executed" | "action_failed" | "compliance_escalated" = "action_executed", approvalStatus: "approved" | "escalated" | "pending" = "approved") => {
      const ev = await this.audit.record({ user, type: auditType, source: sourceOf(proposal), riskLevel: action.riskLevel, approvalStatus, approvedBy: user.email, correlationId: ctx.correlationId, details: { actionId: action.id, actionType: action.type, status, message, clientInstruction: clientInstruction?.operation } });
      await this.deps.repos.actions.updateAction(action.id, status, message, ev.timestamp);
      return { actionId: action.id, type: action.type, status, message, clientInstruction, auditId: ev.id } satisfies ActionResult;
    };

    // 1. Compliance gate: escalate instead of executing.
    if (action.requiresComplianceApproval || action.type === "escalate_compliance" || action.type === "request_approval") {
      const escalation = await this.escalations.create(ctx, { reason: `${action.title}: ${action.explanation}`, actionId: action.id, issues: [] }, { audit: false });
      const msg = language === "fr" ? `Escaladé à la compliance (demande ${escalation.id})` : `Escalated to compliance (request ${escalation.id})`;
      return finish("pending_compliance", msg, undefined, "compliance_escalated", "escalated");
    }

    // 2. Informational actions.
    if (action.executionTarget === "none") {
      await this.deps.notifier.notify({ kind: action.type, title: action.title, message: action.explanation, userId: user.id, data: action.parameters });
      return finish("executed", language === "fr" ? "Notification enregistrée" : "Notification recorded");
    }

    // 3. Server-side via Graph, with client fallback.
    if (action.executionTarget === "server") {
      if (this.deps.graph.enabled && user.token) {
        try {
          const message = await this.executeViaGraph(user.token, action, proposal);
          return finish("executed", message);
        } catch (e) {
          if (!(e instanceof GraphDisabledError)) {
            this.deps.logger.warn({ err: (e as Error).message, action: action.type }, "graph execution failed, falling back to client");
            const ev = await this.audit.record({ user, type: "action_failed", source: sourceOf(proposal), riskLevel: action.riskLevel, approvalStatus: "approved", approvedBy: user.email, correlationId: ctx.correlationId, details: { actionId: action.id, actionType: action.type, error: (e as Error).message, fallback: "pending_client" } });
            void ev;
          }
        }
      }
      const instr = clientInstruction(action, language);
      return finish("pending_client", language === "fr" ? "À exécuter par le complément Outlook" : "To be executed by the Outlook add-in", instr);
    }

    // 4. Client-side.
    return finish("pending_client", language === "fr" ? "À exécuter par le complément Outlook" : "To be executed by the Outlook add-in", clientInstruction(action, language));
  }

  private async executeViaGraph(token: string, action: ProposedAction, proposal: StoredProposal): Promise<string> {
    const p = action.parameters;
    const emailId = String(p.emailId ?? proposal.emailId ?? "");
    const graph = this.deps.graph;
    switch (action.type) {
      case "create_task": {
        const r = await graph.createTodoTask(token, { title: String(p.title ?? action.title), dueDateTime: p.dueDate ? String(p.dueDate) : undefined, body: action.explanation });
        return `To Do task created (${r.id})`;
      }
      case "create_reminder": {
        const start = p.dueDate && !Number.isNaN(Date.parse(String(p.dueDate))) ? new Date(String(p.dueDate)) : new Date(Date.now() + 24 * 3600_000);
        const end = new Date(start.getTime() + 30 * 60_000);
        const r = await graph.createCalendarEvent(token, { subject: String(p.title ?? action.title), start: start.toISOString(), end: end.toISOString(), body: action.explanation });
        return `Calendar reminder created (${r.id})`;
      }
      case "archive":
        await graph.moveMessage(token, emailId, "archive");
        return "Message archived";
      case "move_to_folder":
        await graph.moveMessage(token, emailId, String(p.folder ?? p.destinationFolder ?? "archive"));
        return `Message moved to ${p.folder ?? p.destinationFolder ?? "archive"}`;
      case "categorize":
      case "classify_email":
        await graph.updateCategories(token, emailId, [String(p.category ?? "AI")]);
        return `Category "${p.category}" applied`;
      case "flag":
        await graph.flagMessage(token, emailId, true);
        return "Message flagged";
      default:
        throw new GraphDisabledError(`No server execution for ${action.type}`);
    }
  }

  /* ------------------------------- report ------------------------------ */

  async report(ctx: RequestContext, actionId: string, req: ReportActionResultRequest): Promise<ActionResult> {
    const stored = await this.deps.repos.actions.getAction(actionId);
    const proposal = stored ? await this.deps.repos.actions.getProposal(stored.proposalId) : undefined;
    if (!stored || !proposal || proposal.userId !== ctx.user.id) throw AppError.notFound("Action");
    const status: StoredAction["status"] = req.status === "cancelled" ? "cancelled" : req.status;
    const type = req.status === "executed" ? "action_executed" : req.status === "failed" ? "action_failed" : "action_rejected";
    const ev = await this.audit.record({ user: ctx.user, type, source: sourceOf(proposal), riskLevel: stored.action.riskLevel, approvalStatus: req.status === "cancelled" ? "rejected" : "approved", approvedBy: ctx.user.email, correlationId: ctx.correlationId, details: { actionId, actionType: stored.action.type, reportedBy: "client", message: req.message } });
    await this.deps.repos.actions.updateAction(actionId, status, req.message, ev.timestamp);
    return { actionId, type: stored.action.type, status: req.status === "cancelled" ? "rejected" : req.status, message: req.message, auditId: ev.id };
  }
}

const sourceOf = (p: StoredProposal) => ({ label: p.actions[0]?.action.source.label ?? "", emailId: p.emailId, conversationId: p.conversationId });
const sourceLabelOf = (e: EmailContext) => e.subject || "(no subject)";

/** Map an action to the Office.js operation the add-in must perform. */
export function clientInstruction(action: ProposedAction, lang: "fr" | "en"): { operation: ClientOperation; parameters: Record<string, unknown> } {
  const p = action.parameters;
  const map: Record<ActionType, () => { operation: ClientOperation; parameters: Record<string, unknown> }> = {
    draft_reply: () => ({ operation: "displayReplyForm", parameters: { intent: p.intent ?? "custom", instructions: p.instructions, body: p.body, subject: p.subject } }),
    request_document: () => ({ operation: "displayReplyForm", parameters: { intent: "request_info", instructions: p.instructions ?? (lang === "fr" ? "Demander le document manquant" : "Request the missing document"), document: p.document } }),
    categorize: () => ({ operation: "addCategory", parameters: { category: p.category ?? "AI" } }),
    classify_email: () => ({ operation: "addCategory", parameters: { category: p.category ?? "AI" } }),
    flag: () => ({ operation: "flag", parameters: {} }),
    create_reminder: () => ({ operation: "displayNewAppointmentForm", parameters: { subject: p.title ?? action.title, start: p.dueDate, body: action.explanation } }),
    create_task: () => ({ operation: "displayNewAppointmentForm", parameters: { subject: p.title ?? action.title, start: p.dueDate, body: action.explanation, asTask: true } }),
    archive: () => ({ operation: "openMoveDialog", parameters: { folder: "Archive" } }),
    move_to_folder: () => ({ operation: "openMoveDialog", parameters: { folder: p.folder ?? p.destinationFolder ?? "Archive" } }),
    apply_label: () => ({ operation: "applyLabel", parameters: { label: p.label ?? "Confidential" } }),
    remove_attachment: () => ({ operation: "removeAttachment", parameters: { attachmentIds: p.attachmentIds ?? [], attachmentNames: p.attachmentNames ?? [] } }),
    notify: () => ({ operation: "none", parameters: {} }),
    escalate_compliance: () => ({ operation: "none", parameters: {} }),
    request_approval: () => ({ operation: "none", parameters: {} }),
  };
  return map[action.type]();
}
