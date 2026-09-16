import { describe, expect, it } from "vitest";
import type { UserActionEvent } from "@oao/shared";
import { automationFingerprint, detectAutomations, MINUTES_PER_STEP } from "../../src/domain/automation/detector.js";
import { matchesTrigger, simulateAutomation } from "../../src/domain/automation/simulation.js";

const now = new Date("2025-06-10T12:00:00Z");
function routine(n: number, domain = "abccapital.com", types: UserActionEvent["type"][] = ["open_email", "save_attachment", "categorize", "create_reminder"]): UserActionEvent[] {
  const out: UserActionEvent[] = [];
  for (let i = 0; i < n; i++) {
    const base = now.getTime() - (i + 1) * 86_400_000;
    types.forEach((type, j) =>
      out.push({ type, occurredAt: new Date(base + j * 60_000).toISOString(), email: { id: `e${domain}${i}`, fromAddress: `reports@${domain}`, fromDomain: domain, subject: `Daily report ${i} – ABC Capital`, hasAttachments: true }, parameters: type === "save_attachment" ? { folder: "\\\\Reports\\ABC" } : type === "categorize" ? { category: "ABC – Reporting" } : {} }),
    );
  }
  return out;
}

describe("automation detector", () => {
  it("finds a recurring sequence (≥3 occurrences, ≥2 action types) and estimates savings", () => {
    const [a] = detectAutomations(routine(5), { now, language: "en" });
    expect(a).toBeDefined();
    expect(a!.trigger.conditions).toMatchObject({ fromDomain: "abccapital.com", hasAttachments: true });
    expect(a!.steps.map((s) => s.type)).toEqual(["detect_attachment", "save_attachment", "categorize", "create_reminder"]);
    expect(a!.stats.occurrences).toBe(5);
    expect(a!.stats.estimatedMinutesPerOccurrence).toBe(MINUTES_PER_STEP.save_attachment! + MINUTES_PER_STEP.categorize! + MINUTES_PER_STEP.create_reminder!);
    expect(a!.stats.estimatedMinutesSavedPerWeek).toBeGreaterThan(0);
    expect(a!.riskLevel).toBe("low");
    expect(a!.confidence).toBeGreaterThan(0.6);
    expect(a!.steps[1]!.description).toContain("\\\\Reports\\ABC");
  });

  it("ignores sequences below the threshold, outside the window, or with a single action", () => {
    expect(detectAutomations(routine(2), { now })).toEqual([]);
    const old = routine(5).map((e) => ({ ...e, occurredAt: new Date(Date.parse(e.occurredAt) - 60 * 86_400_000).toISOString() }));
    expect(detectAutomations(old, { now })).toEqual([]);
    expect(detectAutomations(routine(5, "x.com", ["open_email", "categorize"]).filter((e) => e.type !== "open_email"), { now })).toEqual([]);
  });

  it("marks move/archive routines as medium risk and produces stable fingerprints", () => {
    const [a] = detectAutomations(routine(4, "bank.ch", ["categorize", "move_to_folder"]), { now, language: "fr" });
    expect(a!.riskLevel).toBe("medium");
    expect(a!.name).toContain("bank.ch");
    const fp1 = automationFingerprint(a!.trigger, a!.steps);
    const fp2 = automationFingerprint({ ...a!.trigger, description: "other text" }, a!.steps);
    expect(fp1).toBe(fp2);
    expect(automationFingerprint(a!.trigger, a!.steps.slice(0, 1))).not.toBe(fp1);
  });
});

describe("automation simulation", () => {
  const [auto] = detectAutomations(routine(4), { now, language: "en" });
  const emails = [
    { emailId: "1", subject: "Daily report 1 – ABC Capital", fromAddress: "reports@abccapital.com", hasAttachments: true, attachmentNames: ["r.xlsx"] },
    { emailId: "2", subject: "Daily report 2 – ABC Capital", fromAddress: "reports@abccapital.com", hasAttachments: false },
    { emailId: "3", subject: "Lunch?", fromAddress: "friend@other.com", hasAttachments: true },
  ];
  it("matches the trigger and reports checks without side effects", () => {
    expect(matchesTrigger(auto!.trigger, emails[0]!)).toBe(true);
    expect(matchesTrigger(auto!.trigger, emails[1]!)).toBe(false);
    expect(matchesTrigger(auto!.trigger, emails[2]!)).toBe(false);
    const sim = simulateAutomation(auto!, emails, "en", "2025-06-10T12:00:00Z");
    expect(sim.sampleSize).toBe(3);
    expect(sim.results.filter((r) => r.wouldApply).map((r) => r.emailId)).toEqual(["1"]);
    expect(sim.results[0]!.stepsPreview.length).toBe(auto!.steps.length);
    expect(sim.checks.map((c) => c.name)).toEqual(["Attachment detection accuracy", "Correct folder mapping", "Category assignment", "Reminder creation"]);
    expect(sim.checks.every((c) => c.passed)).toBe(true);
  });
  it("fails the folder check when no folder is configured", () => {
    const steps = auto!.steps.map((s) => (s.type === "save_attachment" ? { ...s, parameters: {} } : s));
    const sim = simulateAutomation({ trigger: auto!.trigger, steps }, emails, "fr");
    expect(sim.checks.find((c) => c.name.includes("Dossier"))?.passed).toBe(false);
  });
});
