import { describe, expect, it } from "vitest";
import { SystemStatusSchema, type DecisioningStatus } from "@oao/shared";
import {
  DECISION_CIRCUIT_VARIANT,
  DECISION_STATE_VARIANT,
  fallbackShare,
  lowConfidenceShare,
  modelStrategyLabel,
  threshold,
} from "@/lib/decisioning";
import { dictionaries } from "@/lib/i18n";
import { mockSystemStatus } from "@/lib/mock-data";

const base = (): DecisioningStatus => ({
  provider: "laya",
  mode: "active",
  state: "ok",
  circuit: "closed",
  modelStrategy: "language",
  decisionVersion: "v1",
  minConfidence: 0.75,
  folderMinConfidence: 0.8,
  fallbackToLlm: true,
  shadowSampleRate: 1,
  concurrency: 1,
  stats: { decisions: 0, providerCalls: 0, failures: 0, fallbacks: 0, lowConfidence: 0, inFlight: 0, pending: 0 },
});

describe("decision engine card (System page)", () => {
  it("the mock status carries an optional decisioning block that validates against the contract", () => {
    const status = SystemStatusSchema.parse(mockSystemStatus());
    expect(status.decisioning).toMatchObject({ provider: "laya", mode: "shadow", state: "ok" });
    expect(status.health.checks.laya?.status).toBe("ok");
  });

  it("a status without decisioning (older orchestrator) still validates", () => {
    const { decisioning: _omit, ...legacy } = mockSystemStatus();
    expect(SystemStatusSchema.parse(legacy).decisioning).toBeUndefined();
  });

  it("rates are null before the first decision, percentages after", () => {
    expect(lowConfidenceShare(base())).toBeNull();
    expect(fallbackShare(base())).toBeNull();
    const d = { ...base(), stats: { ...base().stats, decisions: 200, fallbacks: 30, lowConfidence: 50 } };
    expect(lowConfidenceShare(d)).toBe(25);
    expect(fallbackShare(d)).toBe(15);
    // The orchestrator's own rate wins when present.
    expect(lowConfidenceShare({ ...d, stats: { ...d.stats, lowConfidenceRate: 0.1 } })).toBeCloseTo(10);
    // Hierarchical decisions can fall back twice: the share is capped.
    expect(fallbackShare({ ...d, stats: { ...d.stats, fallbacks: 500 } })).toBe(100);
  });

  it("labels the model strategy and the thresholds", () => {
    expect(modelStrategyLabel(base())).toBe("language");
    expect(modelStrategyLabel({ ...base(), modelStrategy: "fixed", fixedModel: "multilingual" })).toBe("fixed · multilingual");
    expect(threshold(0.75)).toBe("75%");
    expect(threshold(0.8)).toBe("80%");
  });

  it("every state, circuit and mode has a badge variant and a label in both languages", () => {
    for (const lang of ["en", "fr"] as const) {
      const dict = dictionaries[lang] as Record<string, string>;
      for (const state of Object.keys(DECISION_STATE_VARIANT)) expect(dict[`system.decision.state.${state}`], `${lang} state ${state}`).toBeTruthy();
      for (const circuit of Object.keys(DECISION_CIRCUIT_VARIANT)) expect(dict[`system.decision.circuit.${circuit}`], `${lang} circuit ${circuit}`).toBeTruthy();
      for (const mode of ["shadow", "active"]) expect(dict[`system.decision.mode.${mode}`], `${lang} mode ${mode}`).toBeTruthy();
    }
  });

  it("the card shows no secret or endpoint: the status contract has no field for them", () => {
    const serialized = JSON.stringify(mockSystemStatus().decisioning);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/api[-_]?key|bearer|token/i);
  });
});
