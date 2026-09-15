import { CheckSquare } from "lucide-react";
import { currentLanguage, getEscalations } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { MOCK_ESCALATION_DRAFTS } from "@/lib/mock-data";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EscalationCard } from "@/components/approvals/escalation-card";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  const escalations = await getEscalations();
  const pending = escalations.filter((e) => e.status === "pending");
  const decided = escalations.filter((e) => e.status !== "pending");

  const empty = (
    <Card>
      <CardContent className="py-10 text-center text-sm text-[#616161]">{t("approvals.empty")}</CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        icon={<CheckSquare className="h-5 w-5" />}
        title={t("page.approvals.title")}
        subtitle={t("page.approvals.subtitle")}
      />

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">
            {t("approvals.pending")}
            <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#C4314B] px-1 text-[10px] font-bold text-white">
              {pending.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="decided">
            {t("approvals.decided")}
            <span className="ml-1 text-xs text-[#616161]">{decided.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          {pending.length === 0 ? (
            empty
          ) : (
            <div className="grid gap-4 2xl:grid-cols-2">
              {pending.map((e) => (
                <EscalationCard
                  key={e.id}
                  escalation={e}
                  draft={MOCK_ESCALATION_DRAFTS[e.id]}
                  messages={messages}
                  language={language}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="decided">
          {decided.length === 0 ? (
            empty
          ) : (
            <div className="grid gap-4 2xl:grid-cols-2">
              {decided.map((e) => (
                <EscalationCard
                  key={e.id}
                  escalation={e}
                  draft={MOCK_ESCALATION_DRAFTS[e.id]}
                  messages={messages}
                  language={language}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
