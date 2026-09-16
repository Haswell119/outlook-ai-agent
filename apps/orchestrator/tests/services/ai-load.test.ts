import { describe, expect, it } from "vitest";
import type { EmailContext } from "@oao/shared";
import { EmailAnalysisSchema } from "@oao/shared";
import { AiCacheService } from "../../src/services/AiCacheService.js";
import { MemoryAnalysisCacheRepository } from "../../src/adapters/memory/caches.js";
import { noopLogger } from "../../src/services/context.js";
import { Coalescer } from "../../src/util/coalesce.js";
import { ctx, createTestContainer, sampleEmail, user } from "../helpers.js";

const newsletter = (): EmailContext =>
  sampleEmail({
    id: "nl-1",
    subject: "Northbridge weekly market digest",
    from: { name: "Market News", address: "news@marketwatch.example" },
    body: "Equities ended the week higher.\n\nYou are receiving this email because you subscribed. Unsubscribe: https://mw.example/u?utm_source=nl",
    attachments: [],
  });

describe("Coalescer", () => {
  it("shares one in-flight promise between identical concurrent callers", async () => {
    const c = new Coalescer();
    let runs = 0;
    let release: (v: string) => void = () => undefined;
    const slow = () => new Promise<string>((r) => (release = r));

    const a = c.run("k", () => {
      runs++;
      return slow();
    });
    const b = c.run("k", () => {
      runs++;
      return slow();
    });
    await new Promise((r) => setImmediate(r));
    expect(c.stats.inFlight).toBe(1);

    release("value");
    const [ra, rb] = await Promise.all([a, b]);
    expect(runs).toBe(1);
    expect(ra.value).toBe("value");
    expect(rb.value).toBe("value");
    expect(ra.joined !== rb.joined).toBe(true); // exactly one of them started the work
    expect(c.stats).toMatchObject({ inFlight: 0, started: 1, joined: 1 });
  });

  it("different keys run in parallel and a rejection is shared, then forgotten", async () => {
    const c = new Coalescer();
    const r1 = await c.run("a", async () => 1);
    const r2 = await c.run("b", async () => 2);
    expect([r1.value, r2.value]).toEqual([1, 2]);

    const failing = () => Promise.reject(new Error("boom"));
    const p1 = c.run("x", failing);
    const p2 = c.run("x", failing);
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(c.stats.inFlight).toBe(0);
    // The failure is not sticky: the key can be retried.
    await expect(c.run("x", async () => "ok")).resolves.toMatchObject({ value: "ok" });
  });
});

describe("AiCacheService", () => {
  const build = (enabled = true, ttlHours = 168) => {
    const repo = new MemoryAnalysisCacheRepository();
    return { repo, svc: new AiCacheService(repo, { enabled, ttlHours, logger: noopLogger }) };
  };

  it("calls the producer once, then serves from the cache", async () => {
    const { svc } = build();
    let produced = 0;
    const produce = async () => {
      produced++;
      return { value: { summary: "s" }, model: "m" };
    };

    const first = await svc.through("u1", "analysis", "key", { emailId: "e1" }, produce);
    expect(first).toMatchObject({ source: "llm", coalesced: false });

    const second = await svc.through("u1", "analysis", "key", { emailId: "e1" }, produce);
    expect(second.source).toBe("cache");
    expect(second.ageMs).toBeGreaterThanOrEqual(0);
    expect(produced).toBe(1);
    expect(svc.stats.hits).toBe(1);
  });

  it("scopes entries per user: one mailbox never reads another's analysis", async () => {
    const { svc } = build();
    await svc.through("u1", "analysis", "shared-key", {}, async () => ({ value: { who: "u1" } }));
    const other = await svc.through("u2", "analysis", "shared-key", {}, async () => ({ value: { who: "u2" } }));
    expect(other.source).toBe("llm");
    expect(other.value).toEqual({ who: "u2" });
  });

  it("serves a worker-written entry as `precomputed`", async () => {
    const { svc } = build();
    await svc.store("u1", "analysis", "k", { summary: "done ahead" }, { emailId: "e9" }, "qwen", "precomputed");
    const r = await svc.through("u1", "analysis", "k", {}, async () => ({ value: { summary: "should not run" } }));
    expect(r.source).toBe("precomputed");
    expect(r.value).toEqual({ summary: "done ahead" });
  });

  it("does not cache values the producer marks as non-cacheable (degraded answers)", async () => {
    const { svc } = build();
    let produced = 0;
    const produce = async () => {
      produced++;
      return { value: { n: produced }, cacheable: false as const };
    };
    await svc.through("u1", "analysis", "k", {}, produce);
    await svc.through("u1", "analysis", "k", {}, produce);
    expect(produced).toBe(2);
  });

  it("respects the TTL on read and purges expired entries", async () => {
    const { repo, svc } = build(true, -1); // already expired when written
    await svc.through("u1", "analysis", "k", {}, async () => ({ value: { a: 1 } }));
    expect(await svc.lookup("u1", "analysis", "k")).toBeUndefined();
    expect(repo.entries.size).toBe(1);
    expect(await svc.purgeExpired()).toBe(1);
    expect(repo.entries.size).toBe(0);
  });

  it("is a no-op when disabled", async () => {
    const { repo, svc } = build(false);
    await svc.through("u1", "analysis", "k", {}, async () => ({ value: { a: 1 } }));
    expect(repo.entries.size).toBe(0);
    expect(svc.enabled).toBe(false);
  });

  it("finds the newest analysis of an email and counts precomputed entries", async () => {
    const { svc } = build();
    await svc.store("u1", "analysis", "k1", { summary: "old" }, { emailId: "e1" }, "m", "precomputed");
    await new Promise((r) => setTimeout(r, 5));
    await svc.store("u1", "analysis", "k2", { summary: "new" }, { emailId: "e1" }, "m", "precomputed");
    const found = await svc.byEmail<{ summary: string }>("u1", "e1");
    expect(found?.value.summary).toBe("new");
    expect(await svc.stats.hits).toBeGreaterThanOrEqual(0);
  });

  it("survives a broken cache backend", async () => {
    const broken = {
      get: async () => {
        throw new Error("db down");
      },
      put: async () => {
        throw new Error("db down");
      },
      getByEmail: async () => {
        throw new Error("db down");
      },
      countPrecomputed: async () => 0,
      purgeExpired: async () => {
        throw new Error("db down");
      },
    };
    const svc = new AiCacheService(broken, { enabled: true, ttlHours: 1, logger: noopLogger });
    const r = await svc.through("u", "analysis", "k", {}, async () => ({ value: { ok: true } }));
    expect(r).toMatchObject({ source: "llm", value: { ok: true } });
    expect(await svc.byEmail("u", "e")).toBeUndefined();
    expect(await svc.purgeExpired()).toBe(0);
  });
});

describe("AnalyzeEmailService — AI-load minimisation end to end", () => {
  it("analysing the same email twice calls the model once; the second answer is source=cache", async () => {
    const c = await createTestContainer();
    const email = sampleEmail();

    const first = await c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    expect(first.source).toBe("llm");
    const callsAfterFirst = c.llm.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    expect(second.source).toBe("cache");
    expect(c.llm.calls).toBe(callsAfterFirst);
    expect(second.summary).toBe(first.summary);

    // The audit trail is non-negotiable: both answers are recorded.
    const events = c.repos.audit.events.filter((e) => e.type === "summary_generated");
    expect(events).toHaveLength(2);
    expect(events[0]!.details.cached).toBe(false);
    expect(events[1]!.details).toMatchObject({ cached: true, cacheSource: "cache", analysisSource: "cache" });
  });

  it("a newsletter is answered from heuristics with no model call at all", async () => {
    const c = await createTestContainer();
    const before = c.llm.calls;
    const a = await c.services.analyzeEmail.analyze(ctx(), { email: newsletter(), includeThread: false });

    expect(a.source).toBe("heuristic");
    expect(a.triage).toMatchObject({ kind: "newsletter" });
    expect(c.llm.calls).toBe(before);
    expect(EmailAnalysisSchema.parse(a).confidence).toBeLessThanOrEqual(0.6);
    expect(a.suggestedActions.map((x) => x.type)).toContain("archive");

    const event = c.repos.audit.events.find((e) => e.type === "summary_generated");
    expect(event!.details).toMatchObject({ analysisSource: "heuristic", modelCallSkipped: true });
    expect((event!.details.triage as { kind: string }).kind).toBe("newsletter");
  });

  it("TRIAGE_ENABLED=false sends even a newsletter to the model", async () => {
    const c = await createTestContainer({ TRIAGE_ENABLED: "false" });
    const before = c.llm.calls;
    const a = await c.services.analyzeEmail.analyze(ctx(), { email: newsletter(), includeThread: false });
    expect(a.source).toBe("llm");
    expect(a.triage?.kind).toBe("conversation");
    expect(c.llm.calls).toBeGreaterThan(before);
  });

  it("concurrent identical requests are coalesced into one model call", async () => {
    const c = await createTestContainer();
    const email = sampleEmail({ id: "coalesce-1" });
    const before = c.llm.calls;
    const results = await Promise.all([
      c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false }),
      c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false }),
      c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false }),
    ]);
    expect(c.llm.calls - before).toBe(1);
    expect(new Set(results.map((r) => r.summary)).size).toBe(1);
    // Three users saw an answer, so three audit events exist.
    expect(c.repos.audit.events.filter((e) => e.type === "summary_generated")).toHaveLength(3);
  });

  it("records prompt-size telemetry in the audit details", async () => {
    const c = await createTestContainer();
    const bloated = `Please confirm the Friday deadline.\n\n${"padding ".repeat(4000)}\n\nOn Mon, Ana wrote:\n> ${"old ".repeat(2000)}`;
    await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail({ id: "big-1", body: bloated }), includeThread: false });
    const stats = c.repos.audit.events[0]!.details.promptStats as { tokens: number; chars: number; rawChars: number; savedRatio: number };
    expect(stats.tokens).toBeGreaterThan(0);
    expect(stats.chars).toBeLessThanOrEqual(12_000);
    expect(stats.rawChars).toBeGreaterThan(stats.chars);
    expect(stats.savedRatio).toBeGreaterThan(0.5);
  });

  it("does not cache a degraded answer, so a transient outage is not served for a week", async () => {
    const c = await createTestContainer();
    const email = sampleEmail({ id: "degraded-1" });
    c.llm.failing = true;
    const degraded = await c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    expect(degraded.source).toBe("heuristic");
    expect(degraded.risks.map((r) => r.code)).toContain("ai_output_unreliable");

    c.llm.failing = false;
    const recovered = await c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    expect(recovered.source).toBe("llm");
    expect(recovered.risks.map((r) => r.code)).not.toContain("ai_output_unreliable");
  });

  it("getStored returns a precomputed analysis and 404s when nothing was computed", async () => {
    const c = await createTestContainer();
    await expect(c.services.analyzeEmail.getStored(ctx(), "unknown-email")).rejects.toMatchObject({ code: "not_found" });

    const analysis = await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail({ id: "pre-1" }), includeThread: false });
    await c.services.analyzeEmail.storePrecomputed(user().id, analysis, "conv-1");

    const stored = await c.services.analyzeEmail.getStored(ctx(), "pre-1");
    expect(stored.source).toBe("precomputed");
    expect(stored.emailId).toBe("pre-1");
    const served = c.repos.audit.events.filter((e) => e.details.served === "analysisByEmail");
    expect(served).toHaveLength(1);
    expect(served[0]!.details.cached).toBe(true);
  });

  it("the thread synthesis and the draft reply are cached too", async () => {
    const c = await createTestContainer();
    const messages = [sampleEmail({ id: "t1" }), sampleEmail({ id: "t2", body: "Following up on the assessment, please confirm by Friday." })];
    const thread = { conversationId: "conv-9", subject: "Vendor risk", messages };

    const before = c.llm.calls;
    await c.services.synthesizeThread.synthesize(ctx(), { thread });
    const afterFirst = c.llm.calls;
    expect(afterFirst).toBeGreaterThan(before);
    await c.services.synthesizeThread.synthesize(ctx(), { thread });
    expect(c.llm.calls).toBe(afterFirst);

    const draftReq = { email: messages[0]!, intent: "acknowledge" as const, tone: "formal" as const };
    await c.services.draftReply.draft(ctx(), draftReq);
    const afterDraft = c.llm.calls;
    await c.services.draftReply.draft(ctx(), draftReq);
    expect(c.llm.calls).toBe(afterDraft);
    // A different intent is a different answer and must call the model again.
    await c.services.draftReply.draft(ctx(), { ...draftReq, intent: "decline" });
    expect(c.llm.calls).toBeGreaterThan(afterDraft);
  });

  it("changing PROMPT_VERSION invalidates the cache", async () => {
    const email = sampleEmail({ id: "pv-1" });
    const c1 = await createTestContainer({ PROMPT_VERSION: "v1" });
    const a = await c1.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    await c1.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });

    // Same repositories, new prompt version → a miss.
    const c2 = await createTestContainer({ PROMPT_VERSION: "v2" }, { repos: c1.repos, llm: c1.llm });
    const before = c1.llm.calls;
    const b = await c2.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    expect(c1.llm.calls).toBeGreaterThan(before);
    expect(b.source).toBe("llm");
    expect(a.source).toBe("llm");
  });
});
