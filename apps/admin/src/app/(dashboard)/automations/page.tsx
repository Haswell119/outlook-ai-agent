import { Suspense } from "react";
import { Wand2 } from "lucide-react";
import { adminConfig, currentLanguage, getAutomations, getUsers } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { AutomationsView } from "@/components/automations/automations-view";
import { OwnerFilter } from "@/components/automations/owner-filter";
import { Card, CardContent } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { SearchParamsInput } from "@/lib/query";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const session = await requireRoles("admin");
  const params = await searchParams;
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const t = (k: string) => tr(messages, k);
  const cfg = adminConfig();

  const rawUser = Array.isArray(params.user) ? params.user[0] : params.user;
  const all = (Array.isArray(params.all) ? params.all[0] : params.all) === "true" || !rawUser;

  const [automations, users] = await Promise.all([
    // Admins may look at every user's routines (`?all=true`); a filter narrows
    // the list to one owner.
    getAutomations(all ? { all: true } : { userId: rawUser }),
    getUsers().catch(() => []),
  ]);

  const minutes = automations
    .filter((a) => a.status === "active" || a.status === "approved")
    .reduce((acc, a) => acc + a.stats.estimatedMinutesSavedPerWeek, 0);

  return (
    <>
      <PageHeader
        icon={<Wand2 className="h-5 w-5" />}
        title={t("page.automations.title")}
        subtitle={t("page.automations.subtitle")}
        actions={
          <Suspense fallback={null}>
            <OwnerFilter
              users={users.map((u) => ({ value: u.id, label: u.displayName ?? u.email }))}
              messages={messages}
            />
          </Suspense>
        }
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
              <p className="text-xs font-semibold uppercase tracking-wide text-[#616161]">
                {tile.label}
              </p>
              <p className="mt-1 text-xl font-semibold text-[#242424]">{tile.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <AutomationsView
        automations={automations}
        messages={messages}
        language={language}
        timeZone={cfg.timeZone}
        viewerEmail={session.email}
      />
    </>
  );
}
