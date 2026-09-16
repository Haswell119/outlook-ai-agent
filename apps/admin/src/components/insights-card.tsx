import Link from "next/link";
import { ArrowRight, TrendingUp } from "lucide-react";
import type { AuditStats, Language } from "@oao/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatNumber } from "@/lib/format";

export function InsightsCard({
  stats,
  messages,
  language,
}: {
  stats: AuditStats;
  messages: Record<string, string>;
  language: Language;
}) {
  const t = (k: string) => messages[k] ?? k;
  const { current, previous } = stats.automationsApprovalRate;
  const max = Math.max(1, ...stats.topUsers.map((u) => u.actions));

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <TrendingUp className="h-4 w-4 text-brand" />
        <CardTitle>{t("insights.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-[#616161]">{t("insights.approvalRate")}</p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-[#242424]">{Math.round(current)}%</span>
            <span className="text-xs text-[#107C10]">
              {(t("insights.lastWeek") ?? "").replace("{value}", `${Math.round(previous)}%`)}
            </span>
          </p>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#EDEBE9]">
            <div className="h-full rounded-full bg-[#107C10]" style={{ width: `${Math.min(100, current)}%` }} />
          </div>
        </div>

        <Separator />

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#616161]">
            {t("insights.topUsers")}
          </p>
          <ol className="space-y-2">
            {stats.topUsers.slice(0, 5).map((u, i) => (
              <li key={u.userId}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F0F0F0] text-[10px] font-bold text-[#424242]">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-[#242424]">{u.displayName}</span>
                  <span className="shrink-0 tabular-nums text-[#616161]">
                    {formatNumber(u.actions, language)}
                  </span>
                </div>
                <div className="ml-7 mt-1 h-1 overflow-hidden rounded-full bg-[#EDEBE9]">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${(u.actions / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ol>
        </div>

        <Link
          href="/analytics?tab=usage"
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
        >
          {t("insights.viewAnalytics")} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}
