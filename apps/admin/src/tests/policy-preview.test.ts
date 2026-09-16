import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "@oao/shared";
import {
  compilePattern,
  evaluatePolicyPreview,
  parseRecipients,
  validateRegex,
} from "@/lib/policy-preview";
import { defaultPolicy } from "@/lib/mock-data";

describe("regex validation in the Policy Center", () => {
  it("accepts the patterns shipped in DEFAULT_POLICY", () => {
    for (const pattern of DEFAULT_POLICY.sensitiveDataPatterns) {
      expect(validateRegex(pattern.pattern).valid, `${pattern.name} should compile`).toBe(true);
    }
  });

  it("reports a broken pattern with the engine's message", () => {
    const result = validateRegex("[A-Z");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/character class|Invalid/i);
    expect(validateRegex("(unclosed").valid).toBe(false);
    expect(validateRegex("a{2,1}").valid).toBe(false);
    expect(validateRegex("   ").valid).toBe(false);
  });

  it("translates a leading inline flag group instead of rejecting it", () => {
    // `(?i)` is accepted by the server-side engine but not by RegExp.
    expect(() => new RegExp("(?i)password")).toThrow();
    const result = validateRegex("(?i)\\b(?:password|mot de passe)\\s*[:=]");
    expect(result.valid).toBe(true);
    expect(result.note).toBe("inline-flags");

    const compiled = compilePattern("(?i)password");
    expect(compiled.translatedInlineFlags).toBe(true);
    expect(compiled.regex.flags).toContain("i");
    expect(compiled.regex.test("PASSWORD")).toBe(true);
  });
});

describe("rule preview evaluator", () => {
  const policy: Policy = defaultPolicy();

  it("splits a free-text recipient list", () => {
    expect(parseRecipients("a@x.example, b@x.example\nc@x.example; ")).toEqual([
      "a@x.example",
      "b@x.example",
      "c@x.example",
    ]);
    expect(parseRecipients("")).toEqual([]);
  });

  it("fires the sensitive-data patterns of the edited policy", () => {
    const findings = evaluatePolicyPreview(policy, {
      text: "Please confirm IBAN CH9300762011623852957 for the transfer.",
      recipients: [],
    });
    expect(findings.some((f) => f.kind === "sensitive" && f.rule === "IBAN")).toBe(true);
    const iban = findings.find((f) => f.rule === "IBAN");
    expect(iban?.severity).toBe("high");
    expect(iban?.count).toBe(1);
    expect(iban?.samples[0]).toContain("CH93");
  });

  it("flags confidential markers, external recipients and large distributions", () => {
    const findings = evaluatePolicyPreview(
      { ...policy, largeDistributionThreshold: 2 },
      {
        text: "This report is CONFIDENTIAL and internal only.",
        recipients: [
          "colleague@northbridge.example",
          "client@abccapital.example",
          "ops@abccapital.example",
          "legal@clientco.example",
        ],
      },
    );
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("confidential");
    expect(kinds).toContain("external");
    expect(kinds).toContain("large_distribution");

    const external = findings.find((f) => f.kind === "external");
    expect(external?.count).toBe(3);
    expect(external?.samples).not.toContain("colleague@northbridge.example");
  });

  it("returns nothing for a clean internal sample and sorts by severity", () => {
    expect(
      evaluatePolicyPreview(policy, {
        text: "Lunch at 12:30?",
        recipients: ["colleague@northbridge.example"],
      }),
    ).toEqual([]);

    const findings = evaluatePolicyPreview(policy, {
      text: "CONFIDENTIAL — IBAN CH9300762011623852957",
      recipients: ["client@abccapital.example"],
    });
    const severities = findings.map((f) => f.severity);
    expect(severities.indexOf("high")).toBeLessThan(severities.lastIndexOf("medium"));
  });

  it("ignores patterns that do not compile instead of throwing", () => {
    const broken: Policy = {
      ...policy,
      sensitiveDataPatterns: [{ name: "broken", pattern: "[A-Z", severity: "high" }],
    };
    expect(() => evaluatePolicyPreview(broken, { text: "ABC", recipients: [] })).not.toThrow();
    expect(evaluatePolicyPreview(broken, { text: "ABC", recipients: [] })).toEqual([]);
  });
});
