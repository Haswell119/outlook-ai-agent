import { Server } from "lucide-react";
import { Routes } from "@oao/shared";
import { adminConfig, currentLanguage, getSystemStatus } from "@/lib/api";
import { dictionaries, type Messages } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { SystemView } from "@/components/system/system-view";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SystemPage() {
  await requireRoles("admin");
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const cfg = adminConfig();
  const status = await getSystemStatus();

  return (
    <>
      <PageHeader
        icon={<Server className="h-5 w-5" />}
        title={messages["page.system.title"] ?? "System status"}
        subtitle={messages["page.system.subtitle"]}
      />
      <SystemView
        initial={status}
        messages={messages}
        language={language}
        timeZone={cfg.timeZone}
        metricsPath={Routes.metrics}
        probePaths={{ live: Routes.live, ready: Routes.ready }}
      />
    </>
  );
}
