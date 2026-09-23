import { describe, expect, it } from "vitest";
import { assessChoice, planDecision } from "../../src/domain/decisions/confidence-policy.js";
import { mapChoice, toKnownId, toRequired, toUrgency } from "../../src/domain/decisions/response-mapper.js";
import { detectEmailLanguage, questionLanguage, selectModel } from "../../src/domain/decisions/routing.js";
import { compareWithHistoric, mapCategoryToAreas } from "../../src/domain/decisions/shadow.js";
import { loadTaxonomy } from "../../src/domain/decisions/taxonomy.js";
import type { DecisionChoiceQuestion, DecisionProviderResponse } from "../../src/ports/decision.js";

const urgencyQ: DecisionChoiceQuestion = { type: "choice", instructions: "i", criteria: { low: "l", normal: "n", high: "h", critical: "c" } };
const replyQ: DecisionChoiceQuestion = { type: "choice", instructions: "i", criteria: { required: "r", not_required: "n" } };
const answer = (id: string, choice: string, confidence?: number, probabilities: Record<string, number> = { [choice]: 0.9 }): Pick<DecisionProviderResponse, "answers"> => ({ answers: { [id]: { type: "choice", choice, probabilities, confidence } } });

describe("response mapper", () => {
  it("maps urgency levels and required / not_required, keeping probability and confidence", () => {
    expect(mapChoice(answer("urgency", "critical", 0.8, { critical: 0.9, high: 0.1 }), "urgency", urgencyQ, toUrgency)).toEqual({ question: "urgency", status: "ok", value: "critical", choice: "critical", confidence: 0.8, probability: 0.9, probabilities: { critical: 0.9, high: 0.1 } });
    expect(mapChoice(answer("replyExpected", "required", 0.9), "replyExpected", replyQ, toRequired).value).toBe(true);
    expect(mapChoice(answer("replyExpected", "not_required", 0.9), "replyExpected", replyQ, toRequired).value).toBe(false);
  });

  it("an option that was never offered is `unknown_value`; a missing answer is `missing`", () => {
    expect(mapChoice(answer("urgency", "urgent", 0.99), "urgency", urgencyQ, toUrgency).status).toBe("unknown_value");
    const area = mapChoice(answer("businessArea", "hr", 0.9), "businessArea", { type: "choice", instructions: "i", criteria: { hr: "x", other: "y" } }, toKnownId(new Set(["other"])));
    expect(area.status).toBe("unknown_value"); // offered, but not in the known set
    expect(mapChoice({ answers: {} }, "urgency", urgencyQ, toUrgency)).toEqual({ question: "urgency", status: "missing" });
  });

  it("a non-finite confidence is treated as absent", () => {
    expect(mapChoice(answer("urgency", "low", Number.NaN), "urgency", urgencyQ, toUrgency).confidence).toBeUndefined();
  });
});

describe("confidence policy", () => {
  const mapped = (confidence?: number, choice = "high") => mapChoice(answer("urgency", choice, confidence), "urgency", urgencyQ, toUrgency);

  it("above the threshold → accepted; equal → accepted; below → low_confidence", () => {
    expect(assessChoice(mapped(0.9), 0.75)).toEqual({ verdict: "accepted", accepted: true });
    expect(assessChoice(mapped(0.75), 0.75)).toEqual({ verdict: "accepted", accepted: true });
    expect(assessChoice(mapped(0.7499), 0.75)).toEqual({ verdict: "low_confidence", accepted: false });
  });

  it("no confidence, an unknown value or no answer is never accepted", () => {
    expect(assessChoice(mapped(undefined), 0)).toEqual({ verdict: "missing_confidence", accepted: false });
    expect(assessChoice(mapped(0.99, "urgent"), 0.5)).toEqual({ verdict: "unknown_value", accepted: false });
    expect(assessChoice(mapChoice({ answers: {} }, "urgency", urgencyQ, toUrgency), 0)).toEqual({ verdict: "missing_answer", accepted: false });
  });

  it("plans the fallback correctly", () => {
    const base = { mode: "active" as const, status: "ok" as const, areaAccepted: true, fallbackToLlm: true };
    expect(planDecision(base)).toEqual({ promptPath: "narrative", classificationFrom: "laya", source: "laya", degraded: false });
    expect(planDecision({ ...base, status: "failed", failureKind: "timeout" })).toEqual({ promptPath: "full", classificationFrom: "llm", source: "llm_fallback", degraded: true, fallbackReason: "timeout" });
    expect(planDecision({ ...base, status: "failed", failureKind: "circuit_open", fallbackToLlm: false })).toEqual({ promptPath: "narrative", classificationFrom: "none", source: "heuristic", degraded: true, fallbackReason: "circuit_open" });
    expect(planDecision({ ...base, areaAccepted: false, areaVerdict: "low_confidence" })).toEqual({ promptPath: "full", classificationFrom: "llm", source: "llm_fallback", degraded: false, fallbackReason: "low_confidence" });
    expect(planDecision({ ...base, areaAccepted: false, areaVerdict: "missing_confidence", fallbackToLlm: false })).toEqual({ promptPath: "narrative", classificationFrom: "none", source: "laya", degraded: false, fallbackReason: "missing_confidence" });
    expect(planDecision({ ...base, mode: "shadow", areaAccepted: false })).toEqual({ promptPath: "full", classificationFrom: "llm", source: "laya_shadow", degraded: false });
  });
});

describe("language routing", () => {
  it("detects French, English and unknown (never guesses English)", () => {
    expect(detectEmailLanguage("Import NAV bloqué pour demain. Le fichier des positions ne pourra pas être livré.")).toBe("fr");
    expect(detectEmailLanguage("Please find attached the report, we need your approval by Friday.")).toBe("en");
    expect(detectEmailLanguage("Die Datei mit den Positionen für morgen fehlt, bitte prüfen Sie den Import sofort.")).toBe("unknown");
    expect(detectEmailLanguage("OK")).toBe("unknown");
    expect(detectEmailLanguage("NAV NAV NAV import")).toBe("unknown");
  });

  it("language strategy: english → english, French or unknown → multilingual; auto → no model; fixed → the fixed model", () => {
    expect(selectModel("language", "en")).toBe("english");
    expect(selectModel("language", "fr")).toBe("multilingual");
    expect(selectModel("language", "unknown")).toBe("multilingual");
    expect(selectModel("auto", "en")).toBeUndefined();
    expect(selectModel("fixed", "en", "typed-decisions")).toBe("typed-decisions");
  });

  it("questions are English for English-only checkpoints, follow the email on the multilingual one", () => {
    expect(questionLanguage("english", "fr", "fr")).toBe("en");
    expect(questionLanguage("typed-decisions", "fr", "fr")).toBe("en");
    expect(questionLanguage("multilingual", "fr", "en")).toBe("fr");
    expect(questionLanguage("convaiinnovations/laya-multilingual", "en", "fr")).toBe("en");
    expect(questionLanguage("multilingual", "unknown", "fr")).toBe("fr");
    expect(questionLanguage(undefined, "unknown", "fr")).toBe("en"); // auto may route to the English checkpoint
    expect(questionLanguage(undefined, "fr", "en")).toBe("fr");
  });
});

describe("shadow comparison (proxies)", () => {
  const taxonomy = loadTaxonomy().taxonomy;

  it("maps a free-text historic category onto the taxonomy", () => {
    expect(mapCategoryToAreas("Operations/NAV", taxonomy)).toEqual(["operations"]);
    expect(mapCategoryToAreas("Comptabilité", taxonomy)).toEqual(["accounting"]);
    expect(mapCategoryToAreas("Client mandate", taxonomy)).toEqual([]);
    expect(mapCategoryToAreas("", taxonomy)).toEqual([]);
  });

  it("compares area, urgency, reply and action", () => {
    const historic = { classification: { category: "Opérations" }, risks: [{ code: "deadline", severity: "high" as const }], suggestedActions: [{ type: "draft_reply" as const }], pendingTasks: ["x"] };
    expect(compareWithHistoric({ businessArea: "operations", urgency: "critical", replyExpected: "required", actionRequired: "required" }, historic, taxonomy)).toEqual({ businessArea: "match", urgency: "match", replyExpected: "match", actionRequired: "match" });
    expect(compareWithHistoric({ businessArea: "trading", urgency: "low", replyExpected: "not_required", actionRequired: "not_required" }, historic, taxonomy)).toEqual({ businessArea: "mismatch", urgency: "mismatch", replyExpected: "mismatch", actionRequired: "mismatch" });
    expect(compareWithHistoric({ businessArea: "trading" }, { ...historic, classification: { category: "Legal" } }, taxonomy)).toMatchObject({ businessArea: "unmapped", urgency: "unavailable" });
  });
});
