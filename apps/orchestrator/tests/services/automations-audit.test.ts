import { beforeEach, describe, expect, it } from "vitest";
import { AutomationSchema, AuditStatsSchema } from "@oao/shared";
import { createTestContainer, ctx, user, type TestContainer } from "../helpers.js";
import { sampleEmails, DEMO_PEOPLE } from "../../src/seed/emails.js";
import { seedDemo } from "../../src/seed/demo.js";

let c: TestContainer;
const now = new Date("2025-06-10T12:00:00Z");
beforeEach(async () => {
  c = await createTestContainer();
});

async function observeRoutine(times = 5) {
  const emails = sampleEmails(now).filter((e) => e.from?.address === DEMO_PEOPLE.reports.address).slice(0, times);
  await c.services.indexEmails.index(ctx(), sampleEmails(now), { audit: false });
  const events = emails.flatMap((e) => {
    const base = Date.now() - 10 * 86_400_000 + emails.indexOf(e) * 86_400_000;
    const ref = { id: e.id, fromAddress: e.from!.address, fromDomain: "abccapital.com", subject: e.subject, hasAttachments: true };
    return (["open_email", "save_attachment", "categorize", "create_reminder"] as const).map((type, j) => ({ type, occurredAt: new Date(base + j * 60_000).toISOString(), email: ref, parameters: type === "save_attachment" ? { folder: "\\\\Reports\\ABC" } : type === "categorize" ? { category: "ABC – Reporting" } : {} }));
  });
  return c.services.automations.observe(ctx(), events);
}

describe("AutomationCoachService", () => {
  it("observe → detect (no duplicates) → simulate → approve; reject; edit rule", async () => {
    expect(await observeRoutine()).toEqual({ stored: 20 });
    const first = await c.services.automations.detect(ctx());
    expect(first).toHaveLength(1);
    expect(() => AutomationSchema.parse(first[0])).not.toThrow();
    expect(first[0]).toMatchObject({ status: "proposed", trigger: { conditions: { fromDomain: "abccapital.com", hasAttachments: true } } });
    const again = await c.services.automations.detect(ctx());
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first[0]!.id);
    expect(c.repos.audit.events.filter((e) => e.type === "automation_proposed")).toHaveLength(1);

    const id = first[0]!.id;
    await expect(c.services.automations.approve(ctx(), id)).rejects.toMatchObject({ code: "conflict" }); // simulation mandatory
    const sim = await c.services.automations.simulate(ctx(), id, 10);
    expect(sim.status).toBe("simulated");
    expect(sim.lastSimulation!.sampleSize).toBe(10);
    expect(sim.lastSimulation!.results.filter((r) => r.wouldApply).length).toBeGreaterThanOrEqual(5);
    expect(sim.lastSimulation!.results.some((r) => !r.wouldApply)).toBe(true);
    expect(sim.lastSimulation!.checks.map((k) => k.passed)).toEqual([true, true, true, true]);
    const approved = await c.services.automations.approve(ctx(), id, "go");
    expect(approved.status).toBe("active");
    expect((await c.services.automations.list(ctx()))[0]!.status).toBe("active");
    expect(await c.services.automations.list(ctx(user("other@northbridge.example")))).toEqual([]);
    await expect(c.services.automations.get(ctx(user("other@northbridge.example")), id)).rejects.toMatchObject({ code: "not_found" });
    expect((await c.services.automations.list(ctx(user("admin@northbridge.example", ["admin"])), true)).length).toBe(1);

    const edited = await c.services.automations.update(ctx(), id, { name: "Renamed", trigger: { description: "x", conditions: { fromDomain: "abccapital.com" } } });
    expect(edited).toMatchObject({ name: "Renamed", status: "proposed" });
    expect(edited.lastSimulation).toBeUndefined();
    const rejected = await c.services.automations.reject(ctx(), id, "no");
    expect(rejected.status).toBe("rejected");
    await expect(c.services.automations.approve(ctx(), id)).rejects.toMatchObject({ code: "conflict" });
    expect(c.repos.audit.events.map((e) => e.type)).toEqual(["automation_proposed", "automation_simulated", "automation_approved", "automation_rejected"]);
  });
});

describe("AuditService", () => {
  it("scopes queries per role, exports CSV and computes stats with deltas", async () => {
    const r = await seedDemo(c, now);
    expect(r.auditEvents).toBeGreaterThanOrEqual(60);
    const mine = await c.services.audit.query(user("jane.smith@northbridge.example"), { page: 1, pageSize: 10 });
    expect(mine.items.every((e) => e.user.id === "jane.smith@northbridge.example")).toBe(true);
    const all = await c.services.audit.query(user("admin@northbridge.example", ["admin"]), { page: 1, pageSize: 200 });
    expect(all.total).toBe(r.auditEvents);
    const filtered = await c.services.audit.query(user("admin@northbridge.example", ["admin"]), { page: 1, pageSize: 200, type: "summary_generated", search: "horizon" });
    expect(filtered.items.every((e) => e.type === "summary_generated" && /horizon/i.test(e.source?.label ?? ""))).toBe(true);
    await expect(c.services.audit.get(user("nobody@northbridge.example"), all.items[0]!.id)).rejects.toMatchObject({ code: "not_found" });

    const csv = await c.services.audit.exportCsv(user("admin@northbridge.example", ["admin"]), {});
    expect(csv.split("\n")).toHaveLength(r.auditEvents + 1);
    expect(csv.split("\n")[0]).toContain("timestamp,userId");

    const to = now.toISOString();
    const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const stats = await c.services.audit.stats(from, to);
    expect(() => AuditStatsSchema.parse(stats)).not.toThrow();
    expect(stats.activityOverTime).toHaveLength(8);
    expect(stats.totalActions).toBeGreaterThan(0);
    expect(stats.actionsByType.reduce((a, b) => a + b.count, 0)).toBe(stats.totalActions);
    expect(Object.keys(stats.kpis.deltas)).toContain("emailsSummarized");
    expect(stats.topUsers.length).toBeGreaterThan(0);
    expect(stats.complianceAlertsByCategory.length).toBeGreaterThan(0);
    const users = await c.services.users.list();
    expect(users.find((u) => u.email === "compliance@northbridge.example")?.roles).toContain("compliance");
  });

  it("feedback is stored against an existing audit id", async () => {
    const a = await c.services.analyzeEmail.analyze(ctx(), { email: (await import("../helpers.js")).sampleEmail(), includeThread: false });
    const f = await c.services.feedback.submit(ctx(), { auditId: a.auditId, rating: "up" });
    expect(f.id).toBeTruthy();
    expect(c.repos.feedback.items[0]).toMatchObject({ auditId: a.auditId, rating: "up" });
    await expect(c.services.feedback.submit(ctx(), { auditId: "missing", rating: "down" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("policy put validates and audits", async () => {
    const p = await c.services.policy.put(user("admin@northbridge.example", ["admin"]), { ...(await c.services.policy.get()), blockOnHighRisk: true });
    expect(p.blockOnHighRisk).toBe(true);
    expect(p.updatedBy).toBe("admin@northbridge.example");
    expect((await c.services.policy.get()).blockOnHighRisk).toBe(true);
    expect(c.repos.audit.events[0]!.type).toBe("policy_updated");
    await expect(c.services.policy.put(user("admin@northbridge.example", ["admin"]), { internalDomains: "nope" })).rejects.toBeTruthy();
  });
});
