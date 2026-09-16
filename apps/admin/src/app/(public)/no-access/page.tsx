import { ShieldOff } from "lucide-react";
import { currentLanguage, organizationName } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SignOutButton } from "@/components/auth/signout-button";
import { getAdminSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Friendly landing page for an authenticated user without a dashboard role. */
export default async function NoAccessPage() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const [session, organisation] = await Promise.all([getAdminSession(), organizationName()]);

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#FFF4CE] text-[#8A6D00]">
          <ShieldOff className="h-5 w-5" aria-hidden="true" />
        </span>
        <CardTitle className="text-base">{tr(messages, "auth.noAccessTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[#424242]">{tr(messages, "auth.noAccessBody")}</p>
        <p className="text-sm text-[#616161]">{tr(messages, "auth.noAccessContact")}</p>
        {session && (
          <p className="rounded-md bg-[#FAF9F8] px-3 py-2 text-xs text-[#616161]">
            {tr(messages, "auth.signedInAs")}{" "}
            <span className="font-medium text-[#242424]">{session.email}</span> · {organisation}
          </p>
        )}
        {session?.mode === "aad" && <SignOutButton label={tr(messages, "auth.signOut")} />}
      </CardContent>
    </Card>
  );
}
