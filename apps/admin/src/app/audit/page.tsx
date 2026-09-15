import { Suspense } from "react";
import { Shield } from "lucide-react";
import { currentLanguage, getAuditPage } from "@/lib/api";
import { buildFilterOptions } from "@/lib/filter-options";
import { dictionaries } from "@/lib/i18n";
import { resolveQuery, toDay, type SearchParamsInput } from "@/lib/query";
import { formatDateRange, formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuditTable } from "@/components/audit/audit-table";
import { AuditToolbar } from "@/components/audit/audit-toolbar";
import { Pagination } from "@/components/audit/pagination";
import { DateRangeControl } from "@/components/audit/date-range-control";
import { ExportButton } from "@/components/audit/export-button";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const params = await searchParams;
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const query = resolveQuery(params);
  const [page, filterOptions] = await Promise.all([getAuditPage(query), buildFilterOptions(language)]);

  return (
    <>
      <PageHeader
        icon={<Shield className="h-5 w-5" />}
        title={t("page.audit.title")}
        subtitle={t("page.audit.subtitle")}
        actions={
          <Suspense fallback={null}>
            <DateRangeControl
              label={formatDateRange(query.from, query.to, language)}
              preset={query.preset}
              from={toDay(query.from)}
              to={toDay(query.to)}
              messages={messages}
            />
            <ExportButton label={t("action.exportCsv")} />
          </Suspense>
        }
      />

      <Card className="mb-4">
        <CardContent className="pt-4">
          <Suspense fallback={null}>
            <AuditToolbar options={filterOptions} messages={messages} />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {formatNumber(page.total, language)} {t("table.records")}
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
