import "server-only";
import type { Language } from "@oao/shared";
import { getUsers } from "./api";
import { APPROVAL_STATUSES, RISK_LEVELS } from "./query";
import { dictionaries } from "./i18n";
import { AUDIT_EVENT_TYPES, eventMeta } from "@/components/audit/event-icon";
import type { AuditFilterOptions } from "@/components/audit/filters";

export async function buildFilterOptions(language: Language): Promise<AuditFilterOptions> {
  const dict = dictionaries[language] as unknown as Record<string, string>;
  let users: AuditFilterOptions["users"] = [];
  try {
    users = (await getUsers()).map((u) => ({ value: u.id, label: u.displayName ?? u.email }));
  } catch {
    users = [];
  }
  return {
    users,
    types: AUDIT_EVENT_TYPES.map((t) => ({ value: t, label: eventMeta(t).label })),
    risks: RISK_LEVELS.map((r) => ({ value: r, label: dict[`risk.${r}`] ?? r })),
    approvals: APPROVAL_STATUSES.filter((a) => a !== "n/a").map((a) => ({
      value: a,
      label: dict[`approval.${a}`] ?? a,
    })),
  };
}
