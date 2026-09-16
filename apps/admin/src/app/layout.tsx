import type { Metadata, Viewport } from "next";
import "./globals.css";
import { adminConfig, currentLanguage } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = {
  title: "Outlook AI Orchestrator — Admin",
  description: "Audit & supervision dashboard for the Outlook AI Orchestrator.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export const dynamic = "force-dynamic";

/**
 * Root shell. The dashboard chrome (sidebar, top bar, footer) lives in the
 * `(dashboard)` route group so that `/signin` and `/no-access` can render
 * without it.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const language = await currentLanguage();
  const cfg = adminConfig();
  const messages = dictionaries[language] as unknown as Messages;

  return (
    <html lang={language} data-timezone={cfg.timeZone}>
      <body className="min-h-screen">
        <ToastProvider
          labels={{
            retry: tr(messages, "toast.retry"),
            dismiss: tr(messages, "toast.dismiss"),
            correlationId: tr(messages, "error.correlationId"),
          }}
        >
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
