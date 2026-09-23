import type { DecisioningStatus, DecisionMode, EmailContext, EmailDecisioning, Language, SuggestedAction, UrgencyLevel } from "@oao/shared";
import type { DecisionProviderStats } from "../adapters/decision/resilient.js";
import type { Config } from "../config.js";
import { assessChoice, planDecision, type ConfidenceVerdict, type DecisionPlan } from "../domain/decisions/confidence-policy.js";
import { buildFolderQuestion, buildPrimaryQuestions, QUESTION_IDS, type OptionOrder, type QuestionId } from "../domain/decisions/question-builder.js";
import { mapChoice, toKnownId, toRequired, toUrgency, type MappedChoice, type MappedStatus } from "../domain/decisions/response-mapper.js";
import { detectEmailLanguage, questionLanguage, selectModel, type EmailLanguage, type ModelStrategy } from "../domain/decisions/routing.js";
import { compareWithHistoric, COMPARED_QUESTIONS, type HistoricAnalysis, type ShadowComparison } from "../domain/decisions/shadow.js";
import { buildDecisionState } from "../domain/decisions/state-builder.js";
import { areaById, localize, OTHER_AREA_ID, type LoadedTaxonomy, type TaxonomyArea } from "../domain/decisions/taxonomy.js";
import { cleanBody } from "../domain/prompts/clean.js";
import type { TriageKind } from "../domain/triage.js";
import type { Metrics } from "../metrics.js";
import { DecisionProviderError, type DecisionCallContext, type DecisionProvider, type DecisionProviderErrorKind } from "../ports/decision.js";
import type { CircuitState } from "../util/circuit-breaker.js";
import { sha256 } from "../util/hash.js";
import type { Logger } from "./context.js";

/**
 * Structured email decisions — urgency, business area, suggested folder,
 * reply expected, action required — computed by a `DecisionProvider` (Laya in
 * production, a deterministic mock in demo/tests). Depends on the port only.
 *
 * Responsibilities:
 *  1. build the compact state (`domain/decisions/state-builder.ts`);
 *  2. pick the email language, then the checkpoint and the question language;
 *  3. build the questions (server-side constants + taxonomy only);
 *  4. call the provider — **hierarchically**: urgency + area + reply + action
 *     first; the folder only when the area passed the gate and has ≥ 2
 *     folders (one folder is picked from the taxonomy, none / `other` means
 *     no move);
 *  5. map and gate every answer (`confidence-policy.ts`);
 *  6. return an outcome that never throws: an engine failure is a result
 *     (`status: "failed"`) the analysis falls back from, never an error.
 *
 * The outcome is plain JSON (it is cached with the analysis) and carries no
 * email content: choices, confidences, the state hash and the versions.
 */
export type DecisionProviderKind = Config["DECISION_PROVIDER"];

export interface DecisionSettings {
  provider: DecisionProviderKind;
  mode: DecisionMode;
  minConfidence: number;
  folderMinConfidence: number;
  fallbackToLlm: boolean;
  inputMaxChars: number;
  modelStrategy: ModelStrategy;
  fixedModel?: string;
  shadowSampleRate: number;
  decisionVersion: string;
  concurrency: number;
}

export const decisionSettings = (cfg: Config): DecisionSettings => ({
  provider: cfg.DECISION_PROVIDER,
  mode: cfg.LAYA_MODE,
  minConfidence: cfg.LAYA_MIN_CONFIDENCE,
  folderMinConfidence: cfg.LAYA_FOLDER_MIN_CONFIDENCE,
  fallbackToLlm: cfg.LAYA_FALLBACK_TO_LLM,
  inputMaxChars: cfg.LAYA_INPUT_MAX_CHARS,
  modelStrategy: cfg.LAYA_MODEL_STRATEGY,
  fixedModel: cfg.LAYA_FIXED_MODEL,
  shadowSampleRate: cfg.LAYA_SHADOW_SAMPLE_RATE,
  decisionVersion: cfg.LAYA_DECISION_VERSION,
  concurrency: cfg.LAYA_CONCURRENCY,
});

export interface DecideInput {
  email: EmailContext;
  /** Language of the person reading the analysis (labels, tie-breaks). */
  readerLanguage: Language;
  internalDomains: string[];
  triageKind: TriageKind;
  phishingVerdict: "clean" | "suspicious" | "likely_phishing";
  thread?: EmailContext[];
  correlationId?: string;
  priority?: "interactive" | "background";
  signal?: AbortSignal;
  now?: Date;
  /**
   * Evaluation harness only: present the options in another order to measure
   * position bias (stability under permutation). Production never sets it.
   */
  optionOrder?: OptionOrder;
}

/** Per-question trace (audit, metrics, shadow comparison). No content. */
export interface QuestionOutcome {
  status: MappedStatus;
  verdict: ConfidenceVerdict;
  accepted: boolean;
  choice?: string;
  confidence?: number;
  probability?: number;
  /** `taxonomy` for a folder derived from a single-folder area. */
  source?: "laya" | "taxonomy";
}

export type FolderStep = "skipped_area_not_accepted" | "not_needed_other" | "not_needed_no_folder" | "taxonomy_single_folder" | "asked" | "failed";

export interface DecisionOutcome {
  mode: DecisionMode;
  status: "ok" | "failed";
  failureKind?: DecisionProviderErrorKind;
  /* Decisions that passed the confidence gate. */
  urgency?: { level: UrgencyLevel; confidence: number };
  businessArea?: { id: string; label: string; confidence: number };
  suggestedFolder?: { id: string; displayName: string; outlookFolder: string; confidence: number; source: "laya" | "taxonomy" };
  replyExpected?: { value: boolean; confidence: number };
  actionRequired?: { value: boolean; confidence: number };
  /* Traces. */
  questions: Partial<Record<QuestionId, QuestionOutcome>>;
  /** At least one answer was discarded by the confidence policy. */
  lowConfidence: boolean;
  lowConfidenceQuestions: QuestionId[];
  folderStep: FolderStep;
  folderFailureKind?: DecisionProviderErrorKind;
  /** Checkpoint that answered (as reported by the engine). */
  model?: string;
  /** Checkpoint requested (undefined = engine routing). */
  requestedModel?: string;
  emailLanguage: EmailLanguage;
  questionLanguage: Language;
  calls: number;
  /** Engine time, all calls of this decision. */
  latencyMs: number;
  stateHash: string;
  stateChars: number;
  taxonomyVersion: string;
  taxonomyHash: string;
  decisionVersion: string;
}

export interface EmailDecisionServiceOptions {
  provider: DecisionProvider;
  settings: DecisionSettings;
  /** Required unless the provider is `disabled`. */
  taxonomy?: LoadedTaxonomy;
  /** Circuit / queue view of the provider, when it is wrapped by `ResilientDecisionProvider`. */
  resilience?: { readonly stats: DecisionProviderStats };
  logger: Logger;
  metrics?: Metrics;
}

export class EmailDecisionService {
  private readonly provider: DecisionProvider;
  private readonly s: DecisionSettings;
  private readonly taxonomy?: LoadedTaxonomy;
  private readonly logger: Logger;
  private readonly metrics?: Metrics;
  private readonly resilience?: { readonly stats: DecisionProviderStats };
  private readonly counters = { decisions: 0, providerCalls: 0, failures: 0, fallbacks: 0, lowConfidence: 0, latencySum: 0, latencyCount: 0 };

  constructor(opts: EmailDecisionServiceOptions) {
    this.provider = opts.provider;
    this.s = opts.settings;
    this.taxonomy = opts.taxonomy;
    this.logger = opts.logger;
    this.metrics = opts.metrics;
    this.resilience = opts.resilience;
    if (this.enabled && !this.taxonomy) throw new Error("EmailDecisionService: a taxonomy is required when the decision provider is enabled");
  }

  get enabled(): boolean {
    return this.s.provider !== "disabled";
  }

  get mode(): DecisionMode {
    return this.s.mode;
  }

  get settings(): Readonly<DecisionSettings> {
    return this.s;
  }

  get taxonomyInfo(): Pick<LoadedTaxonomy, "hash" | "source" | "example"> & { version: string } | undefined {
    return this.taxonomy ? { version: this.taxonomy.taxonomy.version, hash: this.taxonomy.hash, source: this.taxonomy.source, example: this.taxonomy.example } : undefined;
  }

  get circuitState(): CircuitState {
    return this.resilience?.stats.circuit ?? "closed";
  }

  /**
   * Analysis cache-key component: everything that changes the decisions or
   * the prompt path. `undefined` when disabled, so the historic keys (and the
   * cache they address) are untouched.
   */
  cacheFingerprint(): string | undefined {
    if (!this.enabled || !this.taxonomy) return undefined;
    const s = this.s;
    return [
      "decisions/v1",
      s.provider,
      s.decisionVersion,
      s.mode,
      `tax=${this.taxonomy.taxonomy.version}:${this.taxonomy.hash.slice(0, 16)}`,
      `min=${s.minConfidence}`,
      `fmin=${s.folderMinConfidence}`,
      `fb=${s.fallbackToLlm ? 1 : 0}`,
      `model=${s.modelStrategy}${s.modelStrategy === "fixed" ? `:${s.fixedModel ?? ""}` : ""}`,
      `max=${s.inputMaxChars}`,
    ].join("|");
  }

  /**
   * Whether this analysis consults the engine. Active: always. Shadow: a
   * deterministic sample (`LAYA_SHADOW_SAMPLE_RATE`) keyed on the content
   * hash, so the same email is always in, or always out.
   */
  shouldEvaluate(sampleKey: string): boolean {
    if (!this.enabled) return false;
    if (this.s.mode === "active" || this.s.shadowSampleRate >= 1) return true;
    if (this.s.shadowSampleRate <= 0) return false;
    return Number.parseInt(sha256(`laya-shadow:${sampleKey}`).slice(0, 8), 16) / 0xffffffff < this.s.shadowSampleRate;
  }

  /* ------------------------------------------------------------------------- */
  /*  Decision                                                                 */
  /* ------------------------------------------------------------------------- */

  async decide(input: DecideInput): Promise<DecisionOutcome> {
    const taxonomy = this.taxonomy!;
    this.counters.decisions++;
    const detectionText = `${input.email.subject ?? ""}\n${cleanBody(input.email.body ?? "", { maxChars: 2_000 }).text}`;
    const emailLanguage = detectEmailLanguage(detectionText);
    const requestedModel = selectModel(this.s.modelStrategy, emailLanguage, this.s.fixedModel);
    const qLang = questionLanguage(requestedModel, emailLanguage, input.readerLanguage);
    const built = buildDecisionState(
      { email: input.email, language: emailLanguage, internalDomains: input.internalDomains, triageKind: input.triageKind, phishingVerdict: input.phishingVerdict, thread: input.thread, now: input.now },
      { maxChars: this.s.inputMaxChars, model: requestedModel },
    );
    const primary = buildPrimaryQuestions(taxonomy.taxonomy, qLang, { order: input.optionOrder });
    const context: DecisionCallContext = { correlationId: input.correlationId, priority: input.priority, signal: input.signal };
    const outcome: DecisionOutcome = {
      mode: this.s.mode,
      status: "ok",
      questions: {},
      lowConfidence: false,
      lowConfidenceQuestions: [],
      folderStep: "skipped_area_not_accepted",
      requestedModel,
      emailLanguage,
      questionLanguage: qLang,
      calls: 0,
      latencyMs: 0,
      stateHash: built.hash,
      stateChars: built.stats.stateChars,
      taxonomyVersion: taxonomy.taxonomy.version,
      taxonomyHash: taxonomy.hash,
      decisionVersion: this.s.decisionVersion,
    };

    let first;
    try {
      outcome.calls++;
      first = await this.provider.evaluate({ state: built.state, questions: primary, ...(requestedModel ? { model: requestedModel } : {}) }, context);
    } catch (e) {
      return this.failed(outcome, e, input.correlationId);
    }
    outcome.latencyMs += first.latencyMs;
    outcome.model = first.routing?.model ?? first.model;
    if (requestedModel && outcome.model && outcome.model !== requestedModel) {
      // laya-serve silently auto-routes a model name it does not know (LAYA_FIXED_MODEL typo, renamed checkpoint).
      this.logger.debug({ requestedModel, answeredBy: outcome.model, correlationId: input.correlationId }, "decision answered by another checkpoint than requested");
    }

    const areaIds = new Set(taxonomy.taxonomy.areas.map((a) => a.id));
    const urgency = this.gate(QUESTION_IDS.urgency, mapChoice(first, QUESTION_IDS.urgency, primary[QUESTION_IDS.urgency]!, toUrgency), this.s.minConfidence, outcome);
    const area = this.gate(QUESTION_IDS.businessArea, mapChoice(first, QUESTION_IDS.businessArea, primary[QUESTION_IDS.businessArea]!, toKnownId(areaIds)), this.s.minConfidence, outcome);
    const reply = this.gate(QUESTION_IDS.replyExpected, mapChoice(first, QUESTION_IDS.replyExpected, primary[QUESTION_IDS.replyExpected]!, toRequired), this.s.minConfidence, outcome);
    const action = this.gate(QUESTION_IDS.actionRequired, mapChoice(first, QUESTION_IDS.actionRequired, primary[QUESTION_IDS.actionRequired]!, toRequired), this.s.minConfidence, outcome);

    if (urgency.accepted) outcome.urgency = { level: urgency.value!, confidence: urgency.confidence! };
    if (reply.accepted) outcome.replyExpected = { value: reply.value!, confidence: reply.confidence! };
    if (action.accepted) outcome.actionRequired = { value: action.value!, confidence: action.confidence! };

    if (area.accepted) {
      const areaDef = areaById(taxonomy.taxonomy, area.value!)!;
      outcome.businessArea = { id: areaDef.id, label: localize(areaDef.labels, input.readerLanguage), confidence: area.confidence! };
      await this.decideFolder(areaDef, area.confidence!, built.state, requestedModel, qLang, context, outcome, input.optionOrder);
    } else {
      // Hierarchy: no area we trust, no folder question.
      outcome.folderStep = "skipped_area_not_accepted";
      this.saved("area_not_accepted");
    }

    if (outcome.lowConfidence) this.counters.lowConfidence++;
    this.counters.latencySum += outcome.latencyMs;
    this.counters.latencyCount++;
    return outcome;
  }

  private async decideFolder(area: TaxonomyArea, areaConfidence: number, state: Record<string, unknown>, model: string | undefined, lang: Language, context: DecisionCallContext, outcome: DecisionOutcome, order?: OptionOrder): Promise<void> {
    if (area.id === OTHER_AREA_ID) {
      outcome.folderStep = "not_needed_other";
      this.saved("other_area");
      return;
    }
    if (area.folders.length === 0) {
      outcome.folderStep = "not_needed_no_folder";
      this.saved("no_folders");
      return;
    }
    if (area.folders.length === 1) {
      // One folder: the taxonomy decides, no second call. Its confidence is the area's.
      const folder = area.folders[0]!;
      const accepted = areaConfidence >= this.s.folderMinConfidence;
      outcome.folderStep = "taxonomy_single_folder";
      outcome.questions[QUESTION_IDS.folder] = { status: "ok", verdict: accepted ? "accepted" : "low_confidence", accepted, choice: folder.id, confidence: areaConfidence, source: "taxonomy" };
      this.saved("single_folder");
      if (accepted) outcome.suggestedFolder = { id: folder.id, displayName: folder.displayName, outlookFolder: folder.outlookFolder, confidence: areaConfidence, source: "taxonomy" };
      else this.discard(QUESTION_IDS.folder, "low_confidence", outcome);
      return;
    }

    const questions = buildFolderQuestion(area, lang, { order });
    let second;
    try {
      outcome.calls++;
      second = await this.provider.evaluate({ state, questions, ...(model ? { model } : {}) }, context);
    } catch (e) {
      outcome.folderStep = "failed";
      outcome.folderFailureKind = e instanceof DecisionProviderError ? e.kind : "internal";
      this.counters.failures++;
      return;
    }
    outcome.latencyMs += second.latencyMs;
    outcome.folderStep = "asked";
    const folderIds = new Set(area.folders.map((f) => f.id));
    const folder = this.gate(QUESTION_IDS.folder, mapChoice(second, QUESTION_IDS.folder, questions[QUESTION_IDS.folder]!, toKnownId(folderIds)), this.s.folderMinConfidence, outcome, `${area.id}.`);
    if (folder.accepted) {
      const f = area.folders.find((x) => x.id === folder.value)!;
      outcome.suggestedFolder = { id: f.id, displayName: f.displayName, outlookFolder: f.outlookFolder, confidence: folder.confidence!, source: "laya" };
    }
  }

  /** Assess one mapped answer, record its trace and metrics. */
  private gate<T>(question: QuestionId, mapped: MappedChoice<T>, threshold: number, outcome: DecisionOutcome, choicePrefix = ""): { accepted: boolean; value?: T; confidence?: number } {
    const a = assessChoice(mapped, threshold);
    outcome.questions[question] = { status: mapped.status, verdict: a.verdict, accepted: a.accepted, choice: mapped.choice, confidence: mapped.confidence, probability: mapped.probability, ...(question === QUESTION_IDS.folder ? { source: "laya" as const } : {}) };
    // Option ids are validated against the question (taxonomy-bounded): safe as metric labels.
    this.metrics?.layaDecisions.inc({ question, choice: mapped.status === "ok" ? `${choicePrefix}${mapped.choice}` : mapped.status });
    if (!a.accepted) this.discard(question, a.verdict, outcome);
    return { accepted: a.accepted, value: mapped.value, confidence: mapped.confidence };
  }

  private discard(question: QuestionId, verdict: ConfidenceVerdict, outcome: DecisionOutcome): void {
    outcome.lowConfidence = true;
    outcome.lowConfidenceQuestions.push(question);
    if (verdict === "low_confidence" || verdict === "missing_confidence") this.metrics?.layaLowConfidence.inc({ question });
  }

  private failed(outcome: DecisionOutcome, e: unknown, correlationId?: string): DecisionOutcome {
    const kind: DecisionProviderErrorKind = e instanceof DecisionProviderError ? e.kind : "internal";
    this.counters.failures++;
    // The adapter already logged the details (kind, status, latency); this line only ties it to the analysis.
    this.logger.debug({ kind, correlationId }, "decision unavailable for this email");
    return { ...outcome, status: "failed", failureKind: kind };
  }

  private saved(reason: string): void {
    this.metrics?.layaCallsSaved.inc({ reason });
  }

  /** Engine call avoided upstream of the service (triage, cache, coalescing). */
  recordSaved(reason: "triage" | "cache" | "coalesced"): void {
    if (this.enabled) this.saved(reason);
  }

  /* ------------------------------------------------------------------------- */
  /*  What the analysis does with it                                           */
  /* ------------------------------------------------------------------------- */

  /** Prompt path, classification owner and fallback for an outcome (see `planDecision`). */
  plan(outcome: DecisionOutcome | undefined): DecisionPlan {
    if (!this.enabled) return { promptPath: "full", classificationFrom: "llm", source: "disabled", degraded: false };
    if (this.s.mode === "shadow") return planDecision({ mode: "shadow", status: "ok", areaAccepted: false, fallbackToLlm: this.s.fallbackToLlm });
    if (!outcome) return planDecision({ mode: "active", status: "failed", areaAccepted: false, failureKind: "internal", fallbackToLlm: this.s.fallbackToLlm });
    return planDecision({
      mode: "active",
      status: outcome.status,
      areaAccepted: outcome.businessArea !== undefined,
      areaVerdict: outcome.questions.businessArea?.verdict,
      failureKind: outcome.failureKind,
      fallbackToLlm: this.s.fallbackToLlm,
    });
  }

  recordFallback(reason: string): void {
    this.counters.fallbacks++;
    this.metrics?.layaFallbacks.inc({ reason });
  }

  /**
   * Public `decisioning` block — active mode only (shadow results are never
   * shown). `llmDegraded`: the historic prompt was used and the LLM failed
   * too, so the classification in the answer came from heuristics.
   */
  toDecisioning(outcome: DecisionOutcome, plan: DecisionPlan, llmDegraded: boolean): EmailDecisioning | undefined {
    if (outcome.mode !== "active") return undefined;
    const folderFailed = outcome.folderStep === "failed";
    return {
      source: plan.source === "llm_fallback" && llmDegraded ? "heuristic" : plan.source,
      mode: "active",
      ...(outcome.urgency ? { urgency: outcome.urgency } : {}),
      ...(outcome.businessArea ? { businessArea: outcome.businessArea } : {}),
      ...(outcome.suggestedFolder ? { suggestedFolder: outcome.suggestedFolder } : {}),
      ...(outcome.replyExpected ? { replyExpected: outcome.replyExpected } : {}),
      ...(outcome.actionRequired ? { actionRequired: outcome.actionRequired } : {}),
      lowConfidence: outcome.lowConfidence,
      degraded: plan.degraded || folderFailed,
      ...(plan.fallbackReason ? { fallbackReason: plan.fallbackReason } : folderFailed ? { fallbackReason: `folder_${outcome.folderFailureKind ?? "internal"}` } : {}),
      ...(outcome.model ?? outcome.requestedModel ? { model: outcome.model ?? outcome.requestedModel } : {}),
      taxonomyVersion: outcome.taxonomyVersion,
      decisionVersion: outcome.decisionVersion,
    };
  }

  /**
   * Deterministic `move_to_folder` suggestion. Only when: active mode, a
   * folder decided, its confidence ≥ LAYA_FOLDER_MIN_CONFIDENCE, nothing
   * degraded, a non-empty folder path — and never for a suspected phishing
   * email. It is a *suggestion*: it goes through propose → human approval →
   * execute like every action, and nothing here touches Microsoft Graph.
   */
  moveAction(decisioning: EmailDecisioning | undefined, lang: Language, phishingVerdict: "clean" | "suspicious" | "likely_phishing"): SuggestedAction | undefined {
    const folder = decisioning?.suggestedFolder;
    if (!decisioning || decisioning.mode !== "active" || decisioning.degraded || !folder) return undefined;
    if (folder.confidence < this.s.folderMinConfidence || !folder.outlookFolder.trim() || phishingVerdict !== "clean") return undefined;
    const fr = lang === "fr";
    const pct = Math.round(folder.confidence * 100);
    return {
      type: "move_to_folder",
      title: fr ? `Classer dans « ${folder.displayName} »` : `File in "${folder.displayName}"`,
      description: fr
        ? `Suggestion de classement (confiance ${pct} %) — rien n'est déplacé sans votre validation.`
        : `Filing suggestion (confidence ${pct}%) — nothing is moved without your approval.`,
      parameters: {
        folder: folder.outlookFolder,
        folderId: folder.id,
        businessArea: decisioning.businessArea?.id,
        confidence: folder.confidence,
        source: "laya",
        suggested: true,
        requiresConfirmation: true,
        selectedByDefault: false,
        rule: "laya_folder_suggestion",
      },
    };
  }

  /** Shadow mode: agreement with the historic answer (proxies, see `domain/decisions/shadow.ts`). */
  compareShadow(outcome: DecisionOutcome, historic: HistoricAnalysis): ShadowComparison {
    const unavailable = Object.fromEntries(COMPARED_QUESTIONS.map((q) => [q, "unavailable"])) as ShadowComparison;
    const raw = (q: QuestionId) => (outcome.questions[q]?.status === "ok" ? outcome.questions[q]?.choice : undefined);
    const comparison =
      outcome.status !== "ok" || !this.taxonomy
        ? unavailable
        : compareWithHistoric({ businessArea: raw("businessArea"), urgency: raw("urgency"), replyExpected: raw("replyExpected"), actionRequired: raw("actionRequired") }, historic, this.taxonomy.taxonomy);
    for (const q of COMPARED_QUESTIONS) this.metrics?.layaShadowComparisons.inc({ question: q, result: comparison[q] });
    return comparison;
  }

  /** Audit projection of an outcome: versions, hash, choices and confidences — no content. */
  auditRecord(outcome: DecisionOutcome): Record<string, unknown> {
    return {
      mode: outcome.mode,
      provider: this.s.provider,
      status: outcome.status,
      failureKind: outcome.failureKind,
      stateHash: outcome.stateHash,
      stateChars: outcome.stateChars,
      model: outcome.model,
      requestedModel: outcome.requestedModel,
      emailLanguage: outcome.emailLanguage,
      questionLanguage: outcome.questionLanguage,
      latencyMs: outcome.latencyMs,
      calls: outcome.calls,
      questions: outcome.questions,
      lowConfidence: outcome.lowConfidence,
      lowConfidenceQuestions: outcome.lowConfidenceQuestions,
      folderStep: outcome.folderStep,
      folderFailureKind: outcome.folderFailureKind,
      taxonomyVersion: outcome.taxonomyVersion,
      taxonomyHash: outcome.taxonomyHash,
      decisionVersion: outcome.decisionVersion,
      thresholds: { min: this.s.minConfidence, folderMin: this.s.folderMinConfidence },
    };
  }

  /* ------------------------------------------------------------------------- */
  /*  Health & status                                                          */
  /* ------------------------------------------------------------------------- */

  /** Never throws. `unavailable` never makes the orchestrator unready. */
  async health(): Promise<{ state: DecisioningStatus["state"]; detail?: string; loadedModels?: string[]; device?: string }> {
    if (!this.enabled) return { state: "disabled", detail: "DECISION_PROVIDER=disabled — historic behaviour" };
    const circuit = this.circuitState;
    let probe;
    try {
      probe = this.provider.healthCheck ? await this.provider.healthCheck() : { status: "ok" as const, detail: "no health probe" };
    } catch {
      probe = { status: "unavailable" as const, detail: "health probe failed" };
    }
    const where = `${this.s.provider}, ${this.s.mode} mode`;
    if (circuit === "open") return { state: "unavailable", detail: `circuit open — decisions fall back (${where}); probe: ${probe.detail ?? probe.status}`, loadedModels: probe.loadedModels, device: probe.device };
    if (probe.status === "unavailable" || probe.status === "disabled") return { state: "unavailable", detail: `${probe.detail ?? "unreachable"} (${where})` };
    if (probe.status === "degraded" || circuit === "half_open") return { state: "degraded", detail: `${probe.detail ?? "degraded"}${circuit === "half_open" ? " — circuit half-open" : ""} (${where})`, loadedModels: probe.loadedModels, device: probe.device };
    return { state: "ok", detail: `${probe.detail ?? "ok"} (${where})`, loadedModels: probe.loadedModels, device: probe.device };
  }

  async status(): Promise<DecisioningStatus> {
    const health = await this.health();
    const r = this.resilience?.stats;
    const c = this.counters;
    return {
      provider: this.s.provider,
      mode: this.s.mode,
      state: health.state,
      detail: health.detail,
      circuit: this.circuitState,
      modelStrategy: this.s.modelStrategy,
      ...(this.s.fixedModel ? { fixedModel: this.s.fixedModel } : {}),
      ...(health.loadedModels ? { loadedModels: health.loadedModels } : {}),
      ...(health.device ? { device: health.device } : {}),
      ...(this.taxonomy ? { taxonomyVersion: this.taxonomy.taxonomy.version } : {}),
      decisionVersion: this.s.decisionVersion,
      minConfidence: this.s.minConfidence,
      folderMinConfidence: this.s.folderMinConfidence,
      fallbackToLlm: this.s.fallbackToLlm,
      shadowSampleRate: this.s.shadowSampleRate,
      concurrency: this.s.concurrency,
      stats: {
        decisions: c.decisions,
        providerCalls: r?.totalCalls ?? 0,
        failures: c.failures,
        fallbacks: c.fallbacks,
        lowConfidence: c.lowConfidence,
        ...(c.decisions ? { lowConfidenceRate: Number((c.lowConfidence / c.decisions).toFixed(4)) } : {}),
        ...(c.latencyCount ? { avgLatencyMs: Math.round(c.latencySum / c.latencyCount) } : {}),
        inFlight: r?.inFlight ?? 0,
        pending: r?.pending ?? 0,
      },
    };
  }
}
