import type { AnalyzeThreadRequest, ThreadSynthesis } from "@oao/shared";
import { ThreadSynthesisSchema } from "@oao/shared";
import { analyzeHeuristically } from "../domain/heuristics/email.js";
import { buildThreadSynthesisPrompt, ThreadSynthesisLlmSchema, type ThreadSynthesisLlm } from "../domain/prompts/index.js";
import { nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";

export class SynthesizeThreadService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async synthesize(ctx: RequestContext, req: AnalyzeThreadRequest): Promise<ThreadSynthesis> {
    const { user, language, correlationId } = ctx;
    const thread = req.thread;
    const sorted = [...thread.messages].sort((a, b) => (a.receivedAt ?? a.sentAt ?? "").localeCompare(b.receivedAt ?? b.sentAt ?? ""));
    const prompt = buildThreadSynthesisPrompt({ ...thread, messages: sorted }, language);
    const result = await completeStructured(this.deps.llm, ThreadSynthesisLlmSchema, prompt, () => heuristicSynthesis(req, language), this.deps.logger);
    const d = result.data;
    const risks = [...d.risks];
    if (result.degraded) risks.push({ code: "ai_output_unreliable", title: language === "fr" ? "Synthèse IA dégradée" : "Degraded AI synthesis", severity: "medium", description: result.error });
    const confidence = result.degraded ? Math.min(d.confidence, DEGRADED_CONFIDENCE) : d.confidence;
    const last = sorted[sorted.length - 1];

    const event = await this.audit.record({
      user,
      type: "thread_synthesis_generated",
      source: { label: thread.subject || last?.subject || "(no subject)", emailId: last?.id, conversationId: thread.conversationId, counterpart: last?.from?.address },
      riskLevel: risks.some((r) => r.severity === "high") ? "high" : risks.length ? "medium" : "low",
      approvalStatus: "auto_approved",
      confidence,
      model: result.model,
      latencyMs: result.latencyMs,
      correlationId,
      details: { ...this.audit.hashes(result.promptText, result.raw), degraded: result.degraded, repaired: result.repaired, messages: sorted.length, analysis: { ...d, risks } },
    });
    if (result.degraded) await this.audit.record({ user, type: "error", source: { label: thread.subject, conversationId: thread.conversationId }, correlationId, details: { stage: "synthesize_thread", error: result.error } });

    return ThreadSynthesisSchema.parse({
      conversationId: thread.conversationId,
      language,
      executiveSummary: d.executiveSummary,
      missingDocuments: d.missingDocuments,
      decisions: d.decisions,
      openTasks: d.openTasks,
      deadlines: d.deadlines,
      risks,
      recommendedActions: d.recommendedActions,
      recommendedNextStep: d.recommendedNextStep,
      sources: sorted.map((m) => ({ emailId: m.id, subject: m.subject, from: m.from?.name ?? m.from?.address, date: m.receivedAt ?? m.sentAt })),
      confidence,
      auditId: event.id,
      generatedAt: nowIso(),
      model: result.model,
    });
  }
}

function heuristicSynthesis(req: AnalyzeThreadRequest, language: "fr" | "en"): ThreadSynthesisLlm {
  const msgs = req.thread.messages;
  const combined = { ...msgs[msgs.length - 1]!, subject: req.thread.subject, body: msgs.map((m) => `${m.from?.name ?? m.from?.address ?? ""}: ${m.body}`).join("\n\n") };
  const h = analyzeHeuristically(combined, language, DEGRADED_CONFIDENCE);
  return {
    language,
    executiveSummary: h.summary,
    missingDocuments: h.signals.missingDocument ? [{ name: language === "fr" ? "Document en attente" : "Outstanding document" }] : [],
    decisions: h.decisions,
    openTasks: h.pendingTasks.map((t, i) => ({ title: t, priority: i === 0 ? "high" : "medium", done: false, critical: i === 0 })),
    deadlines: h.signals.dates.slice(0, 2).map((d) => ({ title: d, date: d, atRisk: h.signals.urgent })),
    risks: h.risks,
    recommendedActions: h.suggestedActions,
    recommendedNextStep: h.suggestedActions[0] ? { title: h.suggestedActions[0].title, description: h.suggestedActions[0].description, action: h.suggestedActions[0] } : undefined,
    confidence: DEGRADED_CONFIDENCE,
  };
}
