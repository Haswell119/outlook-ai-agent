import { z } from "zod";
import { DecisionProviderRequestSchema } from "../../domain/decisions/schemas.js";
import {
  DecisionProviderError,
  type DecisionAnswer,
  type DecisionCallContext,
  type DecisionProvider,
  type DecisionProviderHealth,
  type DecisionProviderRequest,
  type DecisionProviderResponse,
} from "../../ports/decision.js";

/**
 * HTTP client for `laya-serve` (Laya upstream, Python/PyTorch), wire protocol
 * `POST /v1/systemone` + `GET /health`.
 *
 * Contract, as implemented by `laya/serve.py` (checked against the published
 * 0.3.9 package, code-identical to 0.3.8):
 *
 *   request  { state, questions, model? }            Authorization: Bearer <LAYA_API_KEY> when the server sets one
 *   200      { model, answers: { <id>: { type: "choice", choice, probabilities: {opt: p}, confidence, action } },
 *              usage: { input_tokens, output_tokens }, routing: { model, reason, … } }
 *   400      body without `questions`             401  bad / missing bearer token
 *   422      the model or the tokenizer raised — in practice a server-side problem (checkpoint
 *            missing from the offline cache, load error…), since requests are validated here first
 *   GET /health → { status: "ok", loaded: [checkpoint…], device }
 *
 * `model` is honoured only when it names a checkpoint (`english`,
 * `multilingual`, `typed-decisions`, aliases or published HF ids); anything
 * else is silently auto-routed by the server — the answering checkpoint is
 * reported back in `routing.model` and kept here.
 *
 * Only `fetch` (Node ≥ 22): no HTTP dependency. Guarantees:
 *  - the internal request is validated with zod before anything is sent;
 *  - one `AbortController` bounds the whole exchange (connect + headers +
 *    body) by `timeoutMs`, and a caller's `AbortSignal` cancels it too;
 *  - the response body is read as a stream and abandoned past
 *    `maxResponseBytes`;
 *  - the answer is validated with zod; unknown fields are tolerated
 *    (`passthrough`), the fields used downstream are validated strictly;
 *  - errors are typed (`DecisionProviderError.kind`) so the breaker counts
 *    only infrastructure failures;
 *  - nothing from the state, the questions or the key is ever logged: log
 *    lines carry the error kind, the HTTP status, the latency and the
 *    correlation id — nothing else.
 */
export interface LayaHttpOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer …` only when set. */
  apiKey?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void };
}

/* ---------------------------------------------------------------------------
 * Wire schemas
 * ------------------------------------------------------------------------- */

const probability = z.number().finite().min(0).max(1);

/** A `choice` answer: the fields we use are strict, the rest (`action`, future additions) passes through. */
export const LayaChoiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string().min(1),
    probabilities: z.record(z.string(), probability).default({}),
    confidence: probability.optional(),
  })
  .passthrough()
  .superRefine((a, ctx) => {
    const values = Object.values(a.probabilities);
    if (!values.length) return;
    const sum = values.reduce((n, p) => n + p, 0);
    // Laya rounds every probability to 4 decimals: the sum drifts by at most a few 1e-4.
    if (sum < 0.95 || sum > 1.05) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["probabilities"], message: `probabilities sum to ${sum.toFixed(3)}, expected ~1` });
    if (!(a.choice in a.probabilities)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["choice"], message: "the chosen option has no probability" });
  });

/** Envelope. `answers` values are only checked for a `type` here; each is then parsed by its own schema. */
export const LayaResponseSchema = z
  .object({
    model: z.string().optional(),
    answers: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
    usage: z.object({ input_tokens: z.number().int().nonnegative().optional(), output_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
    routing: z.object({ model: z.string().optional(), reason: z.string().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();

export const LayaHealthSchema = z
  .object({
    status: z.string(),
    loaded: z.array(z.string()).optional(),
    device: z.string().optional(),
  })
  .passthrough();

/* ---------------------------------------------------------------------------
 * Adapter
 * ------------------------------------------------------------------------- */

const silent = { warn: () => undefined, debug: () => undefined };

/** Issue list without the offending values (a value could echo state content). */
const describeIssues = (issues: z.ZodIssue[]): string =>
  issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "$"}: ${i.code === z.ZodIssueCode.custom ? i.message : i.code}`)
    .join("; ");

/** Class of a thrown `fetch` error, never its message verbatim beyond a short, content-free cause code. */
function networkCause(e: unknown): string {
  const err = e as { cause?: { code?: unknown }; code?: unknown; name?: string };
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : (err?.name ?? "Error");
}

export class LayaHttpDecisionProvider implements DecisionProvider {
  readonly name = "laya-http";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: NonNullable<LayaHttpOptions["logger"]>;
  private readonly base: string;

  constructor(private readonly opts: LayaHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? silent;
    this.base = opts.baseUrl.replace(/\/+$/, "");
  }

  async evaluate(request: DecisionProviderRequest, context: DecisionCallContext = {}): Promise<DecisionProviderResponse> {
    const parsed = DecisionProviderRequestSchema.safeParse(request);
    if (!parsed.success) throw new DecisionProviderError("invalid_request", `decision request rejected before sending: ${describeIssues(parsed.error.issues)}`);
    const body = JSON.stringify(parsed.data.model ? parsed.data : { state: parsed.data.state, questions: parsed.data.questions });

    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    if (context.correlationId) headers["x-correlation-id"] = context.correlationId;

    const started = this.now();
    let text: string;
    try {
      text = await this.exchange("/v1/systemone", { method: "POST", headers, body }, context);
    } catch (e) {
      throw this.fail(e as DecisionProviderError, context, started);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw this.fail(new DecisionProviderError("invalid_response", "Laya answered with a non-JSON body"), context, started);
    }
    const envelope = LayaResponseSchema.safeParse(json);
    if (!envelope.success) throw this.fail(new DecisionProviderError("invalid_response", `unexpected Laya response shape: ${describeIssues(envelope.error.issues)}`), context, started);
    if (Object.keys(envelope.data.answers).length === 0) throw this.fail(new DecisionProviderError("invalid_response", "Laya returned no answer"), context, started);

    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, raw] of Object.entries(envelope.data.answers)) {
      // Only questions we asked are kept; future primitives (`score`, `noul`) are ignored in v1.
      if (!(id in parsed.data.questions) || raw.type !== "choice") continue;
      const answer = LayaChoiceAnswerSchema.safeParse(raw);
      if (!answer.success) throw this.fail(new DecisionProviderError("invalid_response", `invalid answer for question "${id}": ${describeIssues(answer.error.issues)}`), context, started);
      answers[id] = { type: "choice", choice: answer.data.choice, probabilities: answer.data.probabilities, confidence: answer.data.confidence };
    }

    const routing = envelope.data.routing ?? undefined;
    const latencyMs = this.now() - started;
    this.log.debug({ correlationId: context.correlationId, latencyMs, model: routing?.model ?? envelope.data.model, questions: Object.keys(answers).length }, "laya decision received");
    return {
      answers,
      model: routing?.model ?? envelope.data.model,
      routing: routing ? { model: routing.model, reason: routing.reason } : undefined,
      usage: envelope.data.usage ? { inputTokens: envelope.data.usage.input_tokens, outputTokens: envelope.data.usage.output_tokens } : undefined,
      latencyMs,
    };
  }

  /**
   * `GET /health`. No API key is sent: laya-serve does not protect the probe,
   * and the key has no business travelling where it is not needed.
   */
  async healthCheck(): Promise<DecisionProviderHealth> {
    const started = this.now();
    try {
      const text = await this.exchange("/health", { method: "GET", headers: { accept: "application/json" } }, {}, Math.min(this.opts.timeoutMs, 3_000));
      const parsed = LayaHealthSchema.safeParse(JSON.parse(text));
      const latencyMs = this.now() - started;
      if (!parsed.success) return { status: "degraded", detail: "unexpected /health payload", latencyMs };
      if (parsed.data.status !== "ok") return { status: "degraded", detail: `laya reports status "${parsed.data.status}"`, loadedModels: parsed.data.loaded, device: parsed.data.device, latencyMs };
      const loaded = parsed.data.loaded ?? [];
      return {
        status: "ok",
        detail: loaded.length ? `checkpoints loaded: ${loaded.join(", ")}` : "reachable, no checkpoint loaded yet (lazy loading: the first decision pays the load)",
        loadedModels: loaded,
        device: parsed.data.device,
        latencyMs,
      };
    } catch (e) {
      const err = e instanceof DecisionProviderError ? e : new DecisionProviderError("invalid_response", "unreadable /health payload");
      return { status: "unavailable", detail: `${err.kind}${err.status ? ` (HTTP ${err.status})` : ""}`, latencyMs: this.now() - started };
    }
  }

  /* ------------------------------------------------------------------------- */

  /**
   * One bounded HTTP exchange: timeout + caller signal + size cap. Returns the
   * body text of a 2xx answer; throws a typed `DecisionProviderError`
   * otherwise. Does not log (the caller decides whether a failure is news).
   */
  private async exchange(path: string, init: RequestInit, context: DecisionCallContext, timeoutMs = this.opts.timeoutMs): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onCallerAbort = () => controller.abort();
    if (context.signal) {
      if (context.signal.aborted) {
        clearTimeout(timer);
        throw new DecisionProviderError("aborted", "decision request cancelled by the caller");
      }
      context.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const classifyThrown = (e: unknown): DecisionProviderError => {
      if (e instanceof DecisionProviderError) return e;
      if (timedOut) return new DecisionProviderError("timeout", `Laya did not answer within ${timeoutMs} ms`);
      if (context.signal?.aborted) return new DecisionProviderError("aborted", "decision request cancelled by the caller");
      return new DecisionProviderError("network", `Laya unreachable (${networkCause(e)})`, { cause: e });
    };

    try {
      let res: Response;
      try {
        // No redirects: a 3xx could only send the bearer token somewhere unexpected.
        res = await this.fetchImpl(`${this.base}${path}`, { ...init, signal: controller.signal, redirect: "error" });
      } catch (e) {
        throw classifyThrown(e);
      }
      let text: string;
      try {
        text = await this.readLimited(res);
      } catch (e) {
        throw classifyThrown(e);
      }
      if (!res.ok) throw this.statusError(res.status);
      return text;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Body as text, abandoned as soon as it exceeds `maxResponseBytes`. */
  private async readLimited(res: Response): Promise<string> {
    const limit = this.opts.maxResponseBytes;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await res.body?.cancel().catch(() => undefined);
      throw new DecisionProviderError("response_too_large", `Laya response declared ${declared} bytes, limit is ${limit}`);
    }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new DecisionProviderError("response_too_large", `Laya response exceeded ${limit} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** HTTP status → error class. The body is never quoted: it could echo the request. */
  private statusError(status: number): DecisionProviderError {
    if (status === 401 || status === 403) return new DecisionProviderError("unauthorized", `Laya rejected the credentials (HTTP ${status}) — check LAYA_API_KEY`, { status });
    if (status === 400) return new DecisionProviderError("invalid_request", "Laya rejected the request (HTTP 400)", { status });
    if (status === 422) return new DecisionProviderError("model_error", "Laya could not run the model (HTTP 422) — check that its checkpoints are loaded", { status });
    if (status === 429) return new DecisionProviderError("rate_limited", "Laya is rate limiting (HTTP 429)", { status });
    if (status >= 500) return new DecisionProviderError("server", `Laya server error (HTTP ${status})`, { status });
    return new DecisionProviderError("http", `unexpected HTTP ${status} from Laya`, { status });
  }

  /** Log a failure (kind/status/latency only) and hand the error back for throwing. */
  private fail(error: DecisionProviderError, context: DecisionCallContext, started: number): DecisionProviderError {
    const level = error.kind === "aborted" ? "debug" : "warn";
    this.log[level]({ kind: error.kind, status: error.status, latencyMs: this.now() - started, correlationId: context.correlationId }, "laya decision failed");
    return error;
  }
}
