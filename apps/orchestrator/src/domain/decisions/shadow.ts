import type { DetectedRisk, SuggestedAction } from "@oao/shared";
import { normalizeForHash } from "../cacheKey.js";
import type { Taxonomy } from "./taxonomy.js";

/**
 * Shadow comparison: engine decisions vs what the historic pipeline produced
 * for the same email. The historic analysis has no explicit urgency, area or
 * reply flag, so the comparison uses **proxies** — good enough to watch
 * agreement drift during a shadow phase, never a substitute for the annotated
 * evaluation dataset (docs/LAYA.md §évaluation):
 *
 *  - businessArea   ↔ the historic free-text `classification.category`, mapped
 *                     onto the taxonomy by label / id / folder name
 *                     (`unmapped` when it matches no area, or several);
 *  - urgency        ↔ `high|critical` vs a historic `urgency` risk or a
 *                     high-severity deadline risk;
 *  - replyExpected  ↔ the historic analysis suggesting a `draft_reply`;
 *  - actionRequired ↔ the historic analysis listing pending tasks.
 */
export type ComparisonResult = "match" | "mismatch" | "unmapped" | "unavailable";

export const COMPARED_QUESTIONS = ["businessArea", "urgency", "replyExpected", "actionRequired"] as const;
export type ComparedQuestion = (typeof COMPARED_QUESTIONS)[number];
export type ShadowComparison = Record<ComparedQuestion, ComparisonResult>;

/** What the engine answered (raw choices, accepted or not: agreement is measured on the answer itself). */
export interface EngineChoices {
  businessArea?: string;
  urgency?: string;
  replyExpected?: string;
  actionRequired?: string;
}

/** The historic (LLM, full prompt) answer. */
export interface HistoricAnalysis {
  classification?: { category: string };
  risks: Pick<DetectedRisk, "code" | "severity">[];
  suggestedActions: Pick<SuggestedAction, "type">[];
  pendingTasks: string[];
}

/** Area ids whose id, label or folder names match a free-text category (both directions of containment). */
export function mapCategoryToAreas(category: string, taxonomy: Taxonomy): string[] {
  const c = normalizeForHash(category).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!c) return [];
  const matches = (candidate: string): boolean => {
    const n = normalizeForHash(candidate).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return n.length >= 3 && (c === n || ` ${c} `.includes(` ${n} `) || ` ${n} `.includes(` ${c} `));
  };
  return taxonomy.areas
    .filter((a) => [a.id.replace(/_/g, " "), a.labels.fr, a.labels.en, ...a.folders.flatMap((f) => [f.id.replace(/_/g, " "), f.displayName, f.displayName.split("/").pop() ?? ""])].some(matches))
    .map((a) => a.id);
}

export function compareWithHistoric(engine: EngineChoices, historic: HistoricAnalysis, taxonomy: Taxonomy): ShadowComparison {
  const cmp = (engineValue: boolean | undefined, historicValue: boolean): ComparisonResult => (engineValue === undefined ? "unavailable" : engineValue === historicValue ? "match" : "mismatch");

  let businessArea: ComparisonResult = "unavailable";
  if (engine.businessArea) {
    const candidates = historic.classification?.category ? mapCategoryToAreas(historic.classification.category, taxonomy) : [];
    businessArea = candidates.length === 1 ? (candidates[0] === engine.businessArea ? "match" : "mismatch") : "unmapped";
  }
  const historicUrgent = historic.risks.some((r) => r.code === "urgency" || ((r.code === "deadline" || r.code === "deadline_at_risk") && r.severity === "high"));
  const engineUrgent = engine.urgency === undefined ? undefined : engine.urgency === "high" || engine.urgency === "critical";
  const required = (v: string | undefined) => (v === undefined ? undefined : v === "required");

  return {
    businessArea,
    urgency: cmp(engineUrgent, historicUrgent),
    replyExpected: cmp(required(engine.replyExpected), historic.suggestedActions.some((a) => a.type === "draft_reply")),
    actionRequired: cmp(required(engine.actionRequired), historic.pendingTasks.length > 0),
  };
}
