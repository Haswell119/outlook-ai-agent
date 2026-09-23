import {
  DecisionProviderError,
  type DecisionCallContext,
  type DecisionProvider,
  type DecisionProviderErrorKind,
  type DecisionProviderHealth,
  type DecisionProviderRequest,
  type DecisionProviderResponse,
} from "../../ports/decision.js";
import { CircuitBreaker, type CircuitState } from "../../util/circuit-breaker.js";
import { PrioritySemaphore, SemaphoreTimeoutError } from "../../util/semaphore.js";

/**
 * Resilience in front of any `DecisionProvider`: a circuit breaker of its own
 * (never shared with the LLM's — the two dependencies fail independently) and
 * a bounded concurrency gate.
 *
 *  - **Concurrency** — at most `concurrency` calls in flight from this
 *    orchestrator process. A `laya-serve` pod serialises inference (one
 *    forward pass at a time); sending it more concurrent calls only moves the
 *    queue there, without timeout or priority. Scale Laya horizontally
 *    (replicas behind the Service) and raise `LAYA_CONCURRENCY` with it.
 *  - **Bounded wait** — a call that cannot get a slot within
 *    `queueTimeoutMs` fails as `queue_timeout`; the caller falls back.
 *  - **Circuit breaker** — after `circuitFailureThreshold` consecutive
 *    infrastructure failures (network, timeout, 5xx, 429, 401/403, 422 model
 *    errors, invalid or oversized answers) every call fails immediately with
 *    `circuit_open` for `circuitCooldownMs`, then a single probe is admitted
 *    (half-open). A malformed request (400) or a caller abort does not count.
 *
 * `healthCheck` bypasses both: `/health` must answer even when saturated.
 */
export interface ResilienceOptions {
  concurrency: number;
  queueTimeoutMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  now?: () => number;
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
  /** One sample per `evaluate` call, rejected ones included (metrics hook). */
  onCall?: (sample: DecisionCallSample) => void;
}

export interface DecisionCallSample {
  outcome: "ok" | DecisionProviderErrorKind;
  /** Provider call duration (0 when rejected before calling). */
  latencyMs: number;
  /** Time spent waiting for a concurrency slot. */
  waitMs: number;
}

export interface DecisionProviderStats {
  circuit: CircuitState;
  consecutiveFailures: number;
  inFlight: number;
  pending: number;
  concurrency: number;
  totalCalls: number;
  /** Calls that ended in an infrastructure failure (the ones the breaker counts). */
  failures: number;
  shortCircuited: number;
  queueTimeouts: number;
  avgLatencyMs?: number;
  byOutcome: Record<string, number>;
}

export class ResilientDecisionProvider implements DecisionProvider {
  readonly name: string;
  private readonly breaker: CircuitBreaker;
  private readonly gate: PrioritySemaphore;
  private readonly now: () => number;

  private totalCalls = 0;
  private failures = 0;
  private shortCircuited = 0;
  private queueTimeouts = 0;
  private latencySum = 0;
  private latencyCount = 0;
  private readonly byOutcome = new Map<string, number>();

  constructor(
    readonly inner: DecisionProvider,
    private readonly opts: ResilienceOptions,
  ) {
    this.name = inner.name;
    this.now = opts.now ?? (() => Date.now());
    this.gate = new PrioritySemaphore(opts.concurrency);
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.circuitFailureThreshold,
      cooldownMs: opts.circuitCooldownMs,
      now: this.now,
      onOpen: ({ failures, cooldownMs }) => opts.logger?.warn({ provider: this.name, failures, cooldownMs }, "decision provider circuit opened — falling back without calling it"),
      onClose: () => opts.logger?.info({ provider: this.name }, "decision provider circuit closed — provider answering again"),
    });
  }

  async evaluate(request: DecisionProviderRequest, context: DecisionCallContext = {}): Promise<DecisionProviderResponse> {
    if (!this.breaker.tryAcquire()) {
      this.shortCircuited++;
      this.record({ outcome: "circuit_open", latencyMs: 0, waitMs: 0 });
      throw new DecisionProviderError("circuit_open", `decision provider circuit open after ${this.breaker.failures} consecutive failures`);
    }

    const queuedAt = this.now();
    let release: () => void;
    try {
      release = await this.gate.acquire({ priority: context.priority, timeoutMs: this.opts.queueTimeoutMs, signal: context.signal });
    } catch (e) {
      // A probe that never reached the provider must not keep the half-open slot locked.
      this.breaker.abandonProbe();
      const error =
        e instanceof SemaphoreTimeoutError
          ? new DecisionProviderError("queue_timeout", `no decision slot within ${this.opts.queueTimeoutMs} ms (LAYA_CONCURRENCY=${this.opts.concurrency})`)
          : new DecisionProviderError("aborted", "decision request cancelled while queued");
      if (error.kind === "queue_timeout") this.queueTimeouts++;
      this.record({ outcome: error.kind, latencyMs: 0, waitMs: this.now() - queuedAt });
      throw error;
    }

    const waitMs = this.now() - queuedAt;
    const started = this.now();
    try {
      const response = await this.inner.evaluate(request, context);
      this.breaker.recordSuccess();
      const latencyMs = this.now() - started;
      this.latencySum += latencyMs;
      this.latencyCount++;
      this.record({ outcome: "ok", latencyMs, waitMs });
      return response;
    } catch (e) {
      const error = e instanceof DecisionProviderError ? e : new DecisionProviderError("internal", `unexpected decision provider error (${(e as Error)?.name ?? "Error"})`, { cause: e });
      if (error.countsAsFailure) {
        this.failures++;
        this.breaker.recordFailure();
      } else if (error.kind === "aborted") {
        this.breaker.abandonProbe();
      } else {
        // The provider answered (e.g. 400): it is alive, whatever it thought of this request.
        this.breaker.recordSuccess();
      }
      this.record({ outcome: error.kind, latencyMs: this.now() - started, waitMs });
      throw error;
    } finally {
      release();
    }
  }

  async healthCheck(): Promise<DecisionProviderHealth> {
    if (!this.inner.healthCheck) return { status: "ok", detail: `${this.inner.name}: no health probe` };
    return this.inner.healthCheck();
  }

  get circuitState(): CircuitState {
    return this.breaker.state;
  }

  get stats(): DecisionProviderStats {
    return {
      circuit: this.breaker.state,
      consecutiveFailures: this.breaker.failures,
      inFlight: this.gate.inFlight,
      pending: this.gate.pending,
      concurrency: this.opts.concurrency,
      totalCalls: this.totalCalls,
      failures: this.failures,
      shortCircuited: this.shortCircuited,
      queueTimeouts: this.queueTimeouts,
      avgLatencyMs: this.latencyCount ? Math.round(this.latencySum / this.latencyCount) : undefined,
      byOutcome: Object.fromEntries(this.byOutcome),
    };
  }

  /** Test / admin helper. */
  resetCircuit(): void {
    this.breaker.reset();
  }

  private record(sample: DecisionCallSample): void {
    this.totalCalls++;
    this.byOutcome.set(sample.outcome, (this.byOutcome.get(sample.outcome) ?? 0) + 1);
    this.opts.onCall?.(sample);
  }
}
