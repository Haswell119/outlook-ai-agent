/**
 * Consecutive-failure circuit breaker, shared by the LLM queue
 * (`adapters/llm/queue.ts`) and the decision provider wrapper
 * (`adapters/decision/resilient.ts`). Each dependency owns its own instance:
 * an LLM outage must never short-circuit the decision engine, and vice versa.
 *
 *  - **closed** — calls go through; consecutive failures are counted.
 *  - **open** — after `failureThreshold` consecutive failures every call is
 *    rejected immediately for `cooldownMs`, so callers degrade with no waiting
 *    and the dependency gets room to recover.
 *  - **half-open** — once the cooldown elapsed, exactly one trial call is
 *    admitted. Success closes the circuit; failure re-opens it for another
 *    full cooldown.
 *
 * Which errors count is the caller's decision (`recordFailure` vs
 * `recordSuccess`): an invalid model answer or a rejected request says nothing
 * about the dependency's health and must not open the circuit.
 */
export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
  /** Called once when the circuit opens (not on every failed probe). */
  onOpen?: (info: { failures: number; cooldownMs: number }) => void;
  /** Called when a success closes a circuit that had opened. */
  onClose?: () => void;
}

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  private get tripped(): boolean {
    return this.consecutiveFailures >= this.opts.failureThreshold;
  }

  get state(): CircuitState {
    if (!this.tripped) return "closed";
    return this.now() - this.openedAt < this.opts.cooldownMs ? "open" : "half_open";
  }

  /** True while calls are rejected outright (cooldown not elapsed). */
  get isOpen(): boolean {
    return this.state === "open";
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Admission control. True when a call may proceed: always while closed, and
   * for exactly one caller once the cooldown elapsed (the half-open probe).
   */
  tryAcquire(): boolean {
    if (!this.tripped) return true;
    if (this.now() - this.openedAt < this.opts.cooldownMs) return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /** Give back an admitted probe that never reached the dependency (e.g. no queue slot). */
  abandonProbe(): void {
    this.probeInFlight = false;
  }

  recordSuccess(): void {
    const wasTripped = this.tripped;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
    if (wasTripped) this.opts.onClose?.();
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.probeInFlight = false;
    if (this.consecutiveFailures === this.opts.failureThreshold) {
      this.openedAt = this.now();
      this.opts.onOpen?.({ failures: this.consecutiveFailures, cooldownMs: this.opts.cooldownMs });
    } else if (this.consecutiveFailures > this.opts.failureThreshold) {
      // A failed probe (or a late failure of a call admitted before the trip): restart the cooldown.
      this.openedAt = this.now();
    }
  }

  /** Test / admin helper: forget everything. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
  }
}
