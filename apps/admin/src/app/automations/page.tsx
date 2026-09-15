import { Wand2 } from "lucide-react";
import { currentLanguage, getAutomations } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { AutomationsView } from "@/components/automations/automations-view";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const automations = await getAutomations();
  const minutes = automations
    .filter((a) => a.status === "active" || a.status === "approved")
    .reduce((acc, a) => acc + a.stats.estimatedMinutesSavedPerWeek, 0);

  return (
    <>
      <PageHeader
        icon={<Wand2 className="h-5 w-5" />}
        title={t("page.automations.title")}
        subtitle={t("page.automations.subtitle")}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {[
          { label: t("automations.total"), value: formatNumber(automations.length, language) },
          {
            label: t("automations.active"),
            value: formatNumber(automations.filter((a) => a.status === "active").length, language),
          },
          { label: t("automations.minutesSaved"), value: formatNumber(minutes, language) },
        ].map((tile) => (
          <Card key={tile.label}>
            <CardContent className="pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#616161]">{tile.label}</p>
              <p className="mt-1 text-xl font-semibold text-[#242424]">{tile.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <AutomationsView automations={automations} messages={messages} language={language} />
    </>
  );
}
