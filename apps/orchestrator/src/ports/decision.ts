/**
 * Structured-decision port — deliberately separate from the LLM port.
 *
 * A decision provider answers *typed questions* about a *state* (a compact,
 * JSON-serialisable description of the thing being decided on) with
 * probabilities: no free text, nothing to parse, nothing to hallucinate. The
 * generative model (`ports/llm.ts`) keeps what needs prose: summaries,
 * extraction, replies.
 *
 * The port is generic: nothing here knows about emails, folders or urgency.
 * Email-specific logic lives in `domain/decisions/*` and
 * `services/EmailDecisionService.ts`; adapters only speak their transport.
 *
 * v1 uses **only `choice` questions**, binary decisions included. The upstream
 * engine (Laya) also offers `score` (ordinal) and `noul` (yes/no probability);
 * they are named in `ReservedDecisionQuestionType` so the types can grow, but
 * no adapter accepts them yet.
 */

/** Question primitives enabled in this version. */
export type DecisionQuestionType = "choice";

/** Primitives the engine supports but this integration does not enable yet (documentation only). */
export type ReservedDecisionQuestionType = "score" | "noul";

export interface DecisionChoiceQuestion {
  type: "choice";
  /** Built server-side from constants. Never contains email text. */
  instructions: string;
  /** Option id → description. Ids are stable and language-independent (they are what the caller maps back). */
  criteria: Record<string, string>;
}

/** Union kept open for future primitives (`score`, `noul`). */
export type DecisionQuestion = DecisionChoiceQuestion;

export interface DecisionProviderRequest {
  /** Compact, JSON-serialisable state. Untrusted *data*: it can never change the questions. */
  state: Record<string, unknown>;
  /** Question id → definition. */
  questions: Record<string, DecisionQuestion>;
  /** Checkpoint to use. Omitted = the provider routes by itself. */
  model?: string;
}

export interface DecisionChoiceAnswer {
  type: "choice";
  /** Selected option id (one of the question's criteria keys, if the provider behaves). */
  choice: string;
  /** Option id → probability, 0..1. May be empty when the provider gives none. */
  probabilities: Record<string, number>;
  /**
   * Provider-reported confidence, 0..1. For Laya this is a normalised-entropy
   * certainty (1 − H(p)/ln k), stricter than the top probability. Absent when
   * the provider gives none — the confidence policy then treats the answer as
   * unusable rather than guessing.
   */
  confidence?: number;
}

/** Union kept open for future primitives. */
export type DecisionAnswer = DecisionChoiceAnswer;

export interface DecisionProviderResponse {
  /** Question id → answer. Questions the provider did not answer are simply absent. */
  answers: Record<string, DecisionAnswer>;
  /** Model / checkpoint that actually answered (Laya: `routing.model`). */
  model?: string;
  /** Provider-side routing information, when available (no state content). */
  routing?: { model?: string; reason?: string };
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Duration of the provider call itself, queue wait excluded. */
  latencyMs: number;
}

export interface DecisionProviderHealth {
  status: "ok" | "degraded" | "unavailable" | "disabled";
  detail?: string;
  /** Checkpoints the engine reports as loaded. */
  loadedModels?: string[];
  device?: string;
  latencyMs?: number;
}

export interface DecisionCallContext {
  /** Caller-side cancellation (not counted as a provider failure). */
  signal?: AbortSignal;
  correlationId?: string;
  /** Scheduling lane: interactive requests overtake background precomputation. */
  priority?: "interactive" | "background";
}

export interface DecisionProvider {
  readonly name: string;
  evaluate(request: DecisionProviderRequest, context?: DecisionCallContext): Promise<DecisionProviderResponse>;
  /** Cheap liveness probe for `/health` and the admin status page. */
  healthCheck?(): Promise<DecisionProviderHealth>;
}

/**
 * Failure classes. The split matters: only infrastructure failures open the
 * circuit breaker — a request the engine rejected as malformed (400) or a
 * caller that gave up says nothing about the engine's health.
 *
 * HTTP 422 is *not* a client error with laya-serve: every request is validated
 * here before it is sent, and the server answers 422 whenever running the
 * model raised — a checkpoint missing from an offline cache, a tokenizer that
 * cannot load… (observed against laya-serve 0.3.9: without weights, every
 * request gets a 422). It therefore counts as a failure.
 */
export type DecisionProviderErrorKind =
  | "disabled" /**        no provider configured */
  | "timeout" /**         no answer within LAYA_TIMEOUT_MS */
  | "aborted" /**         cancelled by the caller */
  | "network" /**         connection refused / reset / DNS */
  | "unauthorized" /**    HTTP 401 / 403 — wrong or missing API key */
  | "invalid_request" /** HTTP 400, or rejected before sending */
  | "model_error" /**     HTTP 422 — the engine could not run the model (missing checkpoint, load error…) */
  | "rate_limited" /**    HTTP 429 */
  | "server" /**          HTTP 5xx */
  | "http" /**            any other unexpected HTTP status (404: wrong base URL…) */
  | "invalid_response" /** not JSON, or not the expected shape */
  | "response_too_large" /** over LAYA_MAX_RESPONSE_BYTES */
  | "circuit_open" /**    rejected without calling: breaker open */
  | "queue_timeout" /**   no concurrency slot in time */
  | "internal"; /**       unexpected exception in the adapter (a bug) */

const COUNTS_AS_FAILURE: ReadonlySet<DecisionProviderErrorKind> = new Set<DecisionProviderErrorKind>([
  "timeout",
  "network",
  "unauthorized",
  "model_error",
  "rate_limited",
  "server",
  "http",
  "invalid_response",
  "response_too_large",
  "internal",
]);

export class DecisionProviderError extends Error {
  readonly kind: DecisionProviderErrorKind;
  /** HTTP status, when there was one. */
  readonly status?: number;

  constructor(kind: DecisionProviderErrorKind, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "DecisionProviderError";
    this.kind = kind;
    this.status = opts.status;
  }

  /** True when the failure says something about the provider's health (feeds the circuit breaker). */
  get countsAsFailure(): boolean {
    return COUNTS_AS_FAILURE.has(this.kind);
  }
}

export const isDecisionProviderError = (e: unknown): e is DecisionProviderError => e instanceof DecisionProviderError;
