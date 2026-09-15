import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, ActionTypeSchema } from "@oao/shared";
import { GOVERNANCE, govern, maxRisk, riskAtLeast, isActionType, actionLabel } from "../../src/domain/risk/governance.js";

describe("governance matrix", () => {
  it("covers every action type of the contract and never contains send/delete", () => {
    for (const t of ActionTypeSchema.options) expect(GOVERNANCE[t]).toBeDefined();
    expect(Object.keys(GOVERNANCE)).not.toContain("send_email");
    expect(Object.keys(GOVERNANCE)).not.toContain("delete_email");
    expect(isActionType("delete")).toBe(false);
    expect(isActionType("draft_reply")).toBe(true);
  });

  it("requires approval for every non-informational action", () => {
    for (const t of ActionTypeSchema.options) {
      const d = govern(t, DEFAULT_POLICY);
      if (t === "notify") expect(d.requiresApproval).toBe(false);
      else expect(d.requiresApproval).toBe(true);
    }
  });

  it("maps execution targets and default risk from the dossier", () => {
    expect(govern("draft_reply", DEFAULT_POLICY)).toMatchObject({ riskLevel: "low", executionTarget: "client" });
    expect(govern("create_reminder", DEFAULT_POLICY)).toMatchObject({ riskLevel: "medium", executionTarget: "server" });
    expect(govern("escalate_compliance", DEFAULT_POLICY)).toMatchObject({ riskLevel: "high", executionTarget: "server", requiresComplianceApproval: true });
    expect(govern("notify", DEFAULT_POLICY).executionTarget).toBe("none");
  });

  it("raises risk with context and honours policy.complianceApprovalFor", () => {
    expect(govern("categorize", DEFAULT_POLICY, "medium").riskLevel).toBe("medium");
    expect(govern("archive", { ...DEFAULT_POLICY, complianceApprovalFor: ["archive"] }).requiresComplianceApproval).toBe(true);
    expect(govern("notify", DEFAULT_POLICY, "high").requiresApproval).toBe(true);
  });

  it("helpers", () => {
    expect(maxRisk("low", "high", "medium")).toBe("high");
    expect(riskAtLeast("medium", "low")).toBe(true);
    expect(riskAtLeast("low", "medium")).toBe(false);
    expect(actionLabel("flag", "fr")).toContain("Marquer");
  });
});
