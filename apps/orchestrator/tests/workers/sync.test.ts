import { describe, expect, it, vi } from "vitest";
import type { EmailContext } from "@oao/shared";
import { MailboxSyncStatusSchema } from "@oao/shared";
import { Scheduler, nextDailyInstant } from "../../src/workers/scheduler.js";
import { runRetention } from "../../src/workers/retention.js";
import { noopLogger } from "../../src/services/context.js";
import { createTestContainer, FakeGraphClient, sampleEmail, SYNC_ENV, type TestContainer } from "../helpers.js";

const USER = { id: "ana@northbridge.example", email: "ana@northbridge.example" };

const inbound = (over: Partial<EmailContext>): EmailContext =>
  sampleEmail({
    receivedAt: "2026-06-10T08:00:00.000Z",
    to: [{ address: USER.email }],
    attachments: [],
    ...over,
  });

const conversationEmail = (id: string) =>
  inbound({ id, subject: `Mandate step ${id}`, from: { name: "Client", address: "client@client.example" }, body: "Please confirm the signed KYC pack before Friday 20 June; the mandate cannot proceed without it." });

const newsletterEmail = (id: string) => inbound({ id, subject: "Weekly digest", from: { address: "news@marketwatch.example" }, body: "Markets moved.\n\nUnsubscribe here." });

async function syncContainer(env: NodeJS.ProcessEnv = {}): Promise<{ c: TestContainer; graph: FakeGraphClient }> {
  const graph = new FakeGraphClient();
  const c = await createTestContainer({ ...SYNC_ENV, ...env }, { graph });
  return { c, graph };
}

/** Register the mailbox as the auth hook would on an authenticated request. */
async function register(c: TestContainer, authMode: "obo" | "app" = "obo") {
  await c.deps.repos.mailboxSync.put({
    userId: USER.id,
    userEmail: USER.email,
    state: "idle",
    indexedEmails: 0,
    precomputedAnalyses: 0,
    pending: 0,
    authMode,
    msalHomeAccountId: authMode === "obo" ? "home-account-1" : undefined,
    updatedAt: new Date().toISOString(),
  });
}

describe("MailboxSyncService — state machine", () => {
  it("is disabled unless GRAPH_ENABLED and PRECOMPUTE_ENABLED are both true", async () => {
    const off = await createTestContainer();
    expect(off.services.mailboxSync.enabled).toBe(false);
    const status = await off.services.mailboxSync.status(USER.id);
    expect(MailboxSyncStatusSchema.parse(status)).toMatchObject({ enabled: false, state: "disabled", lastError: "GRAPH_ENABLED=false" });
    await expect(off.services.mailboxSync.syncUser(USER.id)).rejects.toMatchObject({ code: "graph_unavailable" });
  });

  it("indexes, triages and precomputes a delta page, then stores the delta token", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.queue([conversationEmail("m1"), conversationEmail("m2"), newsletterEmail("n1")], { deltaToken: "delta-A" });

    const r = await c.services.mailboxSync.syncUser(USER.id);
    expect(r).toMatchObject({ fetched: 3, indexed: 3, analysed: 2, skippedByTriage: 1 });
    expect(r.error).toBeUndefined();

    const state = await c.deps.repos.mailboxSync.get(USER.id);
    expect(state).toMatchObject({ state: "idle", deltaToken: "delta-A", pending: 0 });
    expect(state!.lastSyncAt).toBeTruthy();
    expect(state!.nextSyncAt! > new Date().toISOString()).toBe(true);

    // The two conversation emails are now instantly available.
    expect(await c.deps.repos.analysisCache.countPrecomputed(USER.id)).toBe(2);
    const stored = await c.deps.repos.analysisCache.getByEmail<{ source: string }>(USER.id, "m1");
    expect(stored!.origin).toBe("precomputed");
  });

  it("replays the stored delta token on the next run", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.queue([conversationEmail("m1")], { deltaToken: "delta-A" });
    graph.queue([conversationEmail("m2")], { deltaToken: "delta-B" });

    await c.services.mailboxSync.syncUser(USER.id);
    await c.services.mailboxSync.syncUser(USER.id);
    expect(graph.deltaTokensSeen).toEqual([undefined, "delta-A"]);
    expect((await c.deps.repos.mailboxSync.get(USER.id))!.deltaToken).toBe("delta-B");
  });

  it("comes back immediately when Graph says there are more pages", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.queue([conversationEmail("m1")], { hasMore: true });

    await c.services.mailboxSync.syncUser(USER.id);
    const state = await c.deps.repos.mailboxSync.get(USER.id)!;
    expect(state!.pending).toBe(1);
    // ~15 s, not a full SYNC_INTERVAL_MINUTES.
    expect(Date.parse(state!.nextSyncAt!) - Date.now()).toBeLessThan(60_000);
  });

  it("records an error state and an audit event when Graph fails, then recovers", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.failNextWith = new Error("HTTP 429 too many requests");
    const failed = await c.services.mailboxSync.syncUser(USER.id);
    expect(failed.error).toContain("429");

    const errored = await c.deps.repos.mailboxSync.get(USER.id);
    expect(errored).toMatchObject({ state: "error" });
    expect(errored!.lastError).toContain("429");
    expect(c.repos.audit.events.some((e) => e.type === "error" && e.details.stage === "mailbox_sync")).toBe(true);

    graph.queue([conversationEmail("m1")]);
    const ok = await c.services.mailboxSync.syncUser(USER.id);
    expect(ok.error).toBeUndefined();
    expect((await c.deps.repos.mailboxSync.get(USER.id))!.state).toBe("idle");
    expect((await c.deps.repos.mailboxSync.get(USER.id))!.lastError).toBeUndefined();
  });

  it("refuses to sync a delegated mailbox with no cached token, and explains why", async () => {
    const { c } = await syncContainer();
    await c.deps.repos.mailboxSync.put({ userId: USER.id, userEmail: USER.email, state: "idle", indexedEmails: 0, precomputedAnalyses: 0, pending: 0, authMode: "obo", updatedAt: new Date().toISOString() });
    const r = await c.services.mailboxSync.syncUser(USER.id);
    expect(r.error).toMatch(/no cached delegated token/);
    expect((await c.deps.repos.mailboxSync.get(USER.id))!.state).toBe("error");
  });

  it("accepts the caller's own token (interactive POST /mailbox/sync)", async () => {
    const { c, graph } = await syncContainer();
    graph.queue([conversationEmail("m1")]);
    const r = await c.services.mailboxSync.syncUser(USER.id, { userToken: "office-sso-token", userEmail: USER.email, priority: "interactive" });
    expect(r.fetched).toBe(1);
    expect(graph.accessesSeen[0]).toEqual({ kind: "obo", userToken: "office-sso-token" });
  });

  it("uses /users/{upn} access in application mode and seeds from SYNC_USERS", async () => {
    const { c, graph } = await syncContainer({ GRAPH_AUTH_MODE: "app", SYNC_USERS: `${USER.email},bob@northbridge.example` });
    expect(await c.services.mailboxSync.seedApplicationUsers()).toBe(2);
    graph.queue([conversationEmail("m1")]);
    await c.services.mailboxSync.syncUser(USER.id);
    expect(graph.accessesSeen[0]).toEqual({ kind: "app", userPrincipalName: USER.email });
    // Seeding is idempotent.
    expect(await c.services.mailboxSync.seedApplicationUsers()).toBe(0);
  });

  it("expands SYNC_GROUP_ID in application mode", async () => {
    const { c, graph } = await syncContainer({ GRAPH_AUTH_MODE: "app", SYNC_GROUP_ID: "group-1" });
    graph.groupMembers = ["ana@northbridge.example", "bob@northbridge.example", "carl@northbridge.example"];
    expect(await c.services.mailboxSync.seedApplicationUsers()).toBe(3);
    expect((await c.services.mailboxSync.syncedUsers()).map((u) => u.userEmail).sort()).toEqual(graph.groupMembers.sort());
  });

  it("does not start a second run while one is in flight", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    await c.deps.repos.mailboxSync.put({ ...(await c.deps.repos.mailboxSync.get(USER.id))!, state: "syncing", updatedAt: new Date().toISOString() });
    graph.queue([conversationEmail("m1")]);
    const r = await c.services.mailboxSync.syncUser(USER.id);
    expect(r.error).toBe("already syncing");
    expect(r.fetched).toBe(0);
  });

  it("reclaims a stale `syncing` state left by a crashed pod", async () => {
    const { c, graph } = await syncContainer({ SYNC_INTERVAL_MINUTES: "1" });
    await register(c);
    await c.deps.repos.mailboxSync.put({ ...(await c.deps.repos.mailboxSync.get(USER.id))!, state: "syncing", updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    graph.queue([conversationEmail("m1")]);
    const r = await c.services.mailboxSync.syncUser(USER.id);
    expect(r.fetched).toBe(1);
  });

  it("syncDue only picks mailboxes whose next run has come", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.queue([conversationEmail("m1")]);
    expect(await c.services.mailboxSync.syncDue()).toHaveLength(1);
    // Now nextSyncAt is in the future.
    expect(await c.services.mailboxSync.syncDue()).toHaveLength(0);
  });

  it("registers a delegated mailbox from an AAD request and does not re-register within the hour", async () => {
    const { c, graph } = await syncContainer();
    const ctx = { user: { id: USER.id, email: USER.email, roles: ["user" as const], via: "aad-jwt" as const, token: "sso" }, language: "en" as const };
    await c.services.mailboxSync.register(ctx);
    const state = await c.deps.repos.mailboxSync.get(USER.id);
    expect(state).toMatchObject({ authMode: "obo", msalHomeAccountId: "home-account-1" });

    graph.homeAccountId = "changed";
    await c.services.mailboxSync.register(ctx);
    expect((await c.deps.repos.mailboxSync.get(USER.id))!.msalHomeAccountId).toBe("home-account-1");
  });

  it("ignores registration for dev identities and when the token is absent", async () => {
    const { c } = await syncContainer();
    await c.services.mailboxSync.register({ user: { id: "x", email: "x@northbridge.example", roles: ["user"], via: "dev-headers", token: "t" }, language: "en" });
    await c.services.mailboxSync.register({ user: { id: "y", email: "y@northbridge.example", roles: ["user"], via: "aad-jwt" }, language: "en" });
    expect(await c.deps.repos.mailboxSync.list()).toHaveLength(0);
  });

  it("status reports counters and the enabled flag", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.queue([conversationEmail("m1"), newsletterEmail("n1")]);
    await c.services.mailboxSync.syncUser(USER.id);
    const s = MailboxSyncStatusSchema.parse(await c.services.mailboxSync.status(USER.id));
    expect(s).toMatchObject({ enabled: true, state: "idle", pending: 0, precomputedAnalyses: 1 });
    expect(s.indexedEmails).toBe(2);
    expect(s.lastSyncAt).toBeTruthy();
  });

  it("one unanalysable message does not abort the run", async () => {
    const { c, graph } = await syncContainer();
    await register(c);
    graph.queue([conversationEmail("m1"), conversationEmail("m2")]);
    const original = c.services.analyzeEmail.analyze.bind(c.services.analyzeEmail);
    let first = true;
    vi.spyOn(c.services.analyzeEmail, "analyze").mockImplementation(async (ctx, req, opts) => {
      if (first) {
        first = false;
        throw new Error("model exploded");
      }
      return original(ctx, req, opts);
    });
    const r = await c.services.mailboxSync.syncUser(USER.id);
    expect(r.analysed).toBe(1);
    expect(r.error).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe("Scheduler", () => {
  it("is leader without a database and never overlaps a job with itself", async () => {
    const now = { t: 0 };
    const runs: string[] = [];
    let release: (() => void) | undefined;
    const s = new Scheduler({ logger: noopLogger, now: () => now.t });
    s.add({
      name: "job",
      everyMs: 1000,
      runOnStart: true,
      run: () =>
        new Promise<void>((r) => {
          runs.push("start");
          release = () => {
            runs.push("end");
            r();
          };
        }),
    });

    // Before start there is no leadership, so a tick does nothing.
    await s.tick();
    expect(s.isLeader).toBe(false);
    expect(runs).toEqual([]);

    await s.start();
    await new Promise((r) => setImmediate(r));
    expect(s.isLeader).toBe(true);
    expect(runs).toEqual(["start"]);

    // A second tick while the job is still running must not start it again.
    now.t = 5000;
    await s.tick();
    expect(runs).toEqual(["start"]);

    release!();
    await new Promise((r) => setImmediate(r));
    expect(runs).toEqual(["start", "end"]);
    expect(s.status[0]).toMatchObject({ name: "job", runs: 1, failures: 0 });
    await s.stop();
  });

  it("keeps running after a job throws, and records the failure", async () => {
    let now = 0;
    const s = new Scheduler({ logger: noopLogger, now: () => now });
    s.add({
      name: "flaky",
      everyMs: 100,
      runOnStart: true,
      run: async () => {
        throw new Error("nope");
      },
    });
    await s.start();
    expect(s.status[0]).toMatchObject({ name: "flaky", failures: 1, lastError: "nope" });
    now = 500;
    await s.tick();
    expect(s.status[0]!.failures).toBe(2);
    await s.stop();
  });

  it("computes the next daily instant in the configured timezone", () => {
    const from = new Date("2026-06-10T10:00:00Z");
    const utc = nextDailyInstant(from, 7, "UTC");
    expect(utc.toISOString()).toBe("2026-06-11T07:00:00.000Z");

    // Europe/Zurich is UTC+2 in June: 07:00 local = 05:00 UTC, still ahead of 10:00Z? No → next day.
    const zurich = nextDailyInstant(from, 7, "Europe/Zurich");
    expect(zurich.toISOString()).toBe("2026-06-11T05:00:00.000Z");

    // Same day when the hour has not passed yet.
    expect(nextDailyInstant(new Date("2026-06-10T03:00:00Z"), 7, "UTC").toISOString()).toBe("2026-06-10T07:00:00.000Z");

    // Winter: Zurich is UTC+1, so 07:00 local = 06:00 UTC (DST handled).
    expect(nextDailyInstant(new Date("2026-01-10T03:00:00Z"), 7, "Europe/Zurich").toISOString()).toBe("2026-01-10T06:00:00.000Z");
  });

  it("an unknown timezone degrades to UTC instead of throwing", () => {
    expect(nextDailyInstant(new Date("2026-06-10T03:00:00Z"), 7, "Not/AZone").toISOString()).toBe("2026-06-10T07:00:00.000Z");
  });
});

describe("retention", () => {
  it("purges audit, index, caches and idempotency by their own retention windows", async () => {
    const c = await createTestContainer({ AUDIT_RETENTION_DAYS: "30", INDEX_RETENTION_DAYS: "10" });
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const recent = new Date().toISOString();

    await c.repos.audit.append({ id: "11111111-1111-4111-8111-111111111111", timestamp: old, user: { id: "u", email: "u@northbridge.example" }, type: "summary_generated", approvalStatus: "n/a", details: {} });
    await c.repos.audit.append({ id: "22222222-2222-4222-8222-222222222222", timestamp: recent, user: { id: "u", email: "u@northbridge.example" }, type: "summary_generated", approvalStatus: "n/a", details: {} });
    await c.repos.emailIndex.upsertEmail("u", [{ userId: "u", emailId: "old", subject: "old", chunkNo: 0, bodyText: "x", receivedAt: old }]);
    await c.repos.emailIndex.upsertEmail("u", [{ userId: "u", emailId: "new", subject: "new", chunkNo: 0, bodyText: "x", receivedAt: recent }]);
    await c.repos.analysisCache.put({ key: "expired", kind: "analysis", userId: "u", value: {}, origin: "llm", createdAt: old, expiresAt: old });
    await c.repos.embeddingCache.putMany("m", [{ key: "k", embedding: [1] }], old);
    await c.repos.idempotency.put({ key: "i", userId: "u", requestHash: "h", response: {}, createdAt: old, expiresAt: old });
    await c.repos.dailyBriefs.put("u", {
      date: "2020-01-01",
      language: "en",
      headline: "h",
      highlights: [],
      priorityEmails: [],
      openTasks: [],
      deadlines: [],
      alerts: [],
      stats: { newEmails: 0, analysed: 0, awaitingReply: 0, phishingSuspected: 0 },
      confidence: 0.5,
      source: "heuristic",
      generatedAt: old,
      auditId: "a",
    });

    const report = await runRetention(c.repos, c.cfg, noopLogger);
    expect(report).toMatchObject({ auditEvents: 1, emailChunks: 1, analysisCache: 1, embeddingCache: 1, idempotency: 1, dailyBriefs: 1 });
    expect(c.repos.audit.events).toHaveLength(1);
    expect(await c.repos.emailIndex.count("u")).toBe(1);
  });

  it("never throws when a purge step fails", async () => {
    const c = await createTestContainer();
    c.repos.audit.purgeOlderThan = async () => {
      throw new Error("db down");
    };
    const report = await runRetention(c.repos, c.cfg, noopLogger);
    expect(report.auditEvents).toBe(0);
  });
});
