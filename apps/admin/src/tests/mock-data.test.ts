import { describe, expect, it } from "vitest";
import {
  AuditEventSchema,
  AuditPageSchema,
  AuditStatsSchema,
  AutomationSchema,
  EscalationSchema,
  PolicySchema,
} from "@oao/shared";
import {
  ALERT_CATEGORIES,
  MOCK_TOTAL_ACTIONS,
  MOCK_TOTAL_AUDIT_RECORDS,
  buildStats,
  buildUsers,
  defaultPolicy,
  filterEvents,
  mockAuditPage,
  mulberry32,
  store,
} from "@/lib/mock-data";

describe("mock dataset", () => {
  it("validates against AuditStatsSchema and matches the mock-up figures", () => {
    const stats = AuditStatsSchema.parse(buildStats());

    expect(stats.kpis.emailsSummarized).toBe(8642);
    expect(stats.kpis.draftsGenerated).toBe(2341);
    expect(stats.kpis.automationsProposed).toBe(186);
    expect(stats.kpis.automationsApproved).toBe(142);
    expect(stats.kpis.complianceAlerts).toBe(37);
    expect(stats.kpis.errorsAvoided).toBe(1216);

    expect(stats.kpis.deltas).toMatchObject({
      emailsSummarized: 12.4,
      draftsGenerated: 9.7,
      automationsProposed: 15.3,
      automationsApproved: 13.8,
      complianceAlerts: 8.3,
      errorsAvoided: 18.6,
    });

    expect(stats.totalActions).toBe(13547);
    expect(MOCK_TOTAL_ACTIONS).toBe(13547);
    expect(stats.actionsByType.map((a) => a.share)).toEqual([63.8, 17.3, 9.6, 5.4, 3.9]);
    expect(stats.complianceAlertsByCategory.map((c) => c.share)).toEqual([35.1, 27.0, 18.9, 10.8, 8.2]);
    expect(stats.automationsApprovalRate).toEqual({ current: 76, previous: 68 });
  });

  it("spreads the per-day activity so it sums back to the KPIs", () => {
    const stats = buildStats();
    const sum = (key: "summaries" | "drafts" | "automations" | "complianceAlerts") =>
      stats.activityOverTime.reduce((acc, d) => acc + d[key], 0);

    expect(stats.activityOverTime).toHaveLength(7);
    expect(sum("summaries")).toBe(stats.kpis.emailsSummarized);
    expect(sum("drafts")).toBe(stats.kpis.draftsGenerated);
    expect(sum("automations")).toBe(stats.kpis.automationsProposed);
    expect(sum("complianceAlerts")).toBe(stats.kpis.complianceAlerts);
  });

  it("generates exactly 1,247 contract-valid audit records over 12–18 May 2025", () => {
    const events = store().events;
    expect(events).toHaveLength(MOCK_TOTAL_AUDIT_RECORDS);

    for (const event of events.slice(0, 50)) AuditEventSchema.parse(event);

    const days = new Set(events.map((e) => e.timestamp.slice(0, 10)));
    expect([...days].sort()).toEqual([
      "2025-05-12",
      "2025-05-13",
      "2025-05-14",
      "2025-05-15",
      "2025-05-16",
      "2025-05-17",
      "2025-05-18",
    ]);

    // Six users of the tenant, newest record first.
    expect(new Set(events.map((e) => e.user.id)).size).toBe(6);
    expect(events[0]!.timestamp >= events[events.length - 1]!.timestamp).toBe(true);

    const alerts = events.filter((e) => e.type === "compliance_alert");
    expect(alerts).toHaveLength(37);
    for (const category of ALERT_CATEGORIES) {
      expect(alerts.filter((a) => a.details.category === category.code)).toHaveLength(category.count);
    }
  });

  it("is deterministic: the seeded PRNG always yields the same sequence", () => {
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    expect(a).toEqual(b);
    expect(store().events[0]!.id).toBe(store().events[0]!.id);
  });

  it("paginates and filters, and the page validates against AuditPageSchema", () => {
    const page = AuditPageSchema.parse(mockAuditPage({ page: 2, pageSize: 25 }));
    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(MOCK_TOTAL_AUDIT_RECORDS);
    expect(page.page).toBe(2);

    const high = filterEvents({ riskLevel: "high" });
    expect(high.length).toBeGreaterThan(0);
    expect(high.every((e) => e.riskLevel === "high")).toBe(true);

    const oneUser = filterEvents({ userId: "u-jsmith" });
    expect(oneUser.every((e) => e.user.id === "u-jsmith")).toBe(true);
  });

  it("ships 3 automations, 4 escalations (2 pending), 6 users and a valid default policy", () => {
    const s = store();
    expect(s.automations).toHaveLength(3);
    for (const a of s.automations) AutomationSchema.parse(a);

    expect(s.escalations).toHaveLength(4);
    expect(s.escalations.filter((e) => e.status === "pending")).toHaveLength(2);
    for (const e of s.escalations) EscalationSchema.parse(e);

    expect(buildUsers()).toHaveLength(6);
    const policy = PolicySchema.parse(defaultPolicy());
    expect(policy.internalDomains).toContain("longbow.ch");
    expect(policy.blockOnHighRisk).toBe(true);
    for (const p of policy.sensitiveDataPatterns) expect(() => new RegExp(p.pattern)).not.toThrow();
  });
});
