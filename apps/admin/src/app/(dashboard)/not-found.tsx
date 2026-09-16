import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { currentLanguage } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default async function DashboardNotFound() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E8F1FB] text-brand">
          <FileQuestion className="h-5 w-5" aria-hidden="true" />
        </span>
        <CardTitle className="text-base">{tr(messages, "error.notFoundTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[#424242]">{tr(messages, "error.notFoundBody")}</p>
        <Button asChild variant="outline">
          <Link href="/">{tr(messages, "error.backHome")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
