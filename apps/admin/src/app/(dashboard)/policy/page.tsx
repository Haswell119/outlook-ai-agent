import { BookLock } from "lucide-react";
import { adminConfig, currentLanguage, getPolicy } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { PolicyForm } from "@/components/policy/policy-form";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PolicyPage() {
  await requireRoles("admin");
  const language = await currentLanguage();
  const cfg = adminConfig();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const policy = await getPolicy();

  return (
    <>
      <PageHeader
        icon={<BookLock className="h-5 w-5" />}
        title={messages["page.policy.title"] ?? "Policy Center"}
        subtitle={messages["page.policy.subtitle"]}
      />
      <PolicyForm policy={policy} messages={messages} language={language} timeZone={cfg.timeZone} />
    </>
  );
}
