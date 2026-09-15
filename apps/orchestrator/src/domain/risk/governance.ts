import type { ActionType, ExecutionTarget, Policy, RiskLevel } from "@oao/shared";

/**
 * Governance matrix (project dossier): what each action type implies.
 * "send" and "delete" are NOT action types — the AI never sends nor deletes.
 */
export interface GovernanceRule {
  riskLevel: RiskLevel;
  executionTarget: ExecutionTarget;
  /** Purely informational actions do not need approval; everything else does. */
  informational: boolean;
  /** Human readable label (en / fr) for the approval dialog. */
  label: { en: string; fr: string };
}

export const GOVERNANCE: Record<ActionType, GovernanceRule> = {
  draft_reply: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Open draft reply", fr: "Ouvrir un brouillon de réponse" } },
  categorize: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Categorize email", fr: "Catégoriser l'email" } },
  flag: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Flag email", fr: "Marquer l'email" } },
  archive: { riskLevel: "low", executionTarget: "server", informational: false, label: { en: "Archive email thread", fr: "Archiver la conversation" } },
  move_to_folder: { riskLevel: "low", executionTarget: "server", informational: false, label: { en: "Move to folder", fr: "Déplacer vers un dossier" } },
  create_reminder: { riskLevel: "medium", executionTarget: "server", informational: false, label: { en: "Create calendar reminder", fr: "Créer un rappel" } },
  create_task: { riskLevel: "medium", executionTarget: "server", informational: false, label: { en: "Create task", fr: "Créer une tâche" } },
  notify: { riskLevel: "low", executionTarget: "none", informational: true, label: { en: "Notify", fr: "Notifier" } },
  request_document: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Request document", fr: "Demander un document" } },
  escalate_compliance: { riskLevel: "high", executionTarget: "server", informational: false, label: { en: "Escalate to compliance", fr: "Escalader à la compliance" } },
  apply_label: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Apply classification label", fr: "Appliquer une étiquette" } },
  remove_attachment: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Remove attachment", fr: "Retirer la pièce jointe" } },
  classify_email: { riskLevel: "low", executionTarget: "client", informational: false, label: { en: "Classify email", fr: "Classer l'email" } },
  request_approval: { riskLevel: "medium", executionTarget: "server", informational: false, label: { en: "Request approval", fr: "Demander une approbation" } },
};

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export const maxRisk = (...levels: RiskLevel[]): RiskLevel =>
  levels.reduce<RiskLevel>((acc, l) => (RISK_ORDER[l] > RISK_ORDER[acc] ? l : acc), "low");

export const riskAtLeast = (level: RiskLevel, threshold: RiskLevel): boolean => RISK_ORDER[level] >= RISK_ORDER[threshold];

export interface GovernanceDecision {
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  requiresComplianceApproval: boolean;
  executionTarget: ExecutionTarget;
}

/**
 * Decide the governance attributes of an action.
 * `contextRisk` lets callers raise the level (e.g. an external recipient involved).
 */
export function govern(type: ActionType, policy: Pick<Policy, "complianceApprovalFor" | "approvalRequiredFrom">, contextRisk: RiskLevel = "low"): GovernanceDecision {
  const rule = GOVERNANCE[type];
  const riskLevel = maxRisk(rule.riskLevel, contextRisk);
  const requiresComplianceApproval = policy.complianceApprovalFor.includes(type) || type === "escalate_compliance";
  // Approval is always required except for purely informational actions — and even those when the
  // (context-raised) risk reaches "medium" or the policy threshold, whichever is higher.
  const threshold: RiskLevel = riskAtLeast(policy.approvalRequiredFrom, "medium") ? policy.approvalRequiredFrom : "medium";
  const requiresApproval = !rule.informational || riskAtLeast(riskLevel, threshold);
  return { riskLevel, requiresApproval, requiresComplianceApproval, executionTarget: rule.executionTarget };
}

export const isActionType = (value: unknown): value is ActionType => typeof value === "string" && value in GOVERNANCE;

export const actionLabel = (type: ActionType, lang: "fr" | "en"): string => GOVERNANCE[type].label[lang];
