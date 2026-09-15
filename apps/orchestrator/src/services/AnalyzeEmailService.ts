import type { AnalyzeEmailRequest, EmailAnalysis, EmailContext, SuggestedAction } from "@oao/shared";
import { EmailAnalysisSchema } from "@oao/shared";
import { assessPhishing } from "../domain/compliance/phishing.js";
import { analyzeHeuristically } from "../domain/heuristics/email.js";
import { buildEmailAnalysisPrompt, EmailAnalysisLlmSchema, type EmailAnalysisLlm } from "../domain/prompts/index.js";
import { nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";
import type { PolicyService } from "./PolicyService.js";

export class AnalyzeEmailService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
  ) {}

  async analyze(ctx: RequestContext, req: AnalyzeEmailRequest): Promise<EmailAnalysis> {
    const { user, language, correlationId } = ctx;
    const email = req.email;
    const policy = await this.policy.get();

    let thread: EmailContext[] | undefined;
    if (req.includeThread && email.conversationId && this.deps.graph.enabled && user.token) {
      try {
        thread = await this.deps.graph.getConversationMessages(user.token, email.conversationId);
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message }, "could not fetch conversation via Graph");
      }
    }

    const prompt = buildEmailAnalysisPrompt(email, language, thread);
    const result = await completeStructured(this.deps.llm, EmailAnalysisLlmSchema, prompt, () => toLlmShape(analyzeHeuristically(email, language, DEGRADED_CONFIDENCE)), this.deps.logger);
    const data = result.data;

    const phishing = assessPhishing(email, { internalDomains: policy.internalDomains });
    const risks = [...data.risks];
    if (result.degraded) risks.push({ code: "ai_output_unreliable", title: language === "fr" ? "Analyse IA dégradée (heuristiques)" : "Degraded AI analysis (heuristics only)", severity: "medium", description: result.error });
    if (phishing.verdict !== "clean") risks.unshift({ code: "phishing_suspected", title: language === "fr" ? "Indicateurs de phishing" : "Phishing indicators", severity: phishing.verdict === "likely_phishing" ? "high" : "medium", description: phishing.indicators.map((i) => i.description).join(" ") });

    const suggestedActions = mergeActions(data.suggestedActions, ruleActions(email, phishing.verdict, language));
    const confidence = result.degraded ? Math.min(data.confidence, DEGRADED_CONFIDENCE) : data.confidence;

    const auditEvent = await this.audit.record({
      user,
      type: "summary_generated",
      source: { label: email.subject || "(no subject)", emailId: email.id, conversationId: email.conversationId, counterpart: email.from?.address },
      riskLevel: phishing.verdict === "likely_phishing" ? "high" : risks.some((r) => r.severity === "high") ? "high" : risks.length ? "medium" : "low",
      approvalStatus: "auto_approved",
      confidence,
      model: result.model,
      latencyMs: result.latencyMs,
      correlationId,
      details: {
        ...this.audit.hashes(result.promptText, result.raw),
        degraded: result.degraded,
        repaired: result.repaired,
        includeThread: Boolean(thread),
        phishing,
        analysis: { language: data.language, summary: data.summary, decisions: data.decisions, pendingTasks: data.pendingTasks, risks, suggestedActions, quickReplies: data.quickReplies, classification: data.classification },
      },
    });
    if (result.degraded) await this.audit.record({ user, type: "error", source: { label: email.subject, emailId: email.id }, correlationId, details: { stage: "analyze_email", error: result.error } });

    return EmailAnalysisSchema.parse({
      emailId: email.id,
      language,
      summary: data.summary,
      decisions: data.decisions,
      pendingTasks: data.pendingTasks,
      risks,
      suggestedActions,
      quickReplies: data.quickReplies.slice(0, 4),
      classification: data.classification,
      confidence,
      phishing: { score: phishing.score, verdict: phishing.verdict, indicators: phishing.indicators.map((i) => i.description) },
      auditId: auditEvent.id,
      generatedAt: nowIso(),
      model: result.model,
    });
  }
}

function toLlmShape(h: ReturnType<typeof analyzeHeuristically>): EmailAnalysisLlm {
  return { language: h.language, summary: h.summary, decisions: h.decisions, pendingTasks: h.pendingTasks, risks: h.risks, suggestedActions: h.suggestedActions, quickReplies: h.quickReplies, classification: h.classification, confidence: h.confidence };
}

/** Rule-based suggestions merged with the model's (dedup by type, rules never override the model's title). */
export function mergeActions(fromModel: SuggestedAction[], fromRules: SuggestedAction[]): SuggestedAction[] {
  const seen = new Set<string>();
  const out: SuggestedAction[] = [];
  for (const a of [...fromModel, ...fromRules]) {
    if (seen.has(a.type)) continue;
    seen.add(a.type);
    out.push({ ...a, parameters: a.parameters ?? {} });
  }
  return out.slice(0, 6);
}

function ruleActions(email: EmailContext, phishingVerdict: "clean" | "suspicious" | "likely_phishing", lang: "fr" | "en"): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  if (phishingVerdict !== "clean") {
    actions.push({ type: "escalate_compliance", title: lang === "fr" ? "Signaler comme phishing potentiel" : "Report as potential phishing", description: lang === "fr" ? "Transmettre à la compliance / sécurité pour vérification" : "Route to compliance / security for verification", parameters: { reason: "phishing_suspected" } });
  }
  if (email.attachments.length && !phishingVerdict.includes("phishing")) {
    actions.push({ type: "flag", title: lang === "fr" ? "Marquer pour suivi" : "Flag for follow-up", description: lang === "fr" ? "Marquer l'email contenant des pièces jointes à traiter" : "Flag the email with attachments to process", parameters: {} });
  }
  return actions;
}
