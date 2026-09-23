import { describe, expect, it } from "vitest";
import { MockDecisionProvider } from "../../src/adapters/decision/mock.js";
import { ResilientDecisionProvider, type DecisionCallSample } from "../../src/adapters/decision/resilient.js";
import { DecisionProviderError, type DecisionProvider, type DecisionProviderRequest, type DecisionProviderResponse } from "../../src/ports/decision.js";
import { CircuitBreaker } from "../../src/util/circuit-breaker.js";
import { PrioritySemaphore, SemaphoreAbortedError, SemaphoreTimeoutError } from "../../src/util/semaphore.js";

const tick = () => new Promise((r) => setImmediate(r));

const req: DecisionProviderRequest = {
  state: { subject: "s", body: "b" },
  questions: { urgency: { type: "choice", instructions: "i", criteria: { low: "l", high: "h" } } },
};

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures, rejects during the cooldown, admits one probe, closes on success", () => {
    let now = 0;
    const events: string[] = [];
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => now, onOpen: () => events.push("open"), onClose: () => events.push("close") });
    expect(b.state).toBe("closed");
    b.recordFailure();
    b.recordFailure();
    expect(b.tryAcquire()).toBe(true);
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(b.isOpen).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    now = 999;
    expect(b.tryAcquire()).toBe(false);
    now = 1000;
    expect(b.state).toBe("half_open");
    expect(b.tryAcquire()).toBe(true); // the probe
    expect(b.tryAcquire()).toBe(false); // only one
    b.recordSuccess();
    expect(b.state).toBe("closed");
    expect(b.failures).toBe(0);
    expect(events).toEqual(["open", "close"]);
  });

  it("a failed probe restarts a full cooldown; an abandoned probe frees the half-open slot", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => now });
    b.recordFailure();
    now = 100;
    expect(b.tryAcquire()).toBe(true);
    b.recordFailure();
    expect(b.state).toBe("open");
    now = 150;
    expect(b.tryAcquire()).toBe(false);
    now = 200;
    expect(b.tryAcquire()).toBe(true);
    b.abandonProbe();
    expect(b.tryAcquire()).toBe(true);
  });

  it("a success resets the count before the threshold (consecutive, not total)", () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.state).toBe("closed");
  });
});

describe("PrioritySemaphore", () => {
  it("bounds concurrency, serves interactive before background, FIFO within a lane", async () => {
    const s = new PrioritySemaphore(1);
    const order: string[] = [];
    const first = await s.acquire({ timeoutMs: 1000 });
    const bg = s.acquire({ priority: "background", timeoutMs: 1000 }).then((r) => (order.push("bg"), r));
    const i1 = s.acquire({ priority: "interactive", timeoutMs: 1000 }).then((r) => (order.push("i1"), r));
    const i2 = s.acquire({ timeoutMs: 1000 }).then((r) => (order.push("i2"), r));
    expect(s.inFlight).toBe(1);
    expect(s.pending).toBe(3);
    first();
    (await i1)();
    (await i2)();
    (await bg)();
    expect(order).toEqual(["i1", "i2", "bg"]);
    expect(s.inFlight).toBe(0);
  });

  it("times out and aborts waiters; a released slot is released once", async () => {
    const s = new PrioritySemaphore(1);
    const held = await s.acquire({ timeoutMs: 1000 });
    await expect(s.acquire({ timeoutMs: 20 })).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    const controller = new AbortController();
    const waiting = s.acquire({ timeoutMs: 1000, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(SemaphoreAbortedError);
    expect(s.pending).toBe(0);
    held();
    held(); // idempotent
    expect(s.inFlight).toBe(0);
    const again = await s.acquire({ timeoutMs: 10 });
    expect(s.inFlight).toBe(1);
    again();
  });

  it("rejects a non-positive limit", () => {
    expect(() => new PrioritySemaphore(0)).toThrow(RangeError);
  });
});

/** Inner provider whose calls park until released. */
class ParkedProvider implements DecisionProvider {
  readonly name = "parked";
  readonly started: DecisionProviderRequest[] = [];
  private readonly gates: Array<(r: DecisionProviderResponse | Error) => void> = [];
  async evaluate(request: DecisionProviderRequest): Promise<DecisionProviderResponse> {
    this.started.push(request);
    return new Promise((resolve, reject) => this.gates.push((v) => (v instanceof Error ? reject(v) : resolve(v))));
  }
  release(i = 0, v: DecisionProviderResponse | Error = { answers: {}, latencyMs: 1 }) {
    this.gates[i]?.(v);
  }
}

const wrap = (inner: DecisionProvider, over: Partial<ConstructorParameters<typeof ResilientDecisionProvider>[1]> = {}) => {
  const samples: DecisionCallSample[] = [];
  const p = new ResilientDecisionProvider(inner, { concurrency: 1, queueTimeoutMs: 1000, circuitFailureThreshold: 3, circuitCooldownMs: 1000, onCall: (s) => samples.push(s), ...over });
  return { p, samples };
};

describe("ResilientDecisionProvider", () => {
  it("never runs more than LAYA_CONCURRENCY calls at once", async () => {
    const inner = new ParkedProvider();
    const { p } = wrap(inner, { concurrency: 2 });
    const calls = [p.evaluate(req), p.evaluate(req), p.evaluate(req)];
    await tick();
    expect(inner.started).toHaveLength(2);
    expect(p.stats).toMatchObject({ inFlight: 2, pending: 1, concurrency: 2 });
    inner.release(0);
    await tick();
    await tick();
    expect(inner.started).toHaveLength(3);
    inner.release(1);
    inner.release(2);
    await Promise.all(calls);
    expect(p.stats.inFlight).toBe(0);
  });

  it("a call that cannot get a slot in time fails fast as queue_timeout (not a provider failure)", async () => {
    const inner = new ParkedProvider();
    const { p, samples } = wrap(inner, { queueTimeoutMs: 20 });
    const first = p.evaluate(req);
    await tick();
    const e = await p.evaluate(req).catch((x) => x as DecisionProviderError);
    expect(e).toBeInstanceOf(DecisionProviderError);
    expect(e.kind).toBe("queue_timeout");
    expect(p.circuitState).toBe("closed");
    expect(p.stats.queueTimeouts).toBe(1);
    inner.release(0);
    await first;
    expect(samples.map((s) => s.outcome)).toEqual(["queue_timeout", "ok"]);
  });

  it("opens after N infrastructure failures, then rejects without calling the provider", async () => {
    let now = 0;
    const inner = new MockDecisionProvider().failWith("server");
    const { p, samples } = wrap(inner, { now: () => now });
    for (let i = 0; i < 3; i++) await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "server" });
    expect(p.circuitState).toBe("open");
    const callsBefore = inner.calls;
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "circuit_open" });
    expect(inner.calls).toBe(callsBefore);
    expect(p.stats).toMatchObject({ failures: 3, shortCircuited: 1, consecutiveFailures: 3 });
    expect(samples.at(-1)?.outcome).toBe("circuit_open");

    // Cooldown elapsed: one probe; the provider recovered → closed.
    now = 1_000;
    inner.recover();
    await expect(p.evaluate(req)).resolves.toMatchObject({ answers: expect.any(Object) });
    expect(p.circuitState).toBe("closed");
  });

  it("malformed requests (400), caller aborts and the engine being disabled do not open the circuit", async () => {
    const inner = new MockDecisionProvider().failWith("invalid_request");
    const { p } = wrap(inner, { circuitFailureThreshold: 1 });
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "invalid_request" });
    expect(p.circuitState).toBe("closed");
    inner.failWith("aborted");
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "aborted" });
    expect(p.circuitState).toBe("closed");
  });

  it("a model error (HTTP 422: checkpoint missing, load failure) counts: the engine cannot answer anyone", async () => {
    const inner = new MockDecisionProvider().failWith("model_error");
    const { p } = wrap(inner, { circuitFailureThreshold: 2 });
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "model_error" });
    expect(p.circuitState).toBe("closed");
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "model_error" });
    expect(p.circuitState).toBe("open");
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "circuit_open" });
  });

  it("an unexpected exception from the adapter is typed `internal` and counts as a failure", async () => {
    const broken: DecisionProvider = { name: "broken", evaluate: async () => Promise.reject(new TypeError("bug")) };
    const { p } = wrap(broken, { circuitFailureThreshold: 1 });
    await expect(p.evaluate(req)).rejects.toMatchObject({ kind: "internal" });
    expect(p.circuitState).toBe("open");
  });

  it("health bypasses the breaker and the queue", async () => {
    const inner = new MockDecisionProvider().failWith("server");
    const { p } = wrap(inner, { circuitFailureThreshold: 1 });
    await p.evaluate(req).catch(() => undefined);
    expect(p.circuitState).toBe("open");
    expect((await p.healthCheck()).status).toBe("ok");
    const noProbe = wrap({ name: "bare", evaluate: async () => ({ answers: {}, latencyMs: 0 }) }).p;
    expect((await noProbe.healthCheck()).status).toBe("ok");
  });

  it("interactive calls overtake queued background calls", async () => {
    const inner = new ParkedProvider();
    const { p } = wrap(inner);
    const first = p.evaluate(req);
    await tick();
    const bg = p.evaluate({ ...req, state: { who: "bg" } }, { priority: "background" });
    const fg = p.evaluate({ ...req, state: { who: "fg" } }, { priority: "interactive" });
    inner.release(0);
    await first;
    await tick();
    expect(inner.started[1]?.state).toEqual({ who: "fg" });
    inner.release(1);
    await fg;
    await tick();
    inner.release(2);
    await bg;
  });
});
