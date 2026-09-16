"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryParams } from "@/lib/use-query-params";
import { formatNumber } from "@/lib/format";
import type { Language } from "@oao/shared";

export function Pagination({
  page,
  pageSize,
  total,
  messages,
  language,
}: {
  page: number;
  pageSize: number;
  total: number;
  messages: Record<string, string>;
  language: Language;
}) {
  const { set, pending } = useQueryParams();
  const t = (k: string) => messages[k] ?? k;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#EDEBE9] px-3 py-2.5 text-xs text-[#616161]">
      <span>
        {formatNumber(first, language)}–{formatNumber(last, language)} / {formatNumber(total, language)}{" "}
        {t("table.records")}
      </span>
      <div className="flex items-center gap-2">
        <span>
          {t("table.page")} {page} {t("table.of")} {pages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("table.prev")}
          disabled={page <= 1 || pending}
          onClick={() => set("page", page - 1, { resetPage: false })}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("table.next")}
          disabled={page >= pages || pending}
          onClick={() => set("page", page + 1, { resetPage: false })}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
