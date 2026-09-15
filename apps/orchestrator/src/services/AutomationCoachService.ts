import type { Automation, AutomationStep, AutomationTrigger, UserActionEvent } from "@oao/shared";
import { AutomationSchema, AutomationStepSchema, AutomationTriggerSchema } from "@oao/shared";
import { z } from "zod";
import { hasRole } from "../auth/identity.js";
import { automationFingerprint, detectAutomations } from "../domain/automation/detector.js";
import { simulateAutomation, type SimulationEmail } from "../domain/automation/simulation.js";
import { AppError } from "../errors.js";
import type { StoredAutomation } from "../ports/repositories.js";
import { newId, nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";

export const AutomationPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  trigger: AutomationTriggerSchema.optional(),
  steps: z.array(AutomationStepSchema).min(1).optional(),
  status: z.enum(["paused", "active"]).optional(),
});
export type AutomationPatch = z.infer<typeof AutomationPatchSchema>;

const DETECTION_WINDOW_DAYS = 30;

/** Automation Coach: observe → detect → simulate → approve / reject. */
export class AutomationCoachService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async observe(ctx: RequestContext, events: UserActionEvent[]): Promise<{ stored: number }> {
    const stored = events.map((e) => ({ ...e, id: newId(), userId: ctx.user.id }));
    await this.deps.repos.userActionEvents.append(stored);
    return { stored: stored.length };
  }

  async detect(ctx: RequestContext): Promise<Automation[]> {
    const since = new Date(Date.now() - DETECTION_WINDOW_DAYS * 86_400_000).toISOString();
    const events = await this.deps.repos.userActionEvents.listSince(ctx.user.id, since);
    const proposals = detectAutomations(events, { windowDays: DETECTION_WINDOW_DAYS, language: ctx.language });
    const out: Automation[] = [];
    for (const p of proposals) {
      const fingerprint = automationFingerprint(p.trigger, p.steps);
      const existing = await this.deps.repos.automations.findByFingerprint(ctx.user.id, fingerprint);
      const now = nowIso();
      if (existing) {
        // Refresh stats / confidence, keep the lifecycle status and user edits.
        const updated: StoredAutomation = { ...existing, stats: p.stats, confidence: p.confidence, updatedAt: now };
        await this.deps.repos.automations.save(updated);
        out.push(toPublic(updated));
        continue;
      }
      const created: StoredAutomation = { ...p, id: newId(), userId: ctx.user.id, fingerprint, createdAt: now, updatedAt: now };
      await this.deps.repos.automations.save(created);
      await this.audit.record({ user: ctx.user, type: "automation_proposed", riskLevel: created.riskLevel, approvalStatus: "pending", confidence: created.confidence, correlationId: ctx.correlationId, source: { label: created.name }, details: { automationId: created.id, trigger: created.trigger.conditions, steps: created.steps.map((s) => s.type), stats: created.stats } });
      out.push(toPublic(created));
    }
    return out;
  }

  async list(ctx: RequestContext, all = false): Promise<Automation[]> {
    const items = await this.deps.repos.automations.list(all && hasRole(ctx.user, "admin") ? undefined : ctx.user.id);
    return items.map(toPublic);
  }

  async get(ctx: RequestContext, id: string): Promise<Automation> {
    return toPublic(await this.load(ctx, id));
  }

  private async load(ctx: RequestContext, id: string): Promise<StoredAutomation> {
    const a = await this.deps.repos.automations.get(id);
    if (!a || (a.userId !== ctx.user.id && !hasRole(ctx.user, "admin"))) throw AppError.notFound("Automation");
    return a;
  }

  async simulate(ctx: RequestContext, id: string, sampleSize: number): Promise<Automation> {
    const a = await this.load(ctx, id);
    const c = a.trigger.conditions;
    // Sample = recent emails from the same sender (mixed attachments) + a few unrelated ones, so the checks are meaningful.
    const same = await this.deps.repos.emailIndex.listRecent(a.userId, { fromAddress: c.fromAddress, fromDomain: c.fromDomain }, sampleSize);
    const others = same.length < sampleSize ? await this.deps.repos.emailIndex.listRecent(a.userId, {}, sampleSize) : [];
    const seen = new Set<string>();
    const sample: SimulationEmail[] = [];
    for (const chunk of [...same, ...others]) {
      if (seen.has(chunk.emailId) || sample.length >= sampleSize) continue;
      seen.add(chunk.emailId);
      sample.push({ emailId: chunk.emailId, subject: chunk.subject, fromAddress: chunk.fromAddress, hasAttachments: chunk.hasAttachments, attachmentNames: chunk.attachmentNames });
    }
    const simulation = simulateAutomation(a, sample, ctx.language);
    a.lastSimulation = simulation;
    if (a.status === "proposed") a.status = "simulated";
    a.updatedAt = nowIso();
    await this.deps.repos.automations.save(a);
    await this.audit.record({ user: ctx.user, type: "automation_simulated", riskLevel: a.riskLevel, approvalStatus: "n/a", confidence: a.confidence, correlationId: ctx.correlationId, source: { label: a.name }, details: { automationId: a.id, sampleSize: simulation.sampleSize, wouldApply: simulation.results.filter((r) => r.wouldApply).length, checks: simulation.checks.map((k) => ({ name: k.name, passed: k.passed })) } });
    return toPublic(a);
  }

  async approve(ctx: RequestContext, id: string, comment?: string): Promise<Automation> {
    const a = await this.load(ctx, id);
    if (a.status === "rejected") throw AppError.conflict("Automation was rejected");
    if (!a.lastSimulation) {
      // Governance: automation = mandatory simulation before activation.
      throw AppError.conflict("Run a simulation before approving the automation");
    }
    a.status = "active"; // approved → active immediately (no scheduler needed: the add-in applies active rules)
    a.updatedAt = nowIso();
    await this.deps.repos.automations.save(a);
    await this.audit.record({ user: ctx.user, type: "automation_approved", riskLevel: a.riskLevel, approvalStatus: "approved", approvedBy: ctx.user.email, confidence: a.confidence, correlationId: ctx.correlationId, source: { label: a.name }, details: { automationId: a.id, comment, steps: a.steps.map((s) => s.type) } });
    return toPublic(a);
  }

  async reject(ctx: RequestContext, id: string, comment?: string): Promise<Automation> {
    const a = await this.load(ctx, id);
    a.status = "rejected";
    a.updatedAt = nowIso();
    await this.deps.repos.automations.save(a);
    await this.audit.record({ user: ctx.user, type: "automation_rejected", riskLevel: a.riskLevel, approvalStatus: "rejected", approvedBy: ctx.user.email, correlationId: ctx.correlationId, source: { label: a.name }, details: { automationId: a.id, comment } });
    return toPublic(a);
  }

  /** "Edit rule": trigger / steps / name; an edited rule must be simulated again before approval. */
  async update(ctx: RequestContext, id: string, patch: AutomationPatch): Promise<Automation> {
    const a = await this.load(ctx, id);
    if (patch.name) a.name = patch.name;
    if (patch.description !== undefined) a.description = patch.description;
    if (patch.trigger) a.trigger = patch.trigger as AutomationTrigger;
    if (patch.steps) a.steps = patch.steps as AutomationStep[];
    if (patch.trigger || patch.steps) {
      a.fingerprint = automationFingerprint(a.trigger, a.steps);
      a.lastSimulation = undefined;
      if (a.status === "active" || a.status === "approved" || a.status === "simulated") a.status = "proposed";
    }
    if (patch.status) a.status = patch.status;
    a.updatedAt = nowIso();
    await this.deps.repos.automations.save(a);
    return toPublic(a);
  }
}

const toPublic = (a: StoredAutomation): Automation => {
  const { userId: _u, fingerprint: _f, ...rest } = a;
  return AutomationSchema.parse(rest);
};
