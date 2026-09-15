import { Settings } from "lucide-react";
import { currentLanguage, getFeatures, getHealth, isMockMode } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecheckButton } from "@/components/settings/recheck-button";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS_VARIANT = { ok: "low", degraded: "medium", down: "high" } as const;

export default async function SettingsPage() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const [features, health, mock] = await Promise.all([getFeatures(), getHealth(), isMockMode()]);

  const rows: Array<[string, React.ReactNode]> = [
    [t("settings.llmProvider"), features.llmProvider],
    [t("settings.llmModel"), features.llmModel],
    [
      t("settings.graph"),
      <Badge key="g" variant={features.graphEnabled ? "low" : "neutral"}>
        {features.graphEnabled ? t("settings.enabled") : t("settings.disabled")}
      </Badge>,
    ],
    [
      t("settings.embeddings"),
      <Badge key="e" variant={features.embeddingsEnabled ? "low" : "neutral"}>
        {features.embeddingsEnabled ? t("settings.enabled") : t("settings.disabled")}
      </Badge>,
    ],
    [t("settings.authMode"), features.authMode],
    [t("settings.version"), features.version],
  ];

  return (
    <>
      <PageHeader
        icon={<Settings className="h-5 w-5" />}
        title={t("page.settings.title")}
        subtitle={t("page.settings.subtitle")}
        actions={<RecheckButton label={t("settings.recheck")} />}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
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

        <Card>
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
                    {check.detail && <span className="block text-xs text-[#616161]">{check.detail}</span>}
                  </span>
                  <Badge variant={STATUS_VARIANT[check.status]}>{check.status}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[#616161]">
              {t("footer.lastUpdated")}: {formatDateTime(health.timestamp, language)} · v{health.version}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
