import type { Escalation } from "@oao/shared";
import { EscalationSchema } from "@oao/shared";
import { hasRole } from "../auth/identity.js";
import { AppError } from "../errors.js";
import type { StoredEscalation } from "../ports/repositories.js";
import { newId, nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";

export interface EscalationInput {
  reason: string;
  draft?: unknown;
  actionId?: string;
  issues?: Escalation["issues"];
}

export class EscalationService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async create(ctx: RequestContext, input: EscalationInput, opts: { audit?: boolean } = {}): Promise<Escalation> {
    const e: StoredEscalation = { id: newId(), userId: ctx.user.id, status: "pending", requestedBy: ctx.user.email, requestedAt: nowIso(), reason: input.reason, issues: input.issues ?? [], actionId: input.actionId, draft: input.draft };
    await this.deps.repos.escalations.create(e);
    if (opts.audit !== false) {
      await this.audit.record({ user: ctx.user, type: "compliance_escalated", riskLevel: "high", approvalStatus: "escalated", correlationId: ctx.correlationId, source: input.draft && typeof input.draft === "object" && "subject" in input.draft ? { label: String((input.draft as { subject?: string }).subject ?? "") } : undefined, details: { escalationId: e.id, reason: e.reason, issues: e.issues, actionId: e.actionId } });
    }
    void this.deps.notifier.notify({ kind: "compliance_escalated", title: "Compliance escalation", message: e.reason, userId: ctx.user.id, data: { escalationId: e.id } });
    return toPublic(e);
  }

  async list(ctx: RequestContext, status?: Escalation["status"]): Promise<Escalation[]> {
    const all = hasRole(ctx.user, "compliance") || hasRole(ctx.user, "admin");
    const items = await this.deps.repos.escalations.list({ userId: all ? undefined : ctx.user.id, status });
    return items.map(toPublic);
  }

  async get(ctx: RequestContext, id: string): Promise<Escalation> {
    const e = await this.deps.repos.escalations.get(id);
    if (!e || (e.userId !== ctx.user.id && !hasRole(ctx.user, "compliance") && !hasRole(ctx.user, "admin"))) throw AppError.notFound("Escalation");
    return toPublic(e);
  }

  async decide(ctx: RequestContext, id: string, decision: "approved" | "rejected", comment?: string): Promise<Escalation> {
    const e = await this.deps.repos.escalations.get(id);
    if (!e) throw AppError.notFound("Escalation");
    if (e.status !== "pending") throw AppError.conflict(`Escalation already ${e.status}`);
    e.status = decision;
    e.decidedBy = ctx.user.email;
    e.decidedAt = nowIso();
    e.decisionComment = comment;
    await this.deps.repos.escalations.update(e);
    if (e.actionId) {
      await this.deps.repos.actions.updateAction(e.actionId, decision === "approved" ? "executed" : "rejected", `Compliance ${decision} by ${ctx.user.email}`, e.decidedAt);
    }
    await this.audit.record({ user: ctx.user, type: "compliance_decision", riskLevel: "high", approvalStatus: decision, approvedBy: ctx.user.email, correlationId: ctx.correlationId, details: { escalationId: e.id, decision, comment, requestedBy: e.requestedBy, actionId: e.actionId } });
    return toPublic(e);
  }
}

const toPublic = (e: StoredEscalation): Escalation => EscalationSchema.parse({ id: e.id, status: e.status, requestedBy: e.requestedBy, requestedAt: e.requestedAt, reason: e.reason, decidedBy: e.decidedBy, decidedAt: e.decidedAt, decisionComment: e.decisionComment, issues: e.issues });
