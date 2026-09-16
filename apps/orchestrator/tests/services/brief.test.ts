import { describe, expect, it } from "vitest";
import type { EmailContext } from "@oao/shared";
import { DailyBriefSchema } from "@oao/shared";
import { localDateString, tzOffsetMs, utcInstantForLocal } from "../../src/services/DailyBriefService.js";
import { createTestContainer, ctx, FakeGraphClient, sampleEmail, SYNC_ENV, user, type TestContainer } from "../helpers.js";

const U = user("ana@northbridge.example");
const DATE = "2026-06-11";
/** Inside the window of the 2026-06-11 brief (07:00 UTC on 10 → 07:00 UTC on 11). */
const IN_WINDOW = "2026-06-10T09:30:00.000Z";

const urgent = (id: string): EmailContext =>
  sampleEmail({
    id,
    subject: `Mandate ${id}: signature missing`,
    from: { name: "Client SA", address: "ops@client.example" },
    receivedAt: IN_WINDOW,
    body: "This is urgent: the signed mandate is still outstanding and the deadline is 2026-06-12. Please confirm today.",
    attachments: [{ name: "mandate-draft.pdf" }],
  });

const calm = (id: string): EmailContext =>
  sampleEmail({ id, subject: `FYI ${id}`, from: { address: "colleague@northbridge.example" }, receivedAt: IN_WINDOW, body: "Sharing the meeting notes from yesterday for your information.", attachments: [] });

/** Seed the index + precomputed analyses the way the sync worker would. */
async function seedPrecomputed(c: TestContainer, emails: EmailContext[]) {
  const context = ctx(U);
  await c.services.indexEmails.index(context, emails, { audit: false });
  for (const email of emails) {
    const analysis = await c.services.analyzeEmail.analyze(context, { email, includeThread: false });
    await c.services.analyzeEmail.storePrecomputed(U.id, analysis, email.conversationId);
  }
}

describe("DailyBriefService", () => {
  it("builds the brief from precomputed analyses with one short model call", async () => {
    const c = await createTestContainer({ TZ: "UTC", DAILY_BRIEF_HOUR: "7" });
    await seedPrecomputed(c, [urgent("u1"), calm("c1")]);

    const before = c.llm.calls;
    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(DailyBriefSchema.parse(brief)).toBeTruthy();

    // Exactly one extra model call: the headline. No analysis was recomputed.
    expect(c.llm.calls - before).toBe(1);
    expect(brief.source).toBe("llm");
    expect(brief.date).toBe(DATE);
    expect(brief.stats).toMatchObject({ newEmails: 2, analysed: 2 });
    expect(brief.stats.awaitingReply).toBeGreaterThan(0);
    expect(brief.priorityEmails.length).toBeGreaterThan(0);
    expect(brief.priorityEmails[0]!.emailId).toBe("u1");
    expect(brief.highlights.length).toBeGreaterThan(0);
    expect(brief.auditId).not.toBe("pending");
  });

  it("stores the brief and serves it again without any model call", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    await seedPrecomputed(c, [urgent("u1")]);
    const first = await c.services.dailyBrief.generate(ctx(U), { date: DATE });

    const calls = c.llm.calls;
    const second = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(c.llm.calls).toBe(calls);
    expect(second.generatedAt).toBe(first.generatedAt);

    const stored = await c.services.dailyBrief.getStored(U.id, DATE);
    expect(stored?.headline).toBe(first.headline);
  });

  it("refresh: true regenerates", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    await seedPrecomputed(c, [urgent("u1")]);
    await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    const calls = c.llm.calls;
    await c.services.dailyBrief.generate(ctx(U), { date: DATE, refresh: true });
    expect(c.llm.calls).toBeGreaterThan(calls);
  });

  it("falls back to a heuristic headline when the model is unavailable", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    await seedPrecomputed(c, [urgent("u1")]);
    c.llm.failing = true;

    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(brief.source).toBe("precomputed");
    expect(brief.headline.length).toBeGreaterThan(10);
    expect(brief.highlights.length).toBeGreaterThan(0);
    expect(brief.confidence).toBeLessThanOrEqual(0.6);
    const event = c.repos.audit.events.find((e) => e.details.kind === "daily_brief");
    expect(event!.details.modelCallSkipped).toBe(true);
  });

  it("an empty mailbox produces a valid brief and no model call at all", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    const before = c.llm.calls;
    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(c.llm.calls).toBe(before);
    expect(brief.source).toBe("heuristic");
    expect(brief.stats).toEqual({ newEmails: 0, analysed: 0, awaitingReply: 0, phishingSuspected: 0 });
    expect(brief.headline).toMatch(/No new email/i);
  });

  it("ignores emails outside the brief window", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    await seedPrecomputed(c, [urgent("old"), calm("recent")].map((e, i) => ({ ...e, receivedAt: i === 0 ? "2026-05-01T09:00:00.000Z" : IN_WINDOW })));
    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(brief.stats.newEmails).toBe(1);
    expect(brief.priorityEmails.map((p) => p.emailId)).not.toContain("old");
  });

  it("surfaces phishing alerts detected on inbound mail", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    const phish = sampleEmail({
      id: "p1",
      subject: "URGENT: verify your account now",
      from: { name: "Northbridge IT", address: "security@northbridge-capital.example" },
      receivedAt: IN_WINDOW,
      body: "Your account will be suspended. Verify your password immediately at http://185.22.11.9/login to avoid losing access.",
      attachments: [],
    });
    await seedPrecomputed(c, [phish]);
    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(brief.stats.phishingSuspected).toBeGreaterThan(0);
    expect(brief.alerts.map((a) => a.code)).toContain("phishing_suspected");
  });

  it("deduplicates open tasks across emails", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    await seedPrecomputed(c, [urgent("u1"), urgent("u2")]);
    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    const titles = brief.openTasks.map((t) => t.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("the scheduled job generates one brief per synced user at background priority", async () => {
    const graph = new FakeGraphClient();
    const c = await createTestContainer({ ...SYNC_ENV, TZ: "UTC" }, { graph });
    await c.deps.repos.mailboxSync.put({ userId: U.id, userEmail: U.email, state: "idle", indexedEmails: 0, precomputedAnalyses: 0, pending: 0, authMode: "obo", msalHomeAccountId: "h", updatedAt: new Date().toISOString() });
    await seedPrecomputed(c, [urgent("u1")]);

    const users = await c.services.mailboxSync.syncedUsers();
    expect(users).toHaveLength(1);
    for (const u of users) {
      await c.services.dailyBrief.generate({ user: { id: u.userId, email: u.userEmail, roles: ["user"], via: "aad-jwt" }, language: "en" }, { refresh: true, priority: "background" });
    }
    expect(await c.services.dailyBrief.getStored(U.id, c.services.dailyBrief.today())).toBeTruthy();
  });
});

describe("timezone helpers", () => {
  it("tzOffsetMs handles DST and unknown zones", () => {
    expect(tzOffsetMs(new Date("2026-06-15T12:00:00Z"), "Europe/Zurich")).toBe(2 * 3_600_000);
    expect(tzOffsetMs(new Date("2026-01-15T12:00:00Z"), "Europe/Zurich")).toBe(3_600_000);
    expect(tzOffsetMs(new Date("2026-06-15T12:00:00Z"), "UTC")).toBe(0);
    expect(tzOffsetMs(new Date("2026-06-15T12:00:00Z"), "Not/AZone")).toBe(0);
  });

  it("localDateString gives the user's calendar date, not UTC's", () => {
    // 23:30 UTC on 10 June is already 01:30 on 11 June in Zurich.
    expect(localDateString(new Date("2026-06-10T23:30:00Z"), "Europe/Zurich")).toBe("2026-06-11");
    expect(localDateString(new Date("2026-06-10T23:30:00Z"), "UTC")).toBe("2026-06-10");
  });

  it("utcInstantForLocal is DST-correct", () => {
    expect(utcInstantForLocal("2026-06-11", 7, "Europe/Zurich").toISOString()).toBe("2026-06-11T05:00:00.000Z");
    expect(utcInstantForLocal("2026-01-11", 7, "Europe/Zurich").toISOString()).toBe("2026-01-11T06:00:00.000Z");
    expect(utcInstantForLocal("2026-06-11", 7, "UTC").toISOString()).toBe("2026-06-11T07:00:00.000Z");
  });

  it("windowFor covers the 24 h before the brief hour, extended to now on the day itself", async () => {
    const c = await createTestContainer({ TZ: "UTC", DAILY_BRIEF_HOUR: "7" });

    // Regenerated during the day → include this morning's mail.
    const sameDay = c.services.dailyBrief.windowFor("2026-06-11", new Date("2026-06-11T14:00:00Z"));
    expect(sameDay.from).toBe("2026-06-10T07:00:00.000Z");
    expect(sameDay.to).toBe("2026-06-11T14:00:00.000Z");

    // A past date keeps its historical window.
    const past = c.services.dailyBrief.windowFor("2026-06-01", new Date("2026-06-11T14:00:00Z"));
    expect(past).toMatchObject({ from: "2026-05-31T07:00:00.000Z", to: "2026-06-01T07:00:00.000Z" });

    // Before the brief hour: nothing of today yet.
    const early = c.services.dailyBrief.windowFor("2026-06-11", new Date("2026-06-11T05:00:00Z"));
    expect(early.to).toBe("2026-06-11T07:00:00.000Z");
  });
});

describe("brief window boundaries", () => {
  it("includes an email whose timestamp has no milliseconds (Graph's format)", async () => {
    const c = await createTestContainer({ TZ: "UTC", DAILY_BRIEF_HOUR: "7" });
    // "…:40Z" sorts AFTER "…:40.821Z" as a string — comparing instants is the only correct way.
    const email = sampleEmail({ id: "edge-1", receivedAt: "2026-06-10T09:30:40Z", attachments: [], body: "Please confirm the mandate before Friday." });
    await seedPrecomputed(c, [email]);
    const chunks = await c.repos.emailIndex.listReceivedBetween(U.id, "2026-06-10T07:00:00.000Z", "2026-06-10T09:30:40.821Z", 50);
    expect(chunks.map((x) => x.emailId)).toEqual(["edge-1"]);

    const brief = await c.services.dailyBrief.generate(ctx(U), { date: DATE });
    expect(brief.stats.newEmails).toBe(1);
  });

  it("excludes an email that is exactly at the end of the window", async () => {
    const c = await createTestContainer({ TZ: "UTC" });
    await seedPrecomputed(c, [sampleEmail({ id: "edge-2", receivedAt: "2026-06-11T07:00:00.000Z", attachments: [] })]);
    const chunks = await c.repos.emailIndex.listReceivedBetween(U.id, "2026-06-10T07:00:00.000Z", "2026-06-11T07:00:00.000Z", 50);
    expect(chunks).toHaveLength(0);
  });
});
