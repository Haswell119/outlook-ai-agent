import { Suspense } from "react";
import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import { currentLanguage, getAuditPage, getAuditStats } from "@/lib/api";
import { buildFilterOptions } from "@/lib/filter-options";
import { dictionaries } from "@/lib/i18n";
import { resolveQuery, toDay, type SearchParamsInput } from "@/lib/query";
import { formatDateRange, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiRow } from "@/components/kpi-row";
import { InsightsCard } from "@/components/insights-card";
import { ActivityChart } from "@/components/charts/activity-chart";
import { DonutChart } from "@/components/charts/donut-chart";
import { ACTION_COLORS, ALERT_COLORS } from "@/components/charts/palette";
import { AuditTable } from "@/components/audit/audit-table";
import { Pagination } from "@/components/audit/pagination";
import { DateRangeControl } from "@/components/audit/date-range-control";
import { FiltersSheet, AuditFilterFields } from "@/components/audit/filters";
import { ExportButton } from "@/components/audit/export-button";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const params = await searchParams;
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const query = resolveQuery(params);
  const [stats, page, filterOptions] = await Promise.all([
    getAuditStats({ from: query.from, to: query.to }),
    getAuditPage(query),
    buildFilterOptions(language),
  ]);

  const rangeLabel =
    query.preset === "custom"
      ? formatDateRange(query.from, query.to, language)
      : `${formatDateRange(query.from, query.to, language)}`;

  const actionsData = stats.actionsByType.map((a) => ({ name: a.type, value: a.count, share: a.share }));
  const alertsData = stats.complianceAlertsByCategory.map((c) => ({
    name: c.category,
    value: c.count,
    share: c.share,
  }));

  return (
    <>
      <PageHeader
        icon={<ShieldCheck className="h-5 w-5" />}
        title={t("page.overview.title")}
        subtitle={t("page.overview.subtitle")}
        actions={
          <Suspense fallback={null}>
            <DateRangeControl
              label={rangeLabel}
              preset={query.preset}
              from={toDay(query.from)}
              to={toDay(query.to)}
              messages={messages}
            />
            <FiltersSheet options={filterOptions} messages={messages} />
            <ExportButton label={t("action.export")} />
          </Suspense>
        }
      />

      <KpiRow stats={stats} messages={messages} language={language} />

      <div className="mb-4 grid gap-4 xl:grid-cols-12">
        <Card className="min-w-0 xl:col-span-8">
          <CardHeader>
            <CardTitle>{t("chart.activity")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityChart
              data={stats.activityOverTime}
              language={language}
              labels={{
                summaries: t("chart.summaries"),
                drafts: t("chart.drafts"),
                automations: t("chart.automations"),
                complianceAlerts: t("chart.complianceAlerts"),
              }}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0 xl:col-span-4">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <SlidersHorizontal className="h-4 w-4 text-brand" />
            <CardTitle>{t("filters.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={null}>
              <AuditFilterFields
                options={filterOptions}
                messages={messages}
                className="grid gap-3 sm:grid-cols-2"
              />
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t("chart.actionsByType")}</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart
              data={actionsData}
              colors={ACTION_COLORS}
              centerValue={stats.totalActions}
              centerLabel={t("chart.totalActions")}
              language={language}
            />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t("chart.alertsByCategory")}</CardTitle>
          </CardHeader>
          <CardContent>
            <DonutChart
              data={alertsData}
              colors={ALERT_COLORS}
              centerValue={stats.kpis.complianceAlerts}
              centerLabel={t("kpi.complianceAlerts")}
              language={language}
            />
          </CardContent>
        </Card>

        <InsightsCard stats={stats} messages={messages} language={language} />
      </div>

      <Card className="min-w-0">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>
            {t("page.audit.title")}
            <span className="ml-2 font-normal text-[#616161]">
              {formatNumber(page.total, language)} {t("table.records")}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <AuditTable events={page.items} messages={messages} language={language} />
          <Suspense fallback={null}>
            <Pagination
              page={page.page}
              pageSize={page.pageSize}
              total={page.total}
              messages={messages}
              language={language}
            />
          </Suspense>
        </CardContent>
      </Card>

    </>
  );
}
