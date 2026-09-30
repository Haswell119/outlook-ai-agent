import { Database, Mail, Plug, Server, Webhook } from "lucide-react";
import { currentLanguage, dataMode, getFeatures, getUsers } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { requireRoles } from "@/lib/session";
import { MailImport } from "@/components/integrations/mail-import";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const session = await requireRoles("admin");
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;
  const features = await getFeatures();
  const live = (await dataMode()) === "live";
  // Mailboxes the add-in has been used with (audit trail), most recent first;
  // the shared admin token is not a mailbox.
  const knownMailboxes = Array.from(
    new Set(
      (await getUsers().catch(() => []))
        .filter((u) => u.id !== "admin-dashboard" && u.email.includes("@"))
        .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
        .map((u) => u.email.toLowerCase()),
    ),
  );

  const integrations = [
    {
      icon: <Mail className="h-4 w-4" />,
      name: "Outlook add-in (Office.js)",
      detail:
        "Default data path: the add-in reads the opened item and posts it to the orchestrator. No Graph permission needed.",
      status: { label: t("settings.enabled"), variant: "low" as const },
    },
    {
      icon: <Server className="h-4 w-4" />,
      name: `Internal LLM — ${features.llmModel}`,
      detail: `OpenAI-compatible endpoint, provider "${features.llmProvider}". Switching model = changing environment variables.`,
      status: { label: t("settings.enabled"), variant: "low" as const },
    },
    {
      icon: <Plug className="h-4 w-4" />,
      name: "Microsoft Graph (On-Behalf-Of)",
      detail:
        "Optional. When enabled, the orchestrator can fetch whole conversations, index the mailbox and run server-side actions.",
      status: features.graphEnabled
        ? { label: t("settings.enabled"), variant: "low" as const }
        : { label: t("settings.disabled"), variant: "neutral" as const },
    },
    {
      icon: <Database className="h-4 w-4" />,
      name: "PostgreSQL + pgvector",
      detail: "Audit events, email index, escalations, automations and policies.",
      status: { label: t("settings.enabled"), variant: "low" as const },
    },
    {
      icon: <Database className="h-4 w-4" />,
      name: `Embeddings${features.embeddingsEnabled ? "" : " (off)"}`,
      detail: "Served on the same OpenAI-compatible endpoint (/v1/embeddings) for conversational search.",
      status: features.embeddingsEnabled
        ? { label: t("settings.enabled"), variant: "low" as const }
        : { label: t("settings.disabled"), variant: "neutral" as const },
    },
    {
      icon: <Webhook className="h-4 w-4" />,
      name: "Notification webhook",
      detail: "Optional NOTIFY_WEBHOOK_URL, called by the `notify` action.",
      status: { label: "Optional", variant: "neutral" as const },
    },
  ];

  return (
    <>
      <PageHeader
        icon={<Plug className="h-5 w-5" />}
        title={t("page.integrations.title")}
        subtitle={t("page.integrations.subtitle")}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        {integrations.map((i) => (
          <Card key={i.name}>
            <CardContent className="flex items-start gap-3 pt-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#E8F1FB] text-brand">
                {i.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[#242424]">{i.name}</span>
                  <Badge variant={i.status.variant}>{i.status.label}</Badge>
                </span>
                <span className="mt-0.5 block text-xs text-[#616161]">{i.detail}</span>
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mt-4">
        <MailImport
          messages={messages}
          language={language}
          defaultMailbox={
            // The signed-in operator's own mailbox when the add-in knows it, else the most recent one.
            knownMailboxes.includes(session.email.toLowerCase()) ? session.email.toLowerCase() : (knownMailboxes[0] ?? session.email)
          }
          knownMailboxes={knownMailboxes}
          live={live}
        />
      </div>
    </>
  );
}
