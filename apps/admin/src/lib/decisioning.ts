import type { DecisioningStatus } from "@oao/shared";

/**
 * View helpers for the structured-decision engine (Laya) card of the System
 * page. Pure functions so they are unit-tested without a DOM.
 *
 * `SystemStatus.decisioning` is optional: an orchestrator that predates the
 * engine does not send it, and the card is then not rendered at all.
 */

export const DECISION_STATE_VARIANT = {
  ok: "low",
  degraded: "medium",
  unavailable: "high",
  disabled: "neutral",
} as const satisfies Record<DecisioningStatus["state"], string>;

export const DECISION_CIRCUIT_VARIANT = {
  closed: "low",
  half_open: "medium",
  open: "high",
} as const satisfies Record<DecisioningStatus["circuit"], string>;

/** Percentage (0–100) of decisions where at least one answer was set aside; null before the first decision. */
export function lowConfidenceShare(d: DecisioningStatus): number | null {
  if (typeof d.stats.lowConfidenceRate === "number") return d.stats.lowConfidenceRate * 100;
  return d.stats.decisions > 0 ? (d.stats.lowConfidence / d.stats.decisions) * 100 : null;
}

/** Percentage (0–100) of decisions that fell back (engine failure or low confidence); null before the first decision. */
export function fallbackShare(d: DecisioningStatus): number | null {
  return d.stats.decisions > 0 ? Math.min(100, (d.stats.fallbacks / d.stats.decisions) * 100) : null;
}

/** "language", "auto" or "fixed · multilingual" — never a URL, a key or content. */
export function modelStrategyLabel(d: DecisioningStatus): string {
  return d.modelStrategy === "fixed" && d.fixedModel ? `fixed · ${d.fixedModel}` : d.modelStrategy;
}

/** 0.75 → "75%". */
export function threshold(value: number): string {
  return `${Math.round(value * 100)}%`;
}
