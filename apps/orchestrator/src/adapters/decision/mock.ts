import { extractSignals } from "../../domain/heuristics/email.js";
import {
  DecisionProviderError,
  type DecisionChoiceAnswer,
  type DecisionChoiceQuestion,
  type DecisionCallContext,
  type DecisionProvider,
  type DecisionProviderErrorKind,
  type DecisionProviderHealth,
  type DecisionProviderRequest,
  type DecisionProviderResponse,
} from "../../ports/decision.js";

/**
 * Deterministic decision provider for the demo (`DECISION_PROVIDER=mock`) and
 * the tests. Same answers for the same input, no network, no model.
 *
 * Default behaviour, per `choice` question:
 *  - the well-known email questions (`urgency`, `replyExpected`,
 *    `actionRequired`) are answered from the keyword heuristics that already
 *    back the mock LLM (`domain/heuristics/email.ts`);
 *  - any other question (business area, folder…) is answered by keyword
 *    overlap between the state text and each option's id + description,
 *    ignoring words shared by several options. A unique best match answers
 *    with `confidence` (default 0.9); a tie or no match answers a neutral
 *    option (`other`, `normal`, `not_required`, else the first) with a low
 *    confidence (0.45) — so the demo exercises the fallback path too.
 *
 * Test hooks: `script` (full control), `setAnswer`, `failWith`, `latencyMs`,
 * `requests`, `contexts`, `calls`, `health`.
 */
export interface MockDecisionOptions {
  /** Confidence of a clear answer (default 0.9). */
  confidence?: number;
  /** Confidence of a tie / no-match answer (default 0.45: below every sensible threshold). */
  lowConfidence?: number;
  /** Full override: return the response for a request. */
  script?: (request: DecisionProviderRequest, context: DecisionCallContext) => DecisionProviderResponse | Promise<DecisionProviderResponse>;
  /** Artificial latency, honouring the caller's abort signal. */
  latencyMs?: number;
  /** Model reported back (default: the requested one, else `mock-multilingual`). */
  model?: string;
}

const NEUTRAL_OPTIONS = ["other", "normal", "not_required"];

/** 5-letter stems of the words (≥ 5 letters) of a text, accents folded. */
function stems(text: string): Set<string> {
  const words =
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]{5,}/g) ?? [];
  return new Set(words.map((w) => w.slice(0, 5)));
}

function stateText(state: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(state);
  return parts.join("\n");
}

export class MockDecisionProvider implements DecisionProvider {
  readonly name = "mock";
  calls = 0;
  readonly requests: DecisionProviderRequest[] = [];
  readonly contexts: DecisionCallContext[] = [];
  /** Returned by `healthCheck`. */
  health: DecisionProviderHealth = { status: "ok", detail: "mock decision provider", loadedModels: ["mock-english", "mock-multilingual"], device: "cpu" };
  script: MockDecisionOptions["script"];
  latencyMs: number;

  private readonly forced = new Map<string, { choice: string; confidence?: number; probabilities?: Record<string, number> }>();
  private failure: { error: DecisionProviderError; remaining: number } | undefined;

  constructor(private readonly opts: MockDecisionOptions = {}) {
    this.script = opts.script;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  /** Force the answer to one question id (until `clearAnswers`). `confidence: null` = an answer without confidence. */
  setAnswer(questionId: string, choice: string, confidence: number | null = 0.95, probabilities?: Record<string, number>): this {
    this.forced.set(questionId, { choice, confidence: confidence ?? undefined, probabilities });
    return this;
  }

  clearAnswers(): this {
    this.forced.clear();
    return this;
  }

  /** Throw `kind` (or the given error) on the next `times` calls (default: until `recover`). */
  failWith(kindOrError: DecisionProviderErrorKind | DecisionProviderError, times = Number.POSITIVE_INFINITY): this {
    const error = typeof kindOrError === "string" ? new DecisionProviderError(kindOrError, `mock decision provider configured to fail (${kindOrError})`) : kindOrError;
    this.failure = { error, remaining: times };
    return this;
  }

  recover(): this {
    this.failure = undefined;
    return this;
  }

  async evaluate(request: DecisionProviderRequest, context: DecisionCallContext = {}): Promise<DecisionProviderResponse> {
    this.calls++;
    this.requests.push(request);
    this.contexts.push(context);
    const started = Date.now();
    if (this.latencyMs > 0) await this.sleep(this.latencyMs, context.signal);
    if (context.signal?.aborted) throw new DecisionProviderError("aborted", "decision request cancelled by the caller");
    if (this.failure && this.failure.remaining > 0) {
      this.failure.remaining--;
      throw this.failure.error;
    }
    if (this.script) return this.script(request, context);

    const text = stateText(request.state);
    const answers: Record<string, DecisionChoiceAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const forced = this.forced.get(id);
      answers[id] = forced ? this.forcedAnswer(question, forced) : this.answer(id, question, request.state, text);
    }
    return { answers, model: this.opts.model ?? request.model ?? "mock-multilingual", routing: { model: this.opts.model ?? request.model ?? "mock-multilingual", reason: "mock provider" }, usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 0 }, latencyMs: Date.now() - started };
  }

  async healthCheck(): Promise<DecisionProviderHealth> {
    return this.health;
  }

  /* ------------------------------------------------------------------------- */

  private forcedAnswer(question: DecisionChoiceQuestion, forced: { choice: string; confidence?: number; probabilities?: Record<string, number> }): DecisionChoiceAnswer {
    return { type: "choice", choice: forced.choice, probabilities: forced.probabilities ?? this.distribution(Object.keys(question.criteria), forced.choice, forced.confidence ?? 0.5), confidence: forced.confidence };
  }

  private answer(id: string, question: DecisionChoiceQuestion, state: Record<string, unknown>, text: string): DecisionChoiceAnswer {
    const options = Object.keys(question.criteria);
    const heuristic = this.heuristicChoice(id, options, state);
    if (heuristic) return this.make(options, heuristic, this.opts.confidence ?? 0.9);

    const textStems = stems(text);
    const optionStems = options.map((o) => stems(`${o.replace(/_/g, " ")} ${question.criteria[o] ?? ""}`));
    // A stem present in several options says nothing about which one fits.
    const counts = new Map<string, number>();
    for (const set of optionStems) for (const s of set) counts.set(s, (counts.get(s) ?? 0) + 1);
    const scores = optionStems.map((set) => [...set].filter((s) => counts.get(s) === 1 && textStems.has(s)).length);
    const best = Math.max(...scores);
    const winners = options.filter((_, i) => scores[i] === best);
    if (best > 0 && winners.length === 1) return this.make(options, winners[0]!, this.opts.confidence ?? 0.9);
    const neutral = NEUTRAL_OPTIONS.find((n) => options.includes(n)) ?? options[0]!;
    return this.make(options, neutral, this.opts.lowConfidence ?? 0.45);
  }

  /** Email heuristics for the well-known question ids; `undefined` when not applicable. */
  private heuristicChoice(id: string, options: string[], state: Record<string, unknown>): string | undefined {
    const subject = typeof state.subject === "string" ? state.subject : "";
    const body = typeof state.body === "string" ? state.body : "";
    if (!subject && !body) return undefined;
    const attachments = Array.isArray(state.attachments) ? state.attachments.map((a) => ({ name: String((a as { name?: unknown }).name ?? "") })) : [];
    const s = extractSignals({ subject, body, attachments });
    const pick = (choice: string) => (options.includes(choice) ? choice : undefined);
    if (id === "urgency") {
      if (s.urgent && /bloqu|blocked|incident|production|s[ée]curit|security|panne|outage/i.test(`${subject}\n${body}`)) return pick("critical");
      if (s.urgent || (s.deadline && s.dates.length > 0)) return pick("high");
      if (s.request || s.question) return pick("normal");
      return pick("low");
    }
    if (id === "replyExpected") return pick(s.request || s.question ? "required" : "not_required");
    if (id === "actionRequired") return pick(s.request || s.deadline || s.missingDocument || s.question ? "required" : "not_required");
    return undefined;
  }

  private make(options: string[], choice: string, confidence: number): DecisionChoiceAnswer {
    return { type: "choice", choice, probabilities: this.distribution(options, choice, confidence), confidence };
  }

  /** A plausible distribution peaked on `choice` (probabilities sum to 1). */
  private distribution(options: string[], choice: string, confidence: number): Record<string, number> {
    const others = options.filter((o) => o !== choice);
    const top = options.includes(choice) ? Math.max(1 / options.length, Math.min(0.99, 0.5 + confidence / 2)) : 0;
    const rest = others.length ? (1 - top) / others.length : 0;
    const out: Record<string, number> = {};
    for (const o of options) out[o] = Number((o === choice ? top : rest).toFixed(4));
    return out;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
