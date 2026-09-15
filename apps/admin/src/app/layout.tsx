import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/topbar";
import { AppFooter } from "@/components/layout/footer";
import { adminConfig, currentLanguage, getEscalations, isMockMode } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = {
  title: "Outlook AI Orchestrator — Admin",
  description: "Audit & supervision dashboard for the Outlook AI Orchestrator.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cfg = adminConfig();
  const language = await currentLanguage();
  const mock = await isMockMode();
  const messages = dictionaries[language] as unknown as Record<string, string>;

  let pendingApprovals = 0;
  try {
    pendingApprovals = (await getEscalations()).filter((e) => e.status === "pending").length;
  } catch {
    pendingApprovals = 0;
  }

  return (
    <html lang={language}>
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <Suspense fallback={<div className="h-screen w-[248px] shrink-0 bg-navy" />}>
            <Sidebar messages={messages} />
          </Suspense>
          <div className="flex min-w-0 flex-1 flex-col bg-[#F5F5F5]">
            <TopBar
              tenantName={cfg.tenantName}
              language={language}
              mock={mock}
              pendingApprovals={pendingApprovals}
              messages={messages}
            />
            <main className="min-w-0 flex-1 px-4 py-5 lg:px-6">
              {children}
              <AppFooter
                tenantName={cfg.tenantName}
                lastUpdated={formatDateTime(new Date().toISOString(), language)}
                messages={messages}
              />
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
