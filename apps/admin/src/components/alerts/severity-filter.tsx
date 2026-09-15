"use client";

import { FilterSelect } from "@/components/audit/filter-select";
import { useQueryParams } from "@/lib/use-query-params";

export function SeverityFilter({ messages }: { messages: Record<string, string> }) {
  const { get, set } = useQueryParams();
  const t = (k: string) => messages[k] ?? k;
  return (
    <FilterSelect
      id="alert-severity"
      label={t("filters.severity")}
      value={get("risk")}
      options={(["high", "medium", "low"] as const).map((r) => ({ value: r, label: t(`risk.${r}`) }))}
      allLabel={t("filters.all")}
      onChange={(v) => set("risk", v)}
      className="w-full sm:w-52"
    />
  );
}
