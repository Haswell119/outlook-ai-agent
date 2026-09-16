import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type ComposeContext, type Policy } from "@oao/shared";
import { evaluateCompliance, findSensitiveData, resetIssueIds } from "../../src/domain/compliance/rules.js";
import { isLookalikeDomain, isFreeMailDomain } from "../../src/domain/compliance/lookalike.js";

const draft = (over: Partial<ComposeContext> = {}): ComposeContext => ({ to: [{ address: "colleague@northbridge.example" }], cc: [], bcc: [], subject: "Hello", body: "Just a quick internal note about the meeting.", attachments: [], sensitivityLabel: "Internal", ...over });
const policy: Policy = { ...DEFAULT_POLICY };
const codes = (d: ComposeContext, p: Policy = policy, extra = {}) => evaluateCompliance(d, p, { language: "en", ...extra }).issues.map((i) => i.code);

beforeEach(() => resetIssueIds());

describe("compliance rules", () => {
  it("allows a clean internal email", () => {
    const r = evaluateCompliance(draft(), policy, { language: "en" });
    expect(r.issues).toEqual([]);
    expect(r.verdict).toBe("allow");
    expect(r.recommendedActions).toEqual([]);
  });

  it("external_recipient: medium without attachments, high with attachments / sensitive content", () => {
    const r1 = evaluateCompliance(draft({ to: [{ address: "michael.brown@clientco.com" }] }), policy, { language: "en" });
    expect(r1.issues.find((i) => i.code === "external_recipient")?.severity).toBe("medium");
    const r2 = evaluateCompliance(draft({ to: [{ address: "michael.brown@clientco.com" }], attachments: [{ name: "agenda.pdf" }] }), policy, { language: "en" });
    expect(r2.issues.find((i) => i.code === "external_recipient")?.severity).toBe("high");
    expect(r2.verdict).toBe("warn");
  });

  it("suspicious_recipient_domain: lookalike of internal domain and free-mail with sensitive content", () => {
    expect(codes(draft({ to: [{ address: "x@northbridqe.example" }] }))).toContain("suspicious_recipient_domain");
    expect(codes(draft({ to: [{ address: "x@northbridge-capital.com" }] }))).toContain("suspicious_recipient_domain");
    expect(codes(draft({ to: [{ address: "friend@gmail.com" }], body: "IBAN CH93 0076 2011 6238 5295 7" }))).toContain("suspicious_recipient_domain");
    expect(codes(draft({ to: [{ address: "friend@gmail.com" }] }))).not.toContain("suspicious_recipient_domain");
    expect(isLookalikeDomain("northbridge.example", ["northbridge.example"])).toBe(false);
    expect(isLookalikeDomain("mail.northbridge.example", ["northbridge.example"])).toBe(false);
    expect(isLookalikeDomain("northbridge.example.evil.io", ["northbridge.example"])).toBe(true);
    expect(isFreeMailDomain("protonmail.com")).toBe(true);
  });

  it("confidential_attachment: pattern in name or extracted text, high when external", () => {
    const internal = evaluateCompliance(draft({ attachments: [{ name: "Client A – Q2 Performance Report.pdf" }] }), policy, { language: "en" });
    expect(internal.issues.find((i) => i.code === "confidential_attachment")?.severity).toBe("medium");
    const external = evaluateCompliance(draft({ to: [{ address: "a@clientco.com" }], attachments: [{ name: "deck.pdf", textContent: "STRICTLY CONFIDENTIAL – internal only" }] }), policy, { language: "en" });
    expect(external.issues.find((i) => i.code === "confidential_attachment")?.severity).toBe("high");
    expect(external.recommendedActions.map((a) => a.type)).toEqual(expect.arrayContaining(["remove_attachment", "apply_label", "request_approval", "escalate_compliance"]));
  });

  it("missing_classification_label only when the policy defines labels", () => {
    expect(codes(draft({ sensitivityLabel: undefined }))).toContain("missing_classification_label");
    expect(codes(draft({ sensitivityLabel: "Bogus" }))).toContain("missing_classification_label");
    expect(codes(draft({ sensitivityLabel: undefined }), { ...policy, requiredClassificationLabels: [] })).not.toContain("missing_classification_label");
  });

  it("sensitive_client_information from regex patterns (IBAN, AVS, password with (?i) flag)", () => {
    expect(findSensitiveData("IBAN CH93 0076 2011 6238 5295 7", policy).map((m) => m.name)).toContain("IBAN");
    expect(findSensitiveData("AVS 756.1234.5678.97", policy).map((m) => m.name)).toContain("Swiss AVS number");
    expect(findSensitiveData("Mot De Passe: secret", policy).map((m) => m.name)).toContain("Password");
    const r = evaluateCompliance(draft({ body: "Password: hunter2" }), policy, { language: "fr" });
    const issue = r.issues.find((i) => i.code === "sensitive_client_information");
    expect(issue?.severity).toBe("high");
    expect(issue?.title).toContain("sensibles");
  });

  it("sensitive_client_information from the LLM check when no regex matched", () => {
    const r = evaluateCompliance(draft({ to: [{ address: "a@clientco.com" }] }), policy, { language: "en", llmSensitive: { sensitive: true, explanation: "Portfolio values are mentioned.", confidence: 0.8 } });
    const issue = r.issues.find((i) => i.code === "sensitive_client_information");
    expect(issue?.severity).toBe("high");
    expect(issue?.description).toBe("Portfolio values are mentioned.");
  });

  it("large_distribution and reply_all_external", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ address: `p${i}@ext.com` }));
    expect(codes(draft({ to: many }))).toContain("large_distribution");
    expect(codes(draft({ to: [{ address: "a@ext.com" }], isReplyAll: true }))).toContain("reply_all_external");
    expect(codes(draft({ isReplyAll: true }))).not.toContain("reply_all_external");
  });

  it("verdict block when policy.blockOnHighRisk and a high issue exists", () => {
    const r = evaluateCompliance(draft({ to: [{ address: "a@clientco.com" }], attachments: [{ name: "x.pdf" }] }), { ...policy, blockOnHighRisk: true }, { language: "en" });
    expect(r.verdict).toBe("block");
  });
});
