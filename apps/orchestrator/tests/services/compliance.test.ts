import { beforeEach, describe, expect, it } from "vitest";
import { ComplianceCheckResponseSchema, PhishingCheckResponseSchema, EscalationSchema } from "@oao/shared";
import { createTestContainer, ctx, sampleEmail, user, type TestContainer } from "../helpers.js";

let c: TestContainer;
beforeEach(async () => {
  c = await createTestContainer();
});

describe("ComplianceService.check", () => {
  it("detects the four mock-up issues and recommends actions; audits check + alert", async () => {
    const r = await c.services.compliance.check(ctx(), {
      draft: { to: [{ address: "michael.brown@clientco.com" }], cc: [], bcc: [], subject: "Q2 performance", body: "Hi Michael, attached is the Q2 performance report for your portfolio. The valuation is CHF 12.4m.", attachments: [{ id: "a", name: "Client A – Q2 Performance Report.pdf" }] },
    });
    expect(() => ComplianceCheckResponseSchema.parse(r)).not.toThrow();
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["external_recipient", "confidential_attachment", "missing_classification_label", "sensitive_client_information"]));
    expect(r.issues.find((i) => i.code === "sensitive_client_information")?.severity).toBe("high"); // from the LLM content check
    expect(r.recommendedActions.map((a) => a.type)).toEqual(["apply_label", "remove_attachment", "request_approval", "escalate_compliance"]);
    expect(r.verdict).toBe("warn");
    const types = c.repos.audit.events.map((e) => e.type);
    expect(types).toEqual(["compliance_check", "compliance_alert"]);
    expect((c.repos.audit.events[1]!.details.issues as Array<{ code: string }>).map((i) => i.code)).toEqual(codes);
  });
  it("allows a clean internal draft without an alert", async () => {
    const r = await c.services.compliance.check(ctx(), { draft: { to: [{ address: "marc.dubois@longbow.ch" }], cc: [], bcc: [], subject: "Lunch", body: "Lunch at noon?", attachments: [], sensitivityLabel: "Internal" } });
    expect(r.verdict).toBe("allow");
    expect(r.issues).toEqual([]);
    expect(c.repos.audit.events.map((e) => e.type)).toEqual(["compliance_check"]);
  });
  it("blocks when the policy says so and still works when the model is down", async () => {
    await c.services.policy.put(user("admin@longbow.ch", ["admin"]), { ...(await c.services.policy.get()), blockOnHighRisk: true });
    c.llm.failing = true;
    const r = await c.services.compliance.check(ctx(undefined, "fr"), { draft: { to: [{ address: "x@clientco.com" }], cc: [], bcc: [], subject: "Docs", body: "Voici le rapport de performance confidentiel de votre portefeuille avec les positions détaillées.", attachments: [{ name: "Rapport KYC.pdf" }] } });
    expect(r.verdict).toBe("block");
    expect(r.issues[0]!.title).toBe("Destinataire externe détecté");
  });
});

describe("ComplianceService.phishing", () => {
  it("returns weighted indicators and audits with the risk level", async () => {
    const r = await c.services.compliance.phishing(ctx(), sampleEmail({ from: { name: "IT", address: "it@longbovv.ch" }, body: "urgent: verify your password at http://10.0.0.1/x" }));
    expect(() => PhishingCheckResponseSchema.parse(r)).not.toThrow();
    expect(r.verdict).toBe("likely_phishing");
    expect(r.indicators.every((i) => i.weight > 0)).toBe(true);
    expect(c.repos.audit.events[0]).toMatchObject({ type: "phishing_check", riskLevel: "high" });
  });
});

describe("EscalationService", () => {
  it("create → list (mine vs compliance) → decide (updates the linked action, audits)", async () => {
    const e = await c.services.escalations.create(ctx(), { reason: "External send with confidential attachment", issues: [] });
    expect(() => EscalationSchema.parse(e)).not.toThrow();
    expect(e.status).toBe("pending");
    expect(await c.services.escalations.list(ctx(user("someone@longbow.ch")))).toEqual([]);
    expect(await c.services.escalations.list(ctx(user("compliance@longbow.ch", ["user", "compliance"])))).toHaveLength(1);
    expect(await c.services.escalations.list(ctx(), "approved")).toEqual([]);
    await expect(c.services.escalations.get(ctx(user("someone@longbow.ch")), e.id)).rejects.toMatchObject({ code: "not_found" });
    const decided = await c.services.escalations.decide(ctx(user("compliance@longbow.ch", ["user", "compliance"])), e.id, "approved", "Fine");
    expect(decided).toMatchObject({ status: "approved", decidedBy: "compliance@longbow.ch", decisionComment: "Fine" });
    await expect(c.services.escalations.decide(ctx(user("compliance@longbow.ch", ["compliance"])), e.id, "rejected")).rejects.toMatchObject({ code: "conflict" });
    expect(c.repos.audit.events.map((x) => x.type)).toEqual(["compliance_escalated", "compliance_decision"]);
  });
});
