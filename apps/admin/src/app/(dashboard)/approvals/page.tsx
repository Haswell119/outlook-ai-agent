import { CheckSquare } from "lucide-react";
import { adminConfig, currentLanguage, getEscalations } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EscalationCard } from "@/components/approvals/escalation-card";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  await requireRoles("admin", "compliance");
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const t = (k: string) => tr(messages, k);
  const cfg = adminConfig();

  const escalations = await getEscalations();
  const pending = escalations.filter((e) => e.status === "pending");
  const decided = escalations.filter((e) => e.status !== "pending");

  const empty = (
    <Card>
      <CardContent className="py-10 text-center text-sm text-[#616161]">
        {t("approvals.empty")}
      </CardContent>
    </Card>
  );

  const list = (items: typeof escalations) => (
    <div className="grid gap-4 2xl:grid-cols-2">
      {items.map((e) => (
        <EscalationCard
          key={e.id}
          escalation={e}
          messages={messages}
          language={language}
          timeZone={cfg.timeZone}
        />
      ))}
    </div>
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
            <span
              className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#C4314B] px-1 text-[10px] font-bold text-white"
              data-testid="pending-count"
            >
              {pending.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="decided">
            {t("approvals.decided")}
            <span className="ml-1 text-xs text-[#616161]">{decided.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending">{pending.length === 0 ? empty : list(pending)}</TabsContent>
        <TabsContent value="decided">{decided.length === 0 ? empty : list(decided)}</TabsContent>
      </Tabs>
    </>
  );
}
