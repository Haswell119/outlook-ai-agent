import type { ComplianceCheckRequest, ComplianceCheckResponse, PhishingCheckResponse, EmailContext } from "@oao/shared";
import { ComplianceCheckResponseSchema, PhishingCheckResponseSchema } from "@oao/shared";
import { assessPhishing } from "../domain/compliance/phishing.js";
import { evaluateCompliance } from "../domain/compliance/rules.js";
import { buildComplianceContentPrompt, ComplianceContentLlmSchema } from "../domain/prompts/index.js";
import { nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured } from "./llm-helpers.js";
import type { PolicyService } from "./PolicyService.js";

export class ComplianceService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
  ) {}

  async check(ctx: RequestContext, req: ComplianceCheckRequest): Promise<ComplianceCheckResponse> {
    const { user, language, correlationId } = ctx;
    const policy = await this.policy.get();
    const draft = req.draft;
    let evaluation = evaluateCompliance(draft, policy, { language });

    // LLM content analysis only when it matters (external recipients or attachments) and content exists.
    let llmModel: string | undefined;
    let llmUsed = false;
    if ((evaluation.facts.externalRecipients.length || draft.attachments.length) && (draft.body.trim().length > 20 || draft.attachments.some((a) => a.textContent))) {
      const prompt = buildComplianceContentPrompt(draft, evaluation.facts.externalRecipients, language);
      const r = await completeStructured(this.deps.llm, ComplianceContentLlmSchema, prompt, () => ({ sensitive: false, explanation: "", categories: [], confidence: 0 }), this.deps.logger);
      if (!r.degraded) {
        llmUsed = true;
        llmModel = r.model;
        evaluation = evaluateCompliance(draft, policy, { language, llmSensitive: { sensitive: r.data.sensitive, explanation: r.data.explanation, confidence: r.data.confidence } });
      }
    }

    const confidence = evaluation.issues.length === 0 ? 0.95 : llmUsed ? 0.9 : 0.85;
    const highest = evaluation.issues.some((i) => i.severity === "high") ? "high" : evaluation.issues.length ? "medium" : "low";
    const details = { issues: evaluation.issues.map((i) => ({ code: i.code, severity: i.severity, subject: i.subject })), verdict: evaluation.verdict, externalRecipients: evaluation.facts.externalRecipients, attachments: draft.attachments.map((a) => a.name), llmUsed, recommendedActions: evaluation.recommendedActions.map((a) => a.type) };
    const event = await this.audit.record({ user, type: "compliance_check", source: { label: draft.subject || "(draft)", emailId: draft.draftId, counterpart: draft.to[0]?.address }, riskLevel: highest, approvalStatus: evaluation.verdict === "block" ? "pending" : "auto_approved", confidence, model: llmModel, correlationId, details });
    if (evaluation.issues.length && highest !== "low") {
      await this.audit.record({ user, type: "compliance_alert", source: { label: draft.subject || "(draft)", emailId: draft.draftId, counterpart: draft.to[0]?.address }, riskLevel: highest, approvalStatus: evaluation.verdict === "block" ? "pending" : "n/a", confidence, correlationId, details: { ...details, checkAuditId: event.id } });
    }
    return ComplianceCheckResponseSchema.parse({ issues: evaluation.issues, recommendedActions: evaluation.recommendedActions, verdict: evaluation.verdict, confidence, auditId: event.id, checkedAt: nowIso() });
  }

  async phishing(ctx: RequestContext, email: EmailContext): Promise<PhishingCheckResponse> {
    const policy = await this.policy.get();
    const a = assessPhishing(email, { internalDomains: policy.internalDomains });
    const event = await this.audit.record({
      user: ctx.user,
      type: "phishing_check",
      source: { label: email.subject || "(no subject)", emailId: email.id, conversationId: email.conversationId, counterpart: email.from?.address },
      riskLevel: a.verdict === "likely_phishing" ? "high" : a.verdict === "suspicious" ? "medium" : "low",
      approvalStatus: "auto_approved",
      confidence: 1 - Math.abs(0.5 - a.score) * 0.4,
      correlationId: ctx.correlationId,
      details: { score: a.score, verdict: a.verdict, indicators: a.indicators.map((i) => i.code) },
    });
    return PhishingCheckResponseSchema.parse({ score: a.score, verdict: a.verdict, indicators: a.indicators, auditId: event.id });
  }
}
