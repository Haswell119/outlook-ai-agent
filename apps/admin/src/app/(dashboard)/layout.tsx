import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { AppFooter } from "@/components/layout/footer";
import {
  adminConfig,
  currentLanguage,
  getPendingEscalationCount,
  isMockMode,
  organizationName,
} from "@/lib/api";
import { dictionaries, type Messages } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";
import { getAdminSession } from "@/lib/session";
import { landingPath, primaryRole } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  // The middleware already redirected; this is the defence-in-depth re-check.
  if (!session) redirect("/signin");
  if (primaryRole(session.roles) === "user") redirect(landingPath(session.roles));

  const cfg = adminConfig();
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const [mock, organisation, pendingApprovals] = await Promise.all([
    isMockMode(),
    organizationName(),
    getPendingEscalationCount(),
  ]);

  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only left-2 top-2 z-50 rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white focus:not-sr-only focus:absolute"
      >
        {messages["common.skipToContent"]}
      </a>
      <Suspense fallback={<div className="h-screen w-[248px] shrink-0 bg-navy" />}>
        <Sidebar messages={messages} roles={session.roles} pendingApprovals={pendingApprovals} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col bg-[#F5F5F5]">
        <TopBar
          organisation={organisation}
          language={language}
          mock={mock}
          pendingApprovals={pendingApprovals}
          messages={messages}
          user={{ email: session.email, name: session.name, roles: session.roles }}
          authMode={session.mode}
          sessionExpired={session.expired}
        />
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-5 lg:px-6">
          {children}
          <AppFooter
            organisation={organisation}
            lastUpdated={formatDateTime(new Date().toISOString(), language, cfg.timeZone)}
            timeZone={cfg.timeZone}
            messages={messages}
          />
        </main>
      </div>
    </div>
  );
}
