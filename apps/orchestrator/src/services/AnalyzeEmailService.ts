import type { AnalyzeEmailRequest, EmailAnalysis, EmailContext, EmailDecisioning, Language, SuggestedAction } from "@oao/shared";
import { EmailAnalysisSchema } from "@oao/shared";
import { analysisCacheKey } from "../domain/cacheKey.js";
import { assessPhishing } from "../domain/compliance/phishing.js";
import type { ShadowComparison } from "../domain/decisions/shadow.js";
import { analyzeHeuristically } from "../domain/heuristics/email.js";
import {
  buildEmailAnalysisPrompt,
  buildEmailNarrativePrompt,
  EmailAnalysisLlmSchema,
  EmailNarrativeLlmSchema,
  FILING_ACTION_TYPES,
  type EmailAnalysisLlm,
  type NarrativeDecisions,
  type PromptStats,
} from "../domain/prompts/index.js";
import { triageAnalysis, triageEmail, type TriageResult } from "../domain/triage.js";
import { AppError } from "../errors.js";
import type { Metrics } from "../metrics.js";
import { nowIso } from "../util/ids.js";
import type { AiCacheService } from "./AiCacheService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import type { DecideInput, DecisionOutcome, EmailDecisionService } from "./EmailDecisionService.js";
import type { IndexEmailsService } from "./IndexEmailsService.js";
import { completeStructured, DEGRADED_CONFIDENCE, type StructuredResult } from "./llm-helpers.js";
import type { PolicyService } from "./PolicyService.js";

/** Longest a shadow decision may outlive the model call before it is abandoned: shadow mode never delays an answer. */
export const SHADOW_GRACE_MS = 250;

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
 * Structured decisions (`DECISION_PROVIDER`, docs/LAYA.md), on a cache miss only:
 *  - `disabled` (default): the historic path above, byte for byte;
 *  - `shadow`: the engine is consulted *alongside* the model call (bounded by
 *    `SHADOW_GRACE_MS` after it), audited and compared, never shown;
 *  - `active`: the engine answers *first*; a reliable decision switches the
 *    model to the reduced narrative prompt (no classification asked), fills
 *    `classification` / `decisioning` and may add a deterministic
 *    `move_to_folder` *suggestion*; an unusable decision falls back to the
 *    historic prompt (`LAYA_FALLBACK_TO_LLM=true`) or to no classification.
 * A triaged email or a cache hit calls neither the engine nor the model.
 *
 * Whatever the path, an `AuditEvent` is written — including for cache hits
 * (`details.cached = true`). The audit trail is non-negotiable.
 *
 * Side effect (`INDEX_ON_ANALYZE`, default on): every analysed email is also
 * indexed, once. Without Microsoft Graph nothing else feeds the index, so the
 * chat's "all emails" scope would otherwise only ever know the opened email.
 */
export class AnalyzeEmailService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly cache: AiCacheService,
    private readonly metrics?: Metrics,
    private readonly indexer?: IndexEmailsService,
    private readonly decisions?: EmailDecisionService,
  ) {}

  private get budget() {
    return { maxChars: this.deps.cfg.LLM_INPUT_MAX_CHARS, threadMaxMessages: this.deps.cfg.THREAD_MAX_MESSAGES };
  }

  async analyze(ctx: RequestContext, req: AnalyzeEmailRequest, opts: { priority?: "interactive" | "background" } = {}): Promise<EmailAnalysis> {
    const analysis = await this.compute(ctx, req, opts);
    // After the answer is known, never before: a slow embedding endpoint must
    // not delay the summary, and an index failure must not fail it.
    if (this.indexer && this.deps.cfg.INDEX_ON_ANALYZE) {
      const indexed = await this.indexer.ensureIndexed(ctx, req.email);
      if (indexed) this.metrics?.autoIndexed?.inc();
    }
    return analysis;
  }

  private async compute(ctx: RequestContext, req: AnalyzeEmailRequest, opts: { priority?: "interactive" | "background" }): Promise<EmailAnalysis> {
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

    // Only a decision engine that is switched on can be "saved" a call.
    const decider = this.decisions?.enabled ? this.decisions : undefined;

    if (triage.skipModel) {
      this.metrics?.modelCallsSaved.inc({ reason: "triage" });
      decider?.recordSaved("triage");
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
      // Undefined when decisions are disabled: the historic keys are unchanged.
      decision: decider?.cacheFingerprint(),
    });
    // Pure and cheap; computed before the model so the decision state can carry the verdict.
    const phishing = assessPhishing(email, { internalDomains: policy.internalDomains });
    const consult = decider?.shouldEvaluate(key) ?? false;

    // No `emailId` on purpose: this entry holds the raw model payload, not a
    // finished `EmailAnalysis`, so it must never be picked up by
    // `getByEmail` (which feeds `GET /analyze/email/:id` and the daily brief).
    const cached = await this.cache.through<AnalysisPayload>(user.id, "analysis", key, { conversationId: email.conversationId, bypass: req.force }, async () => {
      if (!decider) {
        const result = await this.fullCompletion(email, language, thread, user.id, priority);
        return {
          value: { data: result.data, stats: result.stats, degraded: result.degraded, repaired: result.repaired, error: result.error, latencyMs: result.latencyMs, promptHashes: this.audit.hashes(result.promptText, result.raw) },
          model: result.model,
          // A degraded (heuristic fallback) answer must not poison the cache: it would
          // be served for a week after a 30-second model outage.
          cacheable: !result.degraded,
          origin: result.degraded ? "heuristic" : "llm",
        };
      }

      const decideInput: DecideInput = { email, readerLanguage: language, internalDomains: policy.internalDomains, triageKind: triage.kind, phishingVerdict: phishing.verdict, thread, correlationId, priority };
      // Active: the decision chooses the prompt, so it runs first.
      const active = consult && decider.mode === "active" ? await decider.decide(decideInput) : undefined;
      const plan = decider.plan(active);
      const narrative = plan.promptPath === "narrative" && active !== undefined;
      // Shadow: alongside the model call, abandoned SHADOW_GRACE_MS after it — it can neither delay nor change the answer.
      const shadowAbort = new AbortController();
      const shadowPromise = consult && decider.mode === "shadow" ? decider.decide({ ...decideInput, signal: shadowAbort.signal }) : undefined;
      const result = narrative ? await this.narrativeCompletion(email, language, thread, active, user.id, priority) : await this.fullCompletion(email, language, thread, user.id, priority);
      const shadow = shadowPromise ? await settleShadow(shadowPromise, shadowAbort) : undefined;

      const decisioning = active ? decider.toDecisioning(active, plan, result.degraded) : undefined;
      const shadowComparison = shadow && !result.degraded ? decider.compareShadow(shadow, result.data) : undefined;
      if (active && plan.fallbackReason) decider.recordFallback(plan.fallbackReason);
      const decision = active ?? shadow;
      return {
        value: {
          data: result.data,
          stats: result.stats,
          degraded: result.degraded,
          repaired: result.repaired,
          error: result.error,
          latencyMs: result.latencyMs,
          promptHashes: this.audit.hashes(result.promptText, result.raw),
          promptPath: narrative ? "narrative" : "full",
          ...(decision ? { decision: decider.auditRecord(decision) } : {}),
          ...(decisioning ? { decisioning } : {}),
          ...(shadowComparison ? { shadowComparison } : {}),
        },
        model: result.model,
        // Neither a degraded model answer nor a degraded decision (engine outage)
        // may be served from the cache for a week after the outage.
        cacheable: !result.degraded && !decisioning?.degraded,
        origin: result.degraded ? "heuristic" : "llm",
      };
    });

    const payload = cached.value;
    const data = payload.data;
    const source: NonNullable<EmailAnalysis["source"]> = cached.source === "llm" ? (payload.degraded ? "heuristic" : "llm") : cached.source;
    if (consult && cached.source !== "llm") decider?.recordSaved("cache");
    else if (consult && cached.coalesced) decider?.recordSaved("coalesced");

    /* ----------------------- 4. enrich + audit ------------------------- */
    const decisioning = payload.decisioning;
    const narrative = payload.promptPath === "narrative";
    // Narrative path: the engine owns the classification (the model was not asked for one).
    const classification = narrative ? classificationFrom(decisioning) : data.classification;
    const move = decisioning ? decider?.moveAction(decisioning, language, phishing.verdict) : undefined;
    const risks = [...data.risks];
    if (payload.degraded) risks.push({ code: "ai_output_unreliable", title: language === "fr" ? "Analyse IA dégradée (heuristiques)" : "Degraded AI analysis (heuristics only)", severity: "medium", description: payload.error });
    if (phishing.verdict !== "clean") risks.unshift({ code: "phishing_suspected", title: language === "fr" ? "Indicateurs de phishing" : "Phishing indicators", severity: phishing.verdict === "likely_phishing" ? "high" : "medium", description: phishing.indicators.map((i) => i.description).join(" ") });

    const suggestedActions = mergeActions(data.suggestedActions, [...(move ? [move] : []), ...ruleActions(email, phishing.verdict, language)]);
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
        ...(decider ? { decision: this.decisionAudit(payload, consult, decisioning) } : {}),
        analysis: { language: data.language, summary: data.summary, decisions: data.decisions, pendingTasks: data.pendingTasks, risks, suggestedActions, quickReplies: data.quickReplies, classification, ...(decisioning ? { decisioning } : {}) },
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
      classification,
      confidence,
      phishing: { score: phishing.score, verdict: phishing.verdict, indicators: phishing.indicators.map((i) => i.description) },
      auditId: auditEvent.id,
      generatedAt: nowIso(),
      model: cached.model,
      source,
      triage: { kind: triage.kind, reason: triage.reason },
      ...(decisioning ? { decisioning } : {}),
    });
  }

  /* ----------------------------- model calls ----------------------------- */

  /** Historic prompt: the model also classifies. */
  private async fullCompletion(email: EmailContext, language: Language, thread: EmailContext[] | undefined, userId: string, priority: "interactive" | "background"): Promise<Completion> {
    const prompt = buildEmailAnalysisPrompt(email, language, thread, this.budget);
    const result = await completeStructured(this.deps.llm, EmailAnalysisLlmSchema, { ...prompt.request, userId, priority }, () => toLlmShape(analyzeHeuristically(email, language, DEGRADED_CONFIDENCE)), this.deps.logger);
    return { ...result, stats: prompt.stats };
  }

  /** Reduced prompt: the engine already decided; the model only writes (no classification asked, none kept). */
  private async narrativeCompletion(email: EmailContext, language: Language, thread: EmailContext[] | undefined, outcome: DecisionOutcome, userId: string, priority: "interactive" | "background"): Promise<Completion> {
    const prompt = buildEmailNarrativePrompt(email, language, narrativeDecisions(outcome), thread, this.budget);
    const result = await completeStructured(this.deps.llm, EmailNarrativeLlmSchema, { ...prompt.request, userId, priority }, () => toNarrativeShape(analyzeHeuristically(email, language, DEGRADED_CONFIDENCE)), this.deps.logger);
    return { ...result, data: { ...result.data, classification: undefined }, stats: prompt.stats };
  }

  /** Audit block of the decision engine — hashes, choices, confidences, versions; never content. */
  private decisionAudit(payload: AnalysisPayload, consulted: boolean, decisioning: EmailDecisioning | undefined): Record<string, unknown> {
    const d = this.decisions!;
    return {
      ...(payload.decision ?? {}),
      consulted,
      mode: d.mode,
      provider: d.settings.provider,
      source: decisioning?.source ?? (d.mode === "shadow" ? "laya_shadow" : undefined),
      promptPath: payload.promptPath ?? "full",
      fallbackReason: decisioning?.fallbackReason,
      circuit: d.circuitState,
      ...(payload.shadowComparison ? { shadowComparison: payload.shadowComparison } : {}),
    };
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
  /* Structured decisions — only present when DECISION_PROVIDER is enabled. */
  promptPath?: "narrative" | "full";
  /** Audit projection of the engine outcome (active or shadow). */
  decision?: Record<string, unknown>;
  /** Public block (active mode only). */
  decisioning?: EmailDecisioning;
  shadowComparison?: ShadowComparison;
}

type Completion = StructuredResult<EmailAnalysisLlm> & { stats: PromptStats };

/**
 * Wait for the shadow decision at most `graceMs` after the model answered,
 * then abandon it (the call is aborted; `decide` resolves as failed/aborted).
 */
async function settleShadow(promise: Promise<DecisionOutcome>, controller: AbortController, graceMs = SHADOW_GRACE_MS): Promise<DecisionOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), graceMs);
    timer.unref?.();
  });
  const first = await Promise.race([promise, grace]);
  clearTimeout(timer);
  if (first) return first;
  controller.abort();
  return promise;
}

/** Decisions shown to the model in the narrative prompt (accepted ones only). */
function narrativeDecisions(o: DecisionOutcome): NarrativeDecisions {
  return { urgency: o.urgency?.level, businessArea: o.businessArea?.label, suggestedFolder: o.suggestedFolder?.displayName, replyExpected: o.replyExpected?.value, actionRequired: o.actionRequired?.value };
}

/** Public `classification` in the narrative path: the folder when decided, else the area; none without an area. */
function classificationFrom(d: EmailDecisioning | undefined): EmailAnalysis["classification"] {
  if (!d?.businessArea) return undefined;
  return d.suggestedFolder ? { category: d.suggestedFolder.displayName, confidence: d.suggestedFolder.confidence } : { category: d.businessArea.label, confidence: d.businessArea.confidence };
}

const promptTelemetry = (s: PromptStats) => ({ tokens: s.tokens, chars: s.chars, rawChars: s.rawChars, savedRatio: s.savedRatio, droppedMessages: s.droppedMessages });

function toLlmShape(h: ReturnType<typeof analyzeHeuristically>): EmailAnalysisLlm {
  return { language: h.language, summary: h.summary, decisions: h.decisions, pendingTasks: h.pendingTasks, risks: h.risks, suggestedActions: h.suggestedActions, quickReplies: h.quickReplies, classification: h.classification, confidence: h.confidence };
}

/** Heuristic fallback of the narrative path: no classification, no filing action (the engine owns them). */
function toNarrativeShape(h: ReturnType<typeof analyzeHeuristically>) {
  return { language: h.language, summary: h.summary, decisions: h.decisions, pendingTasks: h.pendingTasks, risks: h.risks, suggestedActions: h.suggestedActions.filter((a) => !FILING_ACTION_TYPES.has(a.type)), quickReplies: h.quickReplies, confidence: h.confidence };
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
