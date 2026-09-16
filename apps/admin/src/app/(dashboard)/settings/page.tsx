import Link from "next/link";
import { Building2, FileJson, Server, Settings } from "lucide-react";
import {
  adminConfig,
  currentLanguage,
  getFeatures,
  getHealth,
  getPolicy,
  isMockMode,
  organizationName,
} from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecheckButton } from "@/components/settings/recheck-button";
import { formatDateTime } from "@/lib/format";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = { ok: "low", degraded: "medium", down: "high" } as const;

export default async function SettingsPage() {
  await requireRoles("admin");
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const t = (k: string) => tr(messages, k);
  const cfg = adminConfig();

  const [features, health, mock, organisation, policy] = await Promise.all([
    getFeatures(),
    getHealth(),
    isMockMode(),
    organizationName(),
    getPolicy().catch(() => null),
  ]);

  const flagBadge = (on: boolean) => (
    <Badge variant={on ? "low" : "neutral"}>{on ? t("settings.enabled") : t("settings.disabled")}</Badge>
  );

  const rows: Array<[string, React.ReactNode]> = [
    [t("settings.llmProvider"), features.llmProvider],
    [t("settings.llmModel"), features.llmModel],
    [t("settings.fastModel"), features.llmFastModel ?? t("common.na")],
    [t("settings.embeddingModel"), features.embeddingModel ?? t("common.na")],
    [t("settings.graph"), flagBadge(features.graphEnabled)],
    [t("settings.embeddings"), flagBadge(features.embeddingsEnabled)],
    [t("settings.precompute"), flagBadge(features.precomputeEnabled)],
    [t("settings.dailyBrief"), flagBadge(features.dailyBriefEnabled)],
    [t("settings.authMode"), features.authMode],
    [t("settings.version"), features.version],
  ];

  return (
    <>
      <PageHeader
        icon={<Settings className="h-5 w-5" />}
        title={t("page.settings.title")}
        subtitle={t("page.settings.subtitle")}
        actions={
          <>
            <RecheckButton label={t("settings.recheck")} messages={messages} />
            <Button variant="outline" size="sm" asChild>
              <Link href="/system">
                <Server className="h-4 w-4" aria-hidden="true" />
                {t("settings.viewSystem")}
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Building2 className="h-4 w-4 text-brand" aria-hidden="true" />
            <CardTitle>{t("settings.organization")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="divide-y divide-[#EDEBE9]">
              <div className="flex items-start justify-between gap-3 py-2 text-sm">
                <dt className="text-[#616161]">{t("settings.orgName")}</dt>
                <dd className="text-right font-medium text-[#242424]">
                  {organisation}
                  <span className="block text-xs font-normal text-[#616161]">
                    {t("settings.orgSource")}
                  </span>
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3 py-2 text-sm">
                <dt className="text-[#616161]">{t("settings.internalDomains")}</dt>
                <dd className="min-w-0 text-right">
                  <span className="flex flex-wrap justify-end gap-1">
                    {(policy?.internalDomains ?? []).length === 0 ? (
                      <span className="text-[#A19F9D]">{t("common.none")}</span>
                    ) : (
                      policy?.internalDomains.map((d) => (
                        <Badge key={d} variant="outline">
                          {d}
                        </Badge>
                      ))
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-[#616161]">
                    {t("settings.internalDomainsHint")}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 text-sm">
                <dt className="text-[#616161]">{t("settings.timezone")}</dt>
                <dd className="font-medium text-[#242424]">{cfg.timeZone}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 text-sm">
                <dt className="text-[#616161]">{t("settings.language")}</dt>
                <dd className="font-medium uppercase text-[#242424]">{cfg.defaultLanguage}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t("settings.features")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-[#EDEBE9]">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <dt className="text-[#616161]">{label}</dt>
                  <dd className="font-medium text-[#242424]">{value}</dd>
                </div>
              ))}
            </dl>
            {mock && (
              <p className="mt-3 rounded-md bg-[#FFF4CE] px-3 py-2 text-xs text-[#8A6D00]">
                {t("top.mockHint")}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>{t("settings.health")}</CardTitle>
            <Badge variant={STATUS_VARIANT[health.status]}>{health.status}</Badge>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-[#EDEBE9]">
              {Object.entries(health.checks).map(([name, check]) => (
                <li key={name} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium capitalize text-[#242424]">{name}</span>
                    {check.detail && (
                      <span className="block text-xs text-[#616161]">{check.detail}</span>
                    )}
                  </span>
                  <Badge variant={STATUS_VARIANT[check.status]}>{check.status}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[#616161]">
              {t("footer.lastUpdated")}: {formatDateTime(health.timestamp, language, cfg.timeZone)} · v
              {health.version}
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <FileJson className="h-4 w-4 text-brand" aria-hidden="true" />
            <CardTitle>{t("settings.diagnostics")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[#616161]">{t("settings.diagnosticsHint")}</p>
            <Button variant="outline" size="sm" asChild>
              <a href="/api/diagnostics" download>
                <FileJson className="h-4 w-4" aria-hidden="true" />
                {t("settings.diagnosticsExport")}
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
