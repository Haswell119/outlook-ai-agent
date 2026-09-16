import "server-only";
import type { Language } from "@oao/shared";
import { getFeatures, getUsers } from "./api";
import { AI_SOURCE_FILTERS, APPROVAL_STATUSES, RISK_LEVELS } from "./query";
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
  // Models come from the running configuration, so the list never goes stale.
  let models: AuditFilterOptions["models"] = [];
  try {
    const features = await getFeatures();
    models = [features.llmModel, features.llmFastModel, features.embeddingModel]
      .filter((m): m is string => Boolean(m))
      .filter((m, i, list) => list.indexOf(m) === i)
      .map((m) => ({ value: m, label: m }));
  } catch {
    models = [];
  }

  return {
    users,
    sources: AI_SOURCE_FILTERS.map((s) => ({ value: s, label: dict[`source.${s}`] ?? s })),
    models,
    types: AUDIT_EVENT_TYPES.map((t) => ({ value: t, label: eventMeta(t).label })),
    risks: RISK_LEVELS.map((r) => ({ value: r, label: dict[`risk.${r}`] ?? r })),
    approvals: APPROVAL_STATUSES.filter((a) => a !== "n/a").map((a) => ({
      value: a,
      label: dict[`approval.${a}`] ?? a,
    })),
  };
}
