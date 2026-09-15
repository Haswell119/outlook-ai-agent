import { Suspense } from "react";
import { Clock, ShieldCheck, TrendingUp } from "lucide-react";
import type { AuditEvent } from "@oao/shared";
import { currentLanguage, getAuditEventsForExport, getAuditStats, getAutomations } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { resolveQuery, toDay, type SearchParamsInput } from "@/lib/query";
import { formatDateRange, formatDateShort, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnalyticsTabs, type AnalyticsTab } from "@/components/analytics/analytics-tabs";
import { ActivityChart } from "@/components/charts/activity-chart";
import { SimpleBarChart } from "@/components/charts/bar-chart";
import { DonutChart } from "@/components/charts/donut-chart";
import { ACTION_COLORS } from "@/components/charts/palette";
import { DateRangeControl } from "@/components/audit/date-range-control";
import { eventMeta } from "@/components/audit/event-icon";

export const dynamic = "force-dynamic";

/** Estimated minutes saved per generated summary (dossier assumption). */
const MINUTES_PER_SUMMARY = 3;

function averagesByType(events: AuditEvent[]) {
  const acc = new Map<string, { latency: number; confidence: number; nLatency: number; nConf: number }>();
  for (const e of events) {
    const key = eventMeta(e.type).label;
    const row = acc.get(key) ?? { latency: 0, confidence: 0, nLatency: 0, nConf: 0 };
    if (typeof e.latencyMs === "number") {
      row.latency += e.latencyMs;
      row.nLatency += 1;
    }
    if (typeof e.confidence === "number") {
      row.confidence += e.confidence;
      row.nConf += 1;
    }
    acc.set(key, row);
  }
  const latency = [...acc.entries()]
    .filter(([, r]) => r.nLatency > 0)
    .map(([name, r]) => ({ name, value: Math.round(r.latency / r.nLatency) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  const confidence = [...acc.entries()]
    .filter(([, r]) => r.nConf > 0)
    .map(([name, r]) => ({ name, value: Math.round((r.confidence / r.nConf) * 100) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  return { latency, confidence };
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const params = await searchParams;
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const query = resolveQuery(params);
  const tabRaw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const active: AnalyticsTab =
    tabRaw === "performance" || tabRaw === "impact" ? tabRaw : "usage";

  const [stats, events, automations] = await Promise.all([
    getAuditStats({ from: query.from, to: query.to }),
    getAuditEventsForExport(query),
    getAutomations(),
  ]);

  const { latency, confidence } = averagesByType(events);
  const byUser = stats.topUsers.map((u) => ({ name: u.displayName, value: u.actions }));
  const byDay = stats.activityOverTime.map((d) => ({
    name: formatDateShort(`${d.date}T00:00:00Z`, language),
    value: d.summaries + d.drafts + d.automations + d.complianceAlerts,
  }));

  const automationMinutes = automations
    .filter((a) => a.status === "active" || a.status === "approved")
    .reduce((acc, a) => acc + a.stats.estimatedMinutesSavedPerWeek, 0);
  const summaryMinutes = stats.kpis.emailsSummarized * MINUTES_PER_SUMMARY;
  const totalHours = Math.round((automationMinutes + summaryMinutes) / 60);

  const usage = (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("analytics.byUser")}</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleBarChart data={byUser} layout="vertical" height={260} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("analytics.byDay")}</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleBarChart data={byDay} layout="horizontal" height={260} color="#2E9E6B" />
        </CardContent>
      </Card>
      <Card className="xl:col-span-2">
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
    </div>
  );

  const performance = (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("analytics.latencyByType")}</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleBarChart data={latency} layout="vertical" height={320} color="#0F6CBD" unit=" ms" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("analytics.confidenceByType")}</CardTitle>
        </CardHeader>
        <CardContent>
          <SimpleBarChart data={confidence} layout="vertical" height={320} color="#6B44C9" unit=" %" />
        </CardContent>
      </Card>
    </div>
  );

  const impact = (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card>
        <CardContent className="pt-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#616161]">
            <Clock className="h-4 w-4 text-brand" /> {t("analytics.timeSaved")}
          </p>
          <p className="mt-2 text-2xl font-semibold text-[#242424]">
            {formatNumber(totalHours, language)}{" "}
            <span className="text-sm font-normal text-[#616161]">{t("analytics.hoursPerWeek")}</span>
          </p>
          <p className="mt-2 text-xs text-[#616161]">
            {formatNumber(stats.kpis.emailsSummarized, language)} × {MINUTES_PER_SUMMARY} min +{" "}
            {formatNumber(automationMinutes, language)} min (automations)
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#616161]">
            <ShieldCheck className="h-4 w-4 text-[#107C10]" /> {t("analytics.errorsAvoided")}
          </p>
          <p className="mt-2 text-2xl font-semibold text-[#242424]">
            {formatNumber(stats.kpis.errorsAvoided, language)}
          </p>
          <p className="mt-2 text-xs text-[#616161]">
            {formatNumber(stats.kpis.complianceAlerts, language)} {t("kpi.complianceAlerts").toLowerCase()}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#616161]">
            <TrendingUp className="h-4 w-4 text-[#6B44C9]" /> {t("insights.approvalRate")}
          </p>
          <p className="mt-2 text-2xl font-semibold text-[#242424]">
            {Math.round(stats.automationsApprovalRate.current)}%
          </p>
          <p className="mt-2 text-xs text-[#616161]">
            {t("insights.lastWeek").replace("{value}", `${Math.round(stats.automationsApprovalRate.previous)}%`)}
          </p>
        </CardContent>
      </Card>
      <Card className="xl:col-span-3">
        <CardHeader>
          <CardTitle>{t("chart.actionsByType")}</CardTitle>
        </CardHeader>
        <CardContent>
          <DonutChart
            data={stats.actionsByType.map((a) => ({ name: a.type, value: a.count, share: a.share }))}
            colors={ACTION_COLORS}
            centerValue={stats.totalActions}
            centerLabel={t("chart.totalActions")}
            language={language}
          />
        </CardContent>
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        icon={<TrendingUp className="h-5 w-5" />}
        title={t("page.analytics.title")}
        subtitle={t("page.analytics.subtitle")}
        actions={
          <Suspense fallback={null}>
            <DateRangeControl
              label={formatDateRange(query.from, query.to, language)}
              preset={query.preset}
              from={toDay(query.from)}
              to={toDay(query.to)}
              messages={messages}
            />
          </Suspense>
        }
      />
      <Suspense fallback={null}>
        <AnalyticsTabs
          active={active}
          labels={{
            usage: t("analytics.usage"),
            performance: t("analytics.performance"),
            impact: t("analytics.impact"),
          }}
          usage={usage}
          performance={performance}
          impact={impact}
        />
      </Suspense>
    </>
  );
}
