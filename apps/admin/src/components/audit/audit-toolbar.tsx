"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AuditFilterFields, type AuditFilterOptions } from "./filters";
import { useQueryParams } from "@/lib/use-query-params";

/** Full toolbar of the /audit page: search + the four filters + page size. */
export function AuditToolbar({
  options,
  messages,
}: {
  options: AuditFilterOptions;
  messages: Record<string, string>;
}) {
  const { get, set } = useQueryParams();
  const t = (k: string) => messages[k] ?? k;
  const [term, setTerm] = React.useState(get("q"));

  React.useEffect(() => {
    setTerm(get("q"));
  }, [get]);

  return (
    <div className="grid gap-3 lg:grid-cols-6">
      <form
        className="lg:col-span-2"
        onSubmit={(e) => {
          e.preventDefault();
          set("q", term);
        }}
      >
        <Label htmlFor="audit-search" className="mb-1 block">
          {t("filters.search")}
        </Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A8886]" />
          <Input
            id="audit-search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onBlur={() => set("q", term)}
            placeholder={t("filters.searchPlaceholder")}
            className="pl-8"
          />
        </div>
      </form>

      <AuditFilterFields
        options={options}
        messages={messages}
        className="grid gap-3 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-4"
      />

      <div>
        <Label htmlFor="page-size" className="mb-1 block">
          {t("filters.pageSize")}
        </Label>
        <Select value={get("pageSize", "25")} onValueChange={(v) => set("pageSize", v)}>
          <SelectTrigger id="page-size" className="h-9 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 25, 50, 100].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
