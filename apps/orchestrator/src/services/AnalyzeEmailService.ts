import type { AnalyzeEmailRequest, EmailAnalysis, EmailContext, SuggestedAction } from "@oao/shared";
import { EmailAnalysisSchema } from "@oao/shared";
import { analysisCacheKey } from "../domain/cacheKey.js";
import { assessPhishing } from "../domain/compliance/phishing.js";
import { analyzeHeuristically } from "../domain/heuristics/email.js";
import { buildEmailAnalysisPrompt, EmailAnalysisLlmSchema, type EmailAnalysisLlm, type PromptStats } from "../domain/prompts/index.js";
import { triageAnalysis, triageEmail, type TriageResult } from "../domain/triage.js";
import { AppError } from "../errors.js";
import type { Metrics } from "../metrics.js";
import { nowIso } from "../util/ids.js";
import type { AiCacheService } from "./AiCacheService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";
import type { PolicyService } from "./PolicyService.js";

/**
 * Email analysis — the busiest AI path, and therefore where the load is won.
 *
 * Decision order, cheapest first:
 *  1. **Triage** (`TRIAGE_ENABLED`): a newsletter / notification / out-of-office /
 *     calendar item / trivial "thanks" gets a heuristic answer, `source: "heuristic"`,
 *     and **no model call at all**. On a real mailbox this is 40–60 % of inbound.
 *  2. **Cache / precomputation**: the content hash is looked up; a hit returns
 *     `source: "cache"` (on-demand) or `source: "precomputed"` (sync worker).
 *  3. **Coalescing**: identical concurrent requests share one call.
 *  4. Otherwise the model is called with a slimmed prompt.
 *
 * Whatever the path, an `AuditEvent` is written — including for cache hits
 * (`details.cached = true`). The audit trail is non-negotiable.
 */
export class AnalyzeEmailService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly cache: AiCacheService,
    private readonly metrics?: Metrics,
  ) {}

  private get budget() {
    return { maxChars: this.deps.cfg.LLM_INPUT_MAX_CHARS, threadMaxMessages: this.deps.cfg.THREAD_MAX_MESSAGES };
  }

  async analyze(ctx: RequestContext, req: AnalyzeEmailRequest, opts: { priority?: "interactive" | "background" } = {}): Promise<EmailAnalysis> {
    const { user, language, correlationId } = ctx;
    const email = req.email;
    const policy = await this.policy.get();
    const priority = opts.priority ?? "interactive";

    /* ---------------------------- 1. triage ---------------------------- */
    const triaged = this.deps.cfg.TRIAGE_ENABLED ? triageEmail(email, { internalDomains: policy.internalDomains }) : ({ kind: "conversation", reason: "triage_disabled", confidence: 0.5, skipModel: false } satisfies TriageResult);
    // `force` = the user explicitly asked for the model: the triage verdict is
    // kept for information, but it no longer short-circuits the analysis.
    const triage: TriageResult = req.force && triaged.skipModel ? { ...triaged, skipModel: false, reason: `${triaged.reason};forced` } : triaged;
    this.metrics?.triage.inc({ kind: triage.kind, skipped: String(triage.skipModel) });

    if (triage.skipModel) {
      this.metrics?.modelCallsSaved.inc({ reason: "triage" });
      return this.heuristicAnswer(ctx, email, triage, policy.internalDomains, priority);
    }

    /* ------------------- 2. thread context (optional) ------------------- */
    let thread: EmailContext[] | undefined;
    if (req.includeThread && email.conversationId && this.deps.graph.enabled && user.token) {
      try {
        thread = await this.deps.graph.getConversationMessages(user.token, email.conversationId);
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message }, "could not fetch conversation via Graph");
      }
    }

    /* ------------------ 3. cache / coalesce / model -------------------- */
    const key = analysisCacheKey({
      email,
      language,
      promptVersion: this.deps.cfg.PROMPT_VERSION,
      variant: thread ? `thread:${thread.length}` : undefined,
      maxChars: this.deps.cfg.LLM_INPUT_MAX_CHARS,
    });

    // No `emailId` on purpose: this entry holds the raw model payload, not a
    // finished `EmailAnalysis`, so it must never be picked up by
    // `getByEmail` (which feeds `GET /analyze/email/:id` and the daily brief).
    const cached = await this.cache.through<AnalysisPayload>(user.id, "analysis", key, { conversationId: email.conversationId, bypass: req.force }, async () => {
      const prompt = buildEmailAnalysisPrompt(email, language, thread, this.budget);
      const result = await completeStructured(this.deps.llm, EmailAnalysisLlmSchema, { ...prompt.request, userId: user.id, priority }, () => toLlmShape(analyzeHeuristically(email, language, DEGRADED_CONFIDENCE)), this.deps.logger);
      return {
        value: { data: result.data, stats: prompt.stats, degraded: result.degraded, repaired: result.repaired, error: result.error, latencyMs: result.latencyMs, promptHashes: this.audit.hashes(result.promptText, result.raw) },
        model: result.model,
        // A degraded (heuristic fallback) answer must not poison the cache: it would
        // be served for a week after a 30-second model outage.
        cacheable: !result.degraded,
        origin: result.degraded ? "heuristic" : "llm",
      };
    });

    const payload = cached.value;
    const data = payload.data;
    const source: NonNullable<EmailAnalysis["source"]> = cached.source === "llm" ? (payload.degraded ? "heuristic" : "llm") : cached.source;

    /* ----------------------- 4. enrich + audit ------------------------- */
    const phishing = assessPhishing(email, { internalDomains: policy.internalDomains });
    const risks = [...data.risks];
    if (payload.degraded) risks.push({ code: "ai_output_unreliable", title: language === "fr" ? "Analyse IA dégradée (heuristiques)" : "Degraded AI analysis (heuristics only)", severity: "medium", description: payload.error });
    if (phishing.verdict !== "clean") risks.unshift({ code: "phishing_suspected", title: language === "fr" ? "Indicateurs de phishing" : "Phishing indicators", severity: phishing.verdict === "likely_phishing" ? "high" : "medium", description: phishing.indicators.map((i) => i.description).join(" ") });

    const suggestedActions = mergeActions(data.suggestedActions, ruleActions(email, phishing.verdict, language));
    const confidence = payload.degraded ? Math.min(data.confidence, DEGRADED_CONFIDENCE) : data.confidence;

    const auditEvent = await this.audit.record({
      user,
      type: "summary_generated",
      source: { label: email.subject || "(no subject)", emailId: email.id, conversationId: email.conversationId, counterpart: email.from?.address },
      riskLevel: phishing.verdict === "likely_phishing" ? "high" : risks.some((r) => r.severity === "high") ? "high" : risks.length ? "medium" : "low",
      approvalStatus: "auto_approved",
      confidence,
      model: cached.model,
      latencyMs: cached.source === "llm" ? payload.latencyMs : 0,
      correlationId,
      details: {
        ...payload.promptHashes,
        cached: cached.source !== "llm",
        cacheSource: cached.source,
        cacheAgeMs: cached.ageMs,
        coalesced: cached.coalesced,
        analysisSource: source,
        triage: { kind: triage.kind, reason: triage.reason },
        promptStats: promptTelemetry(payload.stats),
        degraded: payload.degraded,
        repaired: payload.repaired,
        includeThread: Boolean(thread),
        phishing,
        analysis: { language: data.language, summary: data.summary, decisions: data.decisions, pendingTasks: data.pendingTasks, risks, suggestedActions, quickReplies: data.quickReplies, classification: data.classification },
      },
    });
    if (payload.degraded && cached.source === "llm") await this.audit.record({ user, type: "error", source: { label: email.subject, emailId: email.id }, correlationId, details: { stage: "analyze_email", error: payload.error } });

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
      model: cached.model,
      source,
      triage: { kind: triage.kind, reason: triage.reason },
    });
  }

  /** Heuristic-only answer for a triaged email — zero model calls, still audited. */
  private async heuristicAnswer(ctx: RequestContext, email: EmailContext, triage: TriageResult, internalDomains: string[], priority: string): Promise<EmailAnalysis> {
    const { user, language, correlationId } = ctx;
    const h = triageAnalysis(email, triage, language);
    const phishing = assessPhishing(email, { internalDomains });
    const risks = [...h.risks];
    if (phishing.verdict !== "clean") risks.unshift({ code: "phishing_suspected", title: language === "fr" ? "Indicateurs de phishing" : "Phishing indicators", severity: phishing.verdict === "likely_phishing" ? "high" : "medium", description: phishing.indicators.map((i) => i.description).join(" ") });

    const event = await this.audit.record({
      user,
      type: "summary_generated",
      source: { label: email.subject || "(no subject)", emailId: email.id, conversationId: email.conversationId, counterpart: email.from?.address },
      riskLevel: phishing.verdict === "likely_phishing" ? "high" : risks.some((r) => r.severity === "high") ? "high" : risks.length ? "medium" : "low",
      approvalStatus: "auto_approved",
      confidence: h.confidence,
      model: "heuristic-triage",
      latencyMs: 0,
      correlationId,
      details: {
        cached: false,
        analysisSource: "heuristic",
        modelCallSkipped: true,
        priority,
        triage: { kind: triage.kind, reason: triage.reason, confidence: triage.confidence },
        promptStats: { tokens: 0, chars: 0, savedRatio: 1 },
        phishing,
        analysis: { language: h.language, summary: h.summary, decisions: h.decisions, pendingTasks: h.pendingTasks, risks, suggestedActions: h.suggestedActions, quickReplies: h.quickReplies, classification: h.classification },
      },
    });

    return EmailAnalysisSchema.parse({
      emailId: email.id,
      language,
      summary: h.summary,
      decisions: h.decisions,
      pendingTasks: h.pendingTasks,
      risks,
      suggestedActions: h.suggestedActions,
      quickReplies: h.quickReplies,
      classification: h.classification,
      confidence: h.confidence,
      phishing: { score: phishing.score, verdict: phishing.verdict, indicators: phishing.indicators.map((i) => i.description) },
      auditId: event.id,
      generatedAt: nowIso(),
      model: "heuristic-triage",
      source: "heuristic",
      triage: { kind: triage.kind, reason: triage.reason },
    });
  }

  /**
   * `GET /analyze/email/:id` — the precomputed / cached analysis of a known email.
   * 404 when nothing was computed yet: the add-in then POSTs `/analyze/email`
   * with the content it already has. This endpoint never calls the model.
   */
  async getStored(ctx: RequestContext, emailId: string): Promise<EmailAnalysis> {
    const entry = await this.cache.byEmail<AnalysisPayload | EmailAnalysis>(ctx.user.id, emailId);
    if (!entry) throw AppError.notFound("Analysis for this email");
    const stored = entry.value as EmailAnalysis & { data?: unknown };
    // Entries written by the worker already hold a full EmailAnalysis; entries
    // written by the on-demand path hold the raw model payload, which cannot be
    // replayed without re-running the enrichment, so they are not served here.
    if (!("summary" in stored) || stored.data) throw AppError.notFound("Analysis for this email");

    const analysis = EmailAnalysisSchema.parse({ ...stored, source: entry.origin === "precomputed" ? "precomputed" : "cache" });
    await this.audit.record({
      user: ctx.user,
      type: "summary_generated",
      source: { label: analysis.summary.slice(0, 80), emailId, conversationId: entry.conversationId },
      approvalStatus: "auto_approved",
      confidence: analysis.confidence,
      model: entry.model,
      latencyMs: 0,
      correlationId: ctx.correlationId,
      details: { cached: true, cacheSource: analysis.source, analysisSource: analysis.source, served: "analysisByEmail", cacheAgeMs: Math.max(0, Date.now() - Date.parse(entry.createdAt)) },
    });
    this.metrics?.modelCallsSaved.inc({ reason: "precomputed" });
    return analysis;
  }

  /** Store a fully-built analysis (used by the precompute worker). */
  async storePrecomputed(userId: string, analysis: EmailAnalysis, conversationId?: string): Promise<void> {
    await this.cache.store(userId, "analysis", `email:${analysis.emailId}`, analysis, { emailId: analysis.emailId, conversationId }, analysis.model, "precomputed");
  }
}

interface AnalysisPayload {
  data: EmailAnalysisLlm;
  stats: PromptStats;
  degraded: boolean;
  repaired: boolean;
  error?: string;
  latencyMs: number;
  promptHashes: Record<string, unknown>;
}

const promptTelemetry = (s: PromptStats) => ({ tokens: s.tokens, chars: s.chars, rawChars: s.rawChars, savedRatio: s.savedRatio, droppedMessages: s.droppedMessages });

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
