import type { z } from "zod";
import { LlmError } from "../../errors.js";
import type { LlmCompletion, LlmProvider, LlmRequest, LlmUseCase } from "../../ports/llm.js";
import { CircuitBreaker } from "../../util/circuit-breaker.js";

/**
 * LLM queue, two-tier model router and circuit breaker — the load governor in
 * front of the internal GPU.
 *
 * Why a queue and not "just call the model": a single vLLM replica serves a
 * bounded number of concurrent sequences. Beyond that, extra concurrency does
 * not add throughput, it only inflates every user's latency. So we admit
 * `LLM_CONCURRENCY` calls at a time and queue the rest with:
 *
 *  - **priority lanes** — `interactive` (a user is waiting in Outlook) always
 *    overtakes `background` (the precompute worker). Background work is a
 *    best-effort filler of otherwise idle GPU time.
 *  - **per-user fairness** — inside a lane, the next request goes to the user
 *    who has been served least during the current backlog (round-robin), then
 *    FIFO. One user indexing a 10-year mailbox can never starve the other 49.
 *  - **queue timeout** — a request that cannot get a slot within
 *    `LLM_QUEUE_TIMEOUT_MS` fails as `LlmError("timeout")`, which the services
 *    turn into a heuristic answer instead of a spinner.
 *  - **circuit breaker** — after `LLM_CIRCUIT_FAILURES` consecutive failures the
 *    circuit opens for `LLM_CIRCUIT_COOLDOWN_MS`: every call fails *immediately*
 *    so services degrade to heuristics with no waiting, and the model is given
 *    room to recover. One trial call is admitted when the cooldown elapses
 *    (half-open); success closes the circuit.
 *
 * The router sends cheap, structured use cases to `LLM_FAST_MODEL` (same
 * endpoint) and keeps the big model for the user-visible prose.
 */

/** Use cases served by `LLM_FAST_MODEL` when configured. */
export const FAST_USE_CASES: ReadonlySet<LlmUseCase> = new Set<LlmUseCase>(["classification", "compliance_content", "phishing_content", "triage_assist", "extraction"]);

export interface LlmQueueOptions {
  concurrency: number;
  /** Max wait for a slot before failing fast. */
  queueTimeoutMs: number;
  circuitFailures: number;
  circuitCooldownMs: number;
  /** Main model (prose). */
  model: string;
  /** Optional small model for the `FAST_USE_CASES`. */
  fastModel?: string;
  now?: () => number;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void };
  /** Observability hook, called once per completed call. */
  onCall?: (sample: LlmCallSample) => void;
}

export interface LlmCallSample {
  model: string;
  useCase: LlmUseCase;
  priority: "interactive" | "background";
  outcome: "ok" | "error" | "circuit_open" | "queue_timeout";
  latencyMs: number;
  waitMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface LlmQueueStats {
  pending: number;
  running: number;
  concurrency: number;
  avgLatencyMs?: number;
  circuitOpen: boolean;
  /** Calls rejected outright because the circuit was open. */
  shortCircuited: number;
  /** Calls that gave up waiting for a slot. */
  queueTimeouts: number;
  consecutiveFailures: number;
  totalCalls: number;
  byModel: Record<string, number>;
}

interface Waiter {
  userId: string;
  priority: 0 | 1; // 0 = interactive, 1 = background
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  settled: boolean;
}

/**
 * Wraps any `LlmProvider`. Drop-in: services keep calling `complete` /
 * `completeJson` and get queuing, routing, breaking and metrics for free.
 */
export class QueuedLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  private readonly inner: LlmProvider;
  private readonly opts: LlmQueueOptions;
  private readonly now: () => number;

  private readonly queue: Waiter[] = [];
  private readonly runningByUser = new Map<string, number>();
  /**
   * Requests admitted per user during the current backlog "round". Reset when
   * the queue drains. This is what makes the fairness real: with
   * `LLM_CONCURRENCY=1`, running counts are always 0 at the moment of picking,
   * so only a round-robin memory can stop one user's 200-message backlog from
   * being served before anyone else's single request.
   */
  private readonly servedInRound = new Map<string, number>();
  private running = 0;
  private seq = 0;

  /** Breaker state is shared logic (`util/circuit-breaker.ts`), but this instance is the LLM's alone. */
  private readonly breaker: CircuitBreaker;

  private latencySum = 0;
  private latencyCount = 0;
  private shortCircuited = 0;
  private queueTimeouts = 0;
  private totalCalls = 0;
  private readonly byModel = new Map<string, number>();

  constructor(inner: LlmProvider, opts: LlmQueueOptions) {
    this.inner = inner;
    this.opts = opts;
    this.name = inner.name;
    this.model = opts.model || inner.model;
    this.now = opts.now ?? (() => Date.now());
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.circuitFailures,
      cooldownMs: opts.circuitCooldownMs,
      now: this.now,
      onOpen: ({ failures, cooldownMs }) => this.opts.logger?.warn({ failures, cooldownMs }, "llm circuit opened — degrading to heuristics"),
    });
  }

  /* ------------------------------- routing ------------------------------ */

  /** Model for a request: explicit override → fast tier → main model. */
  modelFor(req: LlmRequest): string {
    if (req.model) return req.model;
    if (this.opts.fastModel && req.useCase && FAST_USE_CASES.has(req.useCase)) return this.opts.fastModel;
    return this.model;
  }

  /* --------------------------- circuit breaker -------------------------- */

  get circuitOpen(): boolean {
    return this.breaker.isOpen;
  }

  /** True when the circuit is closed, or when the cooldown elapsed and this is the single trial call. */
  private canProbe(): boolean {
    return this.breaker.tryAcquire();
  }

  private onSuccess(): void {
    this.breaker.recordSuccess();
  }

  private onFailure(): void {
    this.breaker.recordFailure();
  }

  /* ------------------------------ scheduling ---------------------------- */

  /**
   * Pick the next waiter: lane first, then the user least served in this
   * backlog round, then arrival order. O(n) over the queue, which stays tiny.
   */
  private pickNext(): Waiter | undefined {
    let best: Waiter | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const w of this.queue) {
      if (w.settled) continue;
      const load = (this.runningByUser.get(w.userId) ?? 0) + (this.servedInRound.get(w.userId) ?? 0);
      // Lane dominates; then how much this user already got this round; then arrival order.
      const score = w.priority * 1e12 + load * 1e6 + w.seq;
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
    return best;
  }

  private drain(): void {
    while (this.running < this.opts.concurrency) {
      const next = this.pickNext();
      if (!next) {
        // Backlog cleared: the round is over, everyone starts equal again.
        if (!this.queue.some((w) => !w.settled)) this.servedInRound.clear();
        return;
      }
      const idx = this.queue.indexOf(next);
      if (idx >= 0) this.queue.splice(idx, 1);
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      this.running++;
      this.runningByUser.set(next.userId, (this.runningByUser.get(next.userId) ?? 0) + 1);
      this.servedInRound.set(next.userId, (this.servedInRound.get(next.userId) ?? 0) + 1);
      next.resolve();
    }
  }

  private release(userId: string): void {
    this.running = Math.max(0, this.running - 1);
    const n = (this.runningByUser.get(userId) ?? 1) - 1;
    if (n <= 0) this.runningByUser.delete(userId);
    else this.runningByUser.set(userId, n);
    this.drain();
  }

  /** Wait for a slot. Resolves with a release function. */
  private acquire(req: LlmRequest): Promise<() => void> {
    const userId = req.userId ?? "anonymous";
    if (this.running < this.opts.concurrency && !this.queue.some((w) => !w.settled)) {
      this.running++;
      this.runningByUser.set(userId, (this.runningByUser.get(userId) ?? 0) + 1);
      return Promise.resolve(() => this.release(userId));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        userId,
        priority: req.priority === "background" ? 1 : 0,
        seq: this.seq++,
        settled: false,
        resolve: () => resolve(() => this.release(userId)),
        reject,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) this.queue.splice(idx, 1);
        this.queueTimeouts++;
        reject(new LlmError("timeout", `LLM queue timeout: no slot within ${this.opts.queueTimeoutMs} ms (${this.queue.length} waiting, ${this.running} running)`));
      }, this.opts.queueTimeoutMs);
      waiter.timer.unref?.();
      this.queue.push(waiter);
      this.drain();
    });
  }

  /* -------------------------------- calls ------------------------------- */

  private record(sample: LlmCallSample): void {
    this.totalCalls++;
    this.byModel.set(sample.model, (this.byModel.get(sample.model) ?? 0) + 1);
    if (sample.outcome === "ok") {
      this.latencySum += sample.latencyMs;
      this.latencyCount++;
    }
    this.opts.onCall?.(sample);
  }

  private async guarded<T>(req: LlmRequest, run: (routed: LlmRequest) => Promise<{ result: T; usage?: LlmCompletion["usage"] }>): Promise<T> {
    const useCase = req.useCase ?? "generic";
    const priority = req.priority === "background" ? "background" : "interactive";
    const model = this.modelFor(req);

    if (!this.canProbe()) {
      this.shortCircuited++;
      this.record({ model, useCase, priority, outcome: "circuit_open", latencyMs: 0, waitMs: 0 });
      throw new LlmError("network", `LLM circuit open after ${this.breaker.failures} consecutive failures — degraded mode`);
    }

    const queuedAt = this.now();
    let release: () => void;
    try {
      release = await this.acquire(req);
    } catch (e) {
      // A probe that never got a slot must not keep the half-open state locked.
      this.breaker.abandonProbe();
      this.record({ model, useCase, priority, outcome: "queue_timeout", latencyMs: 0, waitMs: this.now() - queuedAt });
      throw e;
    }
    const waitMs = this.now() - queuedAt;
    const startedAt = this.now();
    try {
      const { result, usage } = await run({ ...req, model });
      this.onSuccess();
      this.record({ model, useCase, priority, outcome: "ok", latencyMs: this.now() - startedAt, waitMs, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens });
      return result;
    } catch (e) {
      // An invalid-output error is the model's answer, not an outage: do not open the circuit for it.
      const outputOnly = e instanceof LlmError && e.kind === "output";
      if (outputOnly) this.onSuccess();
      else this.onFailure();
      this.record({ model, useCase, priority, outcome: "error", latencyMs: this.now() - startedAt, waitMs });
      throw e;
    } finally {
      release();
    }
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    return this.guarded(req, async (routed) => {
      const r = await this.inner.complete(routed);
      return { result: r, usage: r.usage };
    });
  }

  async completeJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: LlmRequest): Promise<{ data: T; model: string; repaired: boolean; raw: string }> {
    return this.guarded(req, async (routed) => {
      const r = await this.inner.completeJson(schema, routed);
      return { result: r, usage: undefined };
    });
  }

  /** Probes bypass the queue and the breaker: `/health` must answer even when saturated. */
  ping(timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
    return this.inner.ping(timeoutMs);
  }

  get stats(): LlmQueueStats {
    return {
      pending: this.queue.filter((w) => !w.settled).length,
      running: this.running,
      concurrency: this.opts.concurrency,
      avgLatencyMs: this.latencyCount ? Math.round(this.latencySum / this.latencyCount) : undefined,
      circuitOpen: this.circuitOpen,
      shortCircuited: this.shortCircuited,
      queueTimeouts: this.queueTimeouts,
      consecutiveFailures: this.breaker.failures,
      totalCalls: this.totalCalls,
      byModel: Object.fromEntries(this.byModel),
    };
  }

  /** Test helper: forget the breaker state. */
  resetCircuit(): void {
    this.breaker.reset();
  }
}
