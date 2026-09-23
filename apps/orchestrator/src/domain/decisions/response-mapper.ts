import type { DecisionChoiceQuestion, DecisionProviderResponse } from "../../ports/decision.js";
import { NOT_REQUIRED, REQUIRED, URGENCY_LEVELS, type UrgencyOption } from "./question-builder.js";

/**
 * Engine answer → typed value, checked against the question that was asked.
 * Structural problems (no answer, an option that was never offered) are
 * reported, not thrown: the confidence policy then decides, and the caller
 * falls back. Nothing here trusts the engine beyond what it validated.
 */
export type MappedStatus = "ok" | "missing" | "unknown_value";

export interface MappedChoice<T> {
  question: string;
  status: MappedStatus;
  /** Typed value (urgency level, boolean, area id…), only when `status === "ok"`. */
  value?: T;
  /** Raw option id the engine chose (also set for `unknown_value`, for the audit). */
  choice?: string;
  /** Engine-reported confidence, 0..1 (Laya: normalised entropy). */
  confidence?: number;
  /** Probability of the chosen option, when given. */
  probability?: number;
  /** Full distribution (audit only). */
  probabilities?: Record<string, number>;
}

/** Generic mapping: the chosen option must be one of the question's criteria; `toValue` types it. */
export function mapChoice<T>(response: Pick<DecisionProviderResponse, "answers">, questionId: string, question: DecisionChoiceQuestion, toValue: (choice: string) => T | undefined): MappedChoice<T> {
  const answer = response.answers[questionId];
  if (!answer || answer.type !== "choice") return { question: questionId, status: "missing" };
  const base = {
    question: questionId,
    choice: answer.choice,
    confidence: typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : undefined,
    probability: answer.probabilities[answer.choice],
    probabilities: answer.probabilities,
  };
  if (!(answer.choice in question.criteria)) return { ...base, status: "unknown_value" };
  const value = toValue(answer.choice);
  return value === undefined ? { ...base, status: "unknown_value" } : { ...base, status: "ok", value };
}

export const toUrgency = (choice: string): UrgencyOption | undefined => ((URGENCY_LEVELS as readonly string[]).includes(choice) ? (choice as UrgencyOption) : undefined);

/** `required` → true, `not_required` → false, anything else → unknown. */
export const toRequired = (choice: string): boolean | undefined => (choice === REQUIRED ? true : choice === NOT_REQUIRED ? false : undefined);

/** Identity for option ids that must belong to a known set (areas, folders). */
export const toKnownId =
  (known: ReadonlySet<string>) =>
  (choice: string): string | undefined =>
    known.has(choice) ? choice : undefined;

/** Audit-friendly projection (no probabilities beyond the chosen one to keep records small). */
export function auditChoice(m: MappedChoice<unknown>, accepted: boolean): Record<string, unknown> {
  return { status: m.status, choice: m.choice, confidence: m.confidence, probability: m.probability, accepted };
}
