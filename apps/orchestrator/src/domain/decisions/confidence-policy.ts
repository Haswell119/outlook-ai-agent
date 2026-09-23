import type { DecisionMode, DecisionSource } from "@oao/shared";
import type { MappedChoice } from "./response-mapper.js";

/**
 * Confidence policy — when is an engine answer good enough to act on, and
 * what happens when it is not.
 *
 * Gate: the engine's own `confidence` (Laya: normalised-entropy certainty,
 * the value upstream recommends gating on) must be **≥** the threshold.
 * Equality passes. No confidence at all, no answer, or an option that was
 * never offered never passes: the policy does not guess.
 *
 * Thresholds are configuration (`LAYA_MIN_CONFIDENCE`,
 * `LAYA_FOLDER_MIN_CONFIDENCE`), not proof of calibration: they must be set
 * from a shadow phase measured on an annotated internal dataset
 * (docs/LAYA.md §seuils). A high confidence is not a guarantee of correctness.
 */
export type ConfidenceVerdict = "accepted" | "low_confidence" | "missing_confidence" | "missing_answer" | "unknown_value";

export interface Assessment {
  verdict: ConfidenceVerdict;
  accepted: boolean;
}

export function assessChoice(mapped: MappedChoice<unknown>, threshold: number): Assessment {
  if (mapped.status === "missing") return { verdict: "missing_answer", accepted: false };
  if (mapped.status === "unknown_value") return { verdict: "unknown_value", accepted: false };
  if (mapped.confidence === undefined || !Number.isFinite(mapped.confidence)) return { verdict: "missing_confidence", accepted: false };
  return mapped.confidence >= threshold ? { verdict: "accepted", accepted: true } : { verdict: "low_confidence", accepted: false };
}

/** What the analysis does with the engine's outcome. */
export interface DecisionPlan {
  /** `narrative`: the reduced LLM prompt (no classification asked). `full`: the historic prompt. */
  promptPath: "narrative" | "full";
  /** Who fills the public `classification` field. */
  classificationFrom: "laya" | "llm" | "none";
  /** `decisioning.source` shown to the user (active mode only). */
  source: DecisionSource;
  degraded: boolean;
  fallbackReason?: string;
}

export interface PlanInput {
  mode: DecisionMode;
  /** `failed`: the engine could not answer (outage, invalid answer…). `ok`: it answered. */
  status: "ok" | "failed";
  /** The business area passed the confidence gate. */
  areaAccepted: boolean;
  /** Why the area was not usable, when it was not. */
  areaVerdict?: ConfidenceVerdict;
  /** Error class, when `status === "failed"`. */
  failureKind?: string;
  fallbackToLlm: boolean;
}

/**
 * Active mode:
 *  - usable area → reduced narrative prompt, classification from the engine;
 *  - engine failure → historic prompt (`llm_fallback`, degraded) when the LLM
 *    fallback is on; otherwise narrative only, no classification at all
 *    (`heuristic`, degraded) — a classification is never invented;
 *  - low confidence → same split, not degraded, reason `low_confidence`
 *    (or the precise verdict).
 * Shadow mode never changes anything: historic prompt, historic classification.
 */
export function planDecision(input: PlanInput): DecisionPlan {
  if (input.mode === "shadow") return { promptPath: "full", classificationFrom: "llm", source: "laya_shadow", degraded: false };
  if (input.status === "failed") {
    const reason = input.failureKind ?? "unavailable";
    return input.fallbackToLlm
      ? { promptPath: "full", classificationFrom: "llm", source: "llm_fallback", degraded: true, fallbackReason: reason }
      : { promptPath: "narrative", classificationFrom: "none", source: "heuristic", degraded: true, fallbackReason: reason };
  }
  if (!input.areaAccepted) {
    const reason = input.areaVerdict && input.areaVerdict !== "accepted" ? input.areaVerdict : "low_confidence";
    return input.fallbackToLlm
      ? { promptPath: "full", classificationFrom: "llm", source: "llm_fallback", degraded: false, fallbackReason: reason }
      : { promptPath: "narrative", classificationFrom: "none", source: "laya", degraded: false, fallbackReason: reason };
  }
  return { promptPath: "narrative", classificationFrom: "laya", source: "laya", degraded: false };
}
