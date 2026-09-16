import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FAST_USE_CASES, QueuedLlmProvider } from "../../src/adapters/llm/queue.js";
import { CachedEmbeddingProvider } from "../../src/adapters/llm/cached-embeddings.js";
import { MemoryEmbeddingCacheRepository } from "../../src/adapters/memory/caches.js";
import { LlmError } from "../../src/errors.js";
import type { LlmCompletion, LlmProvider, LlmRequest } from "../../src/ports/llm.js";
import type { EmbeddingProvider } from "../../src/ports/llm.js";

/** Controllable provider: every call parks until the test resolves it. */
class ControlledProvider implements LlmProvider {
  readonly name = "controlled";
  readonly model = "big-model";
  readonly started: LlmRequest[] = [];
  private readonly gates: Array<(v: LlmCompletion | Error) => void> = [];
  failNext = 0;
  instantFailure = false;

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.started.push(req);
    if (this.instantFailure || this.failNext > 0) {
      if (this.failNext > 0) this.failNext--;
      throw new LlmError("network", "model down");
    }
    return new Promise<LlmCompletion>((resolve, reject) => {
      this.gates.push((v) => (v instanceof Error ? reject(v) : resolve(v)));
    });
  }
  async completeJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: LlmRequest) {
    const r = await this.complete(req);
    return { data: schema.parse(JSON.parse(r.text)), model: r.model, repaired: false, raw: r.text };
  }
  async ping() {
    return { ok: true };
  }
  /** Release the n-th parked call. */
  release(index = 0, text = '{"ok":true}') {
    this.gates[index]?.({ text, model: this.model, usage: { promptTokens: 100, completionTokens: 20 } });
  }
  releaseAll(text = '{"ok":true}') {
    for (let i = 0; i < this.gates.length; i++) this.release(i, text);
  }
  get parked() {
    return this.gates.length;
  }
  /** Release everything, repeatedly, so calls admitted by a release also finish. */
  async drain(rounds = 8, text = '{"ok":true}') {
    for (let i = 0; i < rounds; i++) {
      this.releaseAll(text);
      await new Promise((r) => setImmediate(r));
    }
  }
}

const opts = (over: Partial<ConstructorParameters<typeof QueuedLlmProvider>[1]> = {}) => ({
  concurrency: 2,
  queueTimeoutMs: 1000,
  circuitFailures: 3,
  circuitCooldownMs: 1000,
  model: "big-model",
  ...over,
});

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ messages: [{ role: "user", content: "hi" }], ...over });

describe("QueuedLlmProvider — concurrency", () => {
  it("admits at most `concurrency` calls and queues the rest", async () => {
    const inner = new ControlledProvider();
    const q = new QueuedLlmProvider(inner, opts({ concurrency: 2 }));
    const calls = [q.complete(req()), q.complete(req()), q.complete(req())];
    await new Promise((r) => setImmediate(r));

    expect(inner.started).toHaveLength(2);
    expect(q.stats.running).toBe(2);
    expect(q.stats.pending).toBe(1);

    inner.release(0);
    await new Promise((r) => setImmediate(r));
    expect(inner.started).toHaveLength(3); // the queued one got the freed slot

    await inner.drain();
    await Promise.all(calls);
    expect(q.stats.running).toBe(0);
    expect(q.stats.pending).toBe(0);
  });

  it("interactive requests overtake background ones", async () => {
    const inner = new ControlledProvider();
    const q = new QueuedLlmProvider(inner, opts({ concurrency: 1 }));
    const running = q.complete(req({ userId: "u0" }));
    await new Promise((r) => setImmediate(r));

    const background = q.complete(req({ userId: "u1", priority: "background", useCase: "email_analysis", temperature: 0.11 }));
    const interactive = q.complete(req({ userId: "u2", priority: "interactive", temperature: 0.22 }));
    await new Promise((r) => setImmediate(r));
    expect(q.stats.pending).toBe(2);

    inner.release(0);
    await new Promise((r) => setImmediate(r));
    // The second call actually sent to the model is the interactive one.
    expect(inner.started[1]!.temperature).toBe(0.22);

    await inner.drain();
    await Promise.all([running, background, interactive]);
  });

  it("is fair between users: a heavy user cannot starve the others", async () => {
    const inner = new ControlledProvider();
    const q = new QueuedLlmProvider(inner, opts({ concurrency: 1 }));
    const first = q.complete(req({ userId: "heavy", temperature: 0.1 }));
    await new Promise((r) => setImmediate(r));

    // "heavy" queues three more; "light" queues one, later.
    const rest = [q.complete(req({ userId: "heavy", temperature: 0.2 })), q.complete(req({ userId: "heavy", temperature: 0.3 })), q.complete(req({ userId: "light", temperature: 0.9 }))];
    await new Promise((r) => setImmediate(r));

    inner.release(0);
    await new Promise((r) => setImmediate(r));
    // heavy has 0 running now, but its queued items arrived first; light must not wait behind all of them.
    expect(inner.started[1]!.temperature).toBe(0.2);
    inner.release(1);
    await new Promise((r) => setImmediate(r));
    expect(inner.started[2]!.temperature).toBe(0.9); // light overtakes heavy's third item

    await inner.drain();
    await Promise.all([first, ...rest]);
  });

  it("fails a request that cannot get a slot within the queue timeout", async () => {
    vi.useFakeTimers();
    try {
      const inner = new ControlledProvider();
      const q = new QueuedLlmProvider(inner, opts({ concurrency: 1, queueTimeoutMs: 50 }));
      const running = q.complete(req());
      await Promise.resolve();
      const queued = q.complete(req());
      const assertion = expect(queued).rejects.toThrow(/queue timeout/i);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(q.stats.queueTimeouts).toBe(1);
      inner.releaseAll();
      await vi.advanceTimersByTimeAsync(1);
      await running;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("QueuedLlmProvider — circuit breaker", () => {
  it("opens after N consecutive failures and then fails immediately (no waiting)", async () => {
    const now = { t: 0 };
    const inner = new ControlledProvider();
    inner.instantFailure = true;
    const q = new QueuedLlmProvider(inner, opts({ circuitFailures: 3, circuitCooldownMs: 1000, now: () => now.t }));

    for (let i = 0; i < 3; i++) await expect(q.complete(req())).rejects.toThrow("model down");
    expect(q.circuitOpen).toBe(true);
    expect(q.stats.consecutiveFailures).toBe(3);

    const before = inner.started.length;
    await expect(q.complete(req())).rejects.toThrow(/circuit open/i);
    // The provider was never contacted: services degrade to heuristics instantly.
    expect(inner.started).toHaveLength(before);
    expect(q.stats.shortCircuited).toBe(1);
  });

  it("half-opens after the cooldown and closes on a successful probe", async () => {
    const now = { t: 0 };
    const inner = new ControlledProvider();
    inner.instantFailure = true;
    const q = new QueuedLlmProvider(inner, opts({ circuitFailures: 2, circuitCooldownMs: 500, now: () => now.t }));

    await expect(q.complete(req())).rejects.toThrow();
    await expect(q.complete(req())).rejects.toThrow();
    expect(q.circuitOpen).toBe(true);

    now.t = 600; // cooldown elapsed
    inner.instantFailure = false;
    const probe = q.complete(req());
    await new Promise((r) => setImmediate(r));
    inner.release(0);
    await probe;
    expect(q.circuitOpen).toBe(false);
    expect(q.stats.consecutiveFailures).toBe(0);
  });

  it("a schema-validation failure does not open the circuit (the model answered)", async () => {
    const inner = new ControlledProvider();
    const q = new QueuedLlmProvider(inner, opts({ circuitFailures: 2 }));
    inner.complete = async () => {
      throw new LlmError("output", "schema mismatch");
    };
    await expect(q.complete(req())).rejects.toThrow("schema mismatch");
    await expect(q.complete(req())).rejects.toThrow("schema mismatch");
    expect(q.circuitOpen).toBe(false);
  });

  it("records stats and calls the observability hook", async () => {
    const samples: Array<{ outcome: string; model: string }> = [];
    const inner = new ControlledProvider();
    const q = new QueuedLlmProvider(inner, opts({ onCall: (s) => samples.push(s) }));
    const p = q.complete(req({ useCase: "email_analysis" }));
    await new Promise((r) => setImmediate(r));
    inner.release(0);
    await p;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ outcome: "ok", model: "big-model" });
    expect(q.stats.totalCalls).toBe(1);
    expect(q.stats.byModel["big-model"]).toBe(1);
    expect(q.stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("QueuedLlmProvider — two-tier model routing", () => {
  const inner = new ControlledProvider();
  const q = new QueuedLlmProvider(inner, opts({ fastModel: "small-model" }));

  it("routes the cheap use cases to LLM_FAST_MODEL", () => {
    for (const useCase of FAST_USE_CASES) expect(q.modelFor(req({ useCase }))).toBe("small-model");
  });

  it("keeps the main model for user-visible prose", () => {
    for (const useCase of ["email_analysis", "thread_synthesis", "draft_reply", "chat_answer", "daily_brief"] as const) expect(q.modelFor(req({ useCase }))).toBe("big-model");
  });

  it("an explicit model always wins, and no fast model means one tier", () => {
    expect(q.modelFor(req({ useCase: "classification", model: "forced" }))).toBe("forced");
    const single = new QueuedLlmProvider(inner, opts());
    expect(single.modelFor(req({ useCase: "classification" }))).toBe("big-model");
  });

  it("passes the routed model down to the provider", async () => {
    const p = q.complete(req({ useCase: "classification" }));
    await new Promise((r) => setImmediate(r));
    expect(inner.started.at(-1)!.model).toBe("small-model");
    await inner.drain();
    await p;
  });
});

describe("CachedEmbeddingProvider", () => {
  class CountingEmbeddings implements EmbeddingProvider {
    readonly model = "bge-m3";
    readonly dimensions = 4;
    batches: number[] = [];
    async embed(texts: string[]): Promise<number[][]> {
      this.batches.push(texts.length);
      return texts.map((t) => [t.length, 1, 0, 0]);
    }
  }

  it("never re-embeds text it has already seen", async () => {
    const inner = new CountingEmbeddings();
    const repo = new MemoryEmbeddingCacheRepository();
    const cached = new CachedEmbeddingProvider(inner, repo, { batchSize: 64, ttlDays: 1 });

    const first = await cached.embed(["alpha", "beta"]);
    expect(inner.batches).toEqual([2]);
    const second = await cached.embed(["alpha", "beta", "gamma"]);
    expect(inner.batches).toEqual([2, 1]); // only "gamma" was embedded
    expect(second[0]).toEqual(first[0]);
    expect(cached.stats).toEqual({ hits: 2, misses: 3 });
    expect(await repo.count()).toBe(3);
  });

  it("deduplicates repeated text inside one call", async () => {
    const inner = new CountingEmbeddings();
    const cached = new CachedEmbeddingProvider(inner, new MemoryEmbeddingCacheRepository(), { batchSize: 64, ttlDays: 1 });
    const out = await cached.embed(["same", "same", "same"]);
    expect(inner.batches).toEqual([1]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(out[2]);
  });

  it("batches large inputs", async () => {
    const inner = new CountingEmbeddings();
    const cached = new CachedEmbeddingProvider(inner, new MemoryEmbeddingCacheRepository(), { batchSize: 10, ttlDays: 1 });
    await cached.embed(Array.from({ length: 25 }, (_, i) => `text-${i}`));
    expect(inner.batches).toEqual([10, 10, 5]);
  });

  it("degrades to a direct call when the cache is broken", async () => {
    const inner = new CountingEmbeddings();
    const broken = {
      getMany: async () => {
        throw new Error("db down");
      },
      putMany: async () => {
        throw new Error("db down");
      },
      purgeExpired: async () => 0,
      count: async () => 0,
    };
    const cached = new CachedEmbeddingProvider(inner, broken, { batchSize: 64, ttlDays: 1 });
    const out = await cached.embed(["still works"]);
    expect(out).toHaveLength(1);
    expect(inner.batches).toEqual([1]);
  });
});
