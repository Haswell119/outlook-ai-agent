import { Suspense } from "react";
import { AlertTriangle } from "lucide-react";
import type { AuditEvent } from "@oao/shared";
import { adminConfig, alertCategory, currentLanguage, getComplianceAlerts } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { resolveQuery, toDay, type SearchParamsInput } from "@/lib/query";
import { formatDateRange, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditTable } from "@/components/audit/audit-table";
import { DateRangeControl } from "@/components/audit/date-range-control";
import { SeverityFilter } from "@/components/alerts/severity-filter";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  await requireRoles("admin", "compliance");
  const params = await searchParams;
  const language = await currentLanguage();
  const cfg = adminConfig();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const query = resolveQuery(params);
  const alerts = await getComplianceAlerts(query);

  const groups = new Map<string, AuditEvent[]>();
  for (const event of alerts) {
    const key = alertCategory(event);
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <>
      <PageHeader
        icon={<AlertTriangle className="h-5 w-5" />}
        title={t("page.alerts.title")}
        subtitle={t("page.alerts.subtitle")}
        actions={
          <Suspense fallback={null}>
            <DateRangeControl
              label={formatDateRange(query.from, query.to, language, cfg.timeZone)}
              preset={query.preset}
              from={toDay(query.from)}
              to={toDay(query.to)}
              messages={messages}
            />
          </Suspense>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-4 pt-4">
          <Suspense fallback={null}>
            <SeverityFilter messages={messages} />
          </Suspense>
          <p className="pb-1.5 text-sm text-[#616161]">
            {formatNumber(alerts.length, language)} {t("table.records")} · {t("alerts.grouped")}
          </p>
        </CardContent>
      </Card>

      {ordered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-[#616161]">{t("alerts.empty")}</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {ordered.map(([category, events]) => {
            const high = events.filter((e) => e.riskLevel === "high").length;
            return (
              <Card key={category} className="min-w-0">
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <CardTitle className="flex items-center gap-2">
                    {category}
                    <Badge variant="neutral">{events.length}</Badge>
                    {high > 0 && <Badge variant="high">{high} {t("risk.high")}</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <AuditTable
                    events={events.slice(0, 25)}
                    messages={messages}
                    language={language}
                    timeZone={cfg.timeZone}
                    caption={category}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
