"use client";

import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { FilterSelect, type FilterOption } from "./filter-select";
import { useQueryParams } from "@/lib/use-query-params";

export interface AuditFilterOptions {
  users: FilterOption[];
  types: FilterOption[];
  risks: FilterOption[];
  approvals: FilterOption[];
}

const FILTER_KEYS = ["user", "type", "risk", "approval"];

/** Grid of the four audit filters. Reused inside the sheet and the Filters card. */
export function AuditFilterFields({
  options,
  messages,
  className,
}: {
  options: AuditFilterOptions;
  messages: Record<string, string>;
  className?: string;
}) {
  const { get, set } = useQueryParams();
  const t = (k: string) => messages[k] ?? k;
  const all = t("filters.all");
  return (
    <div className={className ?? "grid gap-3"}>
      <FilterSelect
        id="f-user"
        label={t("filters.users")}
        value={get("user")}
        options={options.users}
        allLabel={all}
        onChange={(v) => set("user", v)}
      />
      <FilterSelect
        id="f-type"
        label={t("filters.actionType")}
        value={get("type")}
        options={options.types}
        allLabel={all}
        onChange={(v) => set("type", v)}
      />
      <FilterSelect
        id="f-risk"
        label={t("filters.riskLevel")}
        value={get("risk")}
        options={options.risks}
        allLabel={all}
        onChange={(v) => set("risk", v)}
      />
      <FilterSelect
        id="f-approval"
        label={t("filters.approvalStatus")}
        value={get("approval")}
        options={options.approvals}
        allLabel={all}
        onChange={(v) => set("approval", v)}
      />
    </div>
  );
}

export function FiltersSheet({
  options,
  messages,
}: {
  options: AuditFilterOptions;
  messages: Record<string, string>;
}) {
  const [open, setOpen] = React.useState(false);
  const { get, reset } = useQueryParams();
  const t = (k: string) => messages[k] ?? k;
  const activeCount = FILTER_KEYS.filter((k) => get(k)).length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          <SlidersHorizontal className="h-4 w-4 text-[#616161]" />
          {t("filters.title")}
          {activeCount > 0 && (
            <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">
              {activeCount}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t("filters.title")}</SheetTitle>
          <SheetDescription>{t("page.audit.subtitle")}</SheetDescription>
        </SheetHeader>
        <div className="mt-5">
          <AuditFilterFields options={options} messages={messages} className="grid gap-4" />
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={() => reset(FILTER_KEYS)}>
            {t("filters.reset")}
          </Button>
          <Button onClick={() => setOpen(false)}>{t("filters.apply")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
