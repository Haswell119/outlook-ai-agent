import type { AnalyzeThreadRequest, ThreadSynthesis } from "@oao/shared";
import { ThreadSynthesisSchema } from "@oao/shared";
import { threadCacheKey } from "../domain/cacheKey.js";
import { analyzeHeuristically } from "../domain/heuristics/email.js";
import { buildThreadSynthesisPrompt, ThreadSynthesisLlmSchema, type PromptStats, type ThreadSynthesisLlm } from "../domain/prompts/index.js";
import { nowIso } from "../util/ids.js";
import type { AiCacheService } from "./AiCacheService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";

interface ThreadPayload {
  data: ThreadSynthesisLlm;
  stats: PromptStats;
  degraded: boolean;
  repaired: boolean;
  error?: string;
  latencyMs: number;
  promptHashes: Record<string, unknown>;
}

/**
 * Thread synthesis. Same three savings as the email path: content-hash cache
 * (keyed on every message, so a thread is only re-synthesised when it actually
 * grew), coalescing, and a prompt where quoted history is deduplicated across
 * messages and old messages become a one-line digest.
 */
export class SynthesizeThreadService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly cache: AiCacheService,
  ) {}

  async synthesize(ctx: RequestContext, req: AnalyzeThreadRequest, opts: { priority?: "interactive" | "background" } = {}): Promise<ThreadSynthesis> {
    const { user, language, correlationId } = ctx;
    const thread = req.thread;
    const sorted = [...thread.messages].sort((a, b) => (a.receivedAt ?? a.sentAt ?? "").localeCompare(b.receivedAt ?? b.sentAt ?? ""));
    const budget = { maxChars: this.deps.cfg.LLM_INPUT_MAX_CHARS, threadMaxMessages: this.deps.cfg.THREAD_MAX_MESSAGES };
    const key = threadCacheKey({ subject: thread.subject, messages: sorted, language, promptVersion: this.deps.cfg.PROMPT_VERSION, maxChars: budget.maxChars });

    const cached = await this.cache.through<ThreadPayload>(user.id, "thread", key, { conversationId: thread.conversationId, emailId: sorted[sorted.length - 1]?.id }, async () => {
      const prompt = buildThreadSynthesisPrompt({ ...thread, messages: sorted }, language, budget);
      const result = await completeStructured(this.deps.llm, ThreadSynthesisLlmSchema, { ...prompt.request, userId: user.id, priority: opts.priority ?? "interactive" }, () => heuristicSynthesis(req, language), this.deps.logger);
      return {
        value: { data: result.data, stats: prompt.stats, degraded: result.degraded, repaired: result.repaired, error: result.error, latencyMs: result.latencyMs, promptHashes: this.audit.hashes(result.promptText, result.raw) },
        model: result.model,
        cacheable: !result.degraded,
        origin: result.degraded ? "heuristic" : "llm",
      };
    });

    const payload = cached.value;
    const d = payload.data;
    const risks = [...d.risks];
    if (payload.degraded) risks.push({ code: "ai_output_unreliable", title: language === "fr" ? "Synthèse IA dégradée" : "Degraded AI synthesis", severity: "medium", description: payload.error });
    const confidence = payload.degraded ? Math.min(d.confidence, DEGRADED_CONFIDENCE) : d.confidence;
    const last = sorted[sorted.length - 1];

    const event = await this.audit.record({
      user,
      type: "thread_synthesis_generated",
      source: { label: thread.subject || last?.subject || "(no subject)", emailId: last?.id, conversationId: thread.conversationId, counterpart: last?.from?.address },
      riskLevel: risks.some((r) => r.severity === "high") ? "high" : risks.length ? "medium" : "low",
      approvalStatus: "auto_approved",
      confidence,
      model: cached.model,
      latencyMs: cached.source === "llm" ? payload.latencyMs : 0,
      correlationId,
      details: {
        ...payload.promptHashes,
        cached: cached.source !== "llm",
        cacheSource: cached.source,
        coalesced: cached.coalesced,
        promptStats: { tokens: payload.stats.tokens, chars: payload.stats.chars, rawChars: payload.stats.rawChars, savedRatio: payload.stats.savedRatio, droppedMessages: payload.stats.droppedMessages },
        degraded: payload.degraded,
        repaired: payload.repaired,
        messages: sorted.length,
        analysis: { ...d, risks },
      },
    });
    if (payload.degraded && cached.source === "llm") await this.audit.record({ user, type: "error", source: { label: thread.subject, conversationId: thread.conversationId }, correlationId, details: { stage: "synthesize_thread", error: payload.error } });

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
      model: cached.model,
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
