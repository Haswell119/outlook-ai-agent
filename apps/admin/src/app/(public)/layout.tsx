import { ShieldCheck } from "lucide-react";
import { currentLanguage } from "@/lib/api";
import { dictionaries, type Messages } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** Bare shell for the pages reachable without a dashboard role. */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;

  return (
    <div className="flex min-h-screen flex-col bg-[#F5F5F5]">
      <header className="flex items-center gap-2.5 bg-navy px-4 py-3.5 text-white lg:px-6">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold leading-tight">
          {messages["app.name"]}
          <span className="block text-xs font-normal text-navy-300">{messages["app.tagline"]}</span>
        </span>
      </header>
      <main id="main-content" className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}
