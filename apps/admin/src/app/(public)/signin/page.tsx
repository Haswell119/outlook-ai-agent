import { redirect } from "next/navigation";
import { LogIn, ShieldAlert, TerminalSquare } from "lucide-react";
import { adminConfig, currentLanguage } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SignInButton } from "@/components/auth/signin-button";
import { getAdminSession } from "@/lib/session";
import { landingPath } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const cfg = adminConfig();
  const session = await getAdminSession();

  // Already signed in (or running in token mode): go straight to the dashboard.
  if (session && session.roles.length > 0 && !session.expired) {
    redirect(landingPath(session.roles));
  }

  const rawCallback = Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl;
  // Only same-origin, absolute-path callbacks — never an attacker-supplied URL.
  const callbackUrl = rawCallback && /^\/(?!\/)/.test(rawCallback) ? rawCallback : "/";
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{tr(messages, "auth.signInTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[#616161]">{tr(messages, "auth.signInSubtitle")}</p>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-[#C4314B]/30 bg-[#FDE7E9] p-3 text-xs text-[#C4314B]">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-semibold">{tr(messages, "auth.error")}</span>
              {tr(messages, "auth.errorHint")}
            </span>
          </div>
        )}

        {cfg.authMode === "aad" ? (
          <SignInButton callbackUrl={callbackUrl} label={tr(messages, "auth.signInWithMicrosoft")}>
            <LogIn className="h-4 w-4" aria-hidden="true" />
          </SignInButton>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-[#E1DFDD] bg-[#FAF9F8] p-3 text-xs text-[#424242]">
            <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-[#616161]" aria-hidden="true" />
            <span>
              <span className="block font-semibold">{tr(messages, "auth.tokenMode")}</span>
              {tr(messages, "auth.tokenModeHint")}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
