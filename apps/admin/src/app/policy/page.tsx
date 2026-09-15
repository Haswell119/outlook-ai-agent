import { BookLock } from "lucide-react";
import { currentLanguage, getPolicy } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { PolicyForm } from "@/components/policy/policy-form";

export const dynamic = "force-dynamic";

export default async function PolicyPage() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const policy = await getPolicy();

  return (
    <>
      <PageHeader
        icon={<BookLock className="h-5 w-5" />}
        title={messages["page.policy.title"] ?? "Policy Center"}
        subtitle={messages["page.policy.subtitle"]}
      />
      <PolicyForm policy={policy} messages={messages} language={language} />
    </>
  );
}
