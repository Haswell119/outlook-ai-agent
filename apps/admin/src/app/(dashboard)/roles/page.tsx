import { Check, KeyRound, Minus } from "lucide-react";
import { currentLanguage } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { requireRoles } from "@/lib/session";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

type Role = "user" | "compliance" | "admin";

const PERMISSIONS: Array<{ permission: string; roles: Role[] }> = [
  { permission: "Read own mailbox summaries, drafts and chat", roles: ["user", "compliance", "admin"] },
  { permission: "Approve AI-proposed actions on own items", roles: ["user", "compliance", "admin"] },
  { permission: "Run a pre-send compliance check", roles: ["user", "compliance", "admin"] },
  { permission: "Request a compliance escalation", roles: ["user", "compliance", "admin"] },
  { permission: "Decide a compliance escalation (approve / reject)", roles: ["compliance", "admin"] },
  { permission: "See the whole organisation's audit trail", roles: ["compliance", "admin"] },
  { permission: "Export the audit log (CSV)", roles: ["compliance", "admin"] },
  { permission: "Approve, pause or reject an automation", roles: ["admin"] },
  { permission: "Edit the compliance policy", roles: ["admin"] },
  { permission: "Manage users and roles", roles: ["admin"] },
  { permission: "Read feature flags and health", roles: ["admin"] },
  { permission: "Send an email on a user's behalf", roles: [] },
  { permission: "Delete an email", roles: [] },
];

const ROLES: Role[] = ["user", "compliance", "admin"];

export default async function RolesPage() {
  await requireRoles("admin");
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;

  return (
    <>
      <PageHeader
        icon={<KeyRound className="h-5 w-5" />}
        title={t("page.roles.title")}
        subtitle={t("page.roles.subtitle")}
      />
      <Card className="min-w-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-[320px]">Permission</TableHead>
                {ROLES.map((r) => (
                  <TableHead key={r} className="w-32 text-center capitalize">
                    {r}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PERMISSIONS.map((row) => (
                <TableRow key={row.permission}>
                  <TableCell className="text-sm">{row.permission}</TableCell>
                  {ROLES.map((role) => (
                    <TableCell key={role} className="text-center">
                      {row.roles.includes(role) ? (
                        <Check className="mx-auto h-4 w-4 text-[#107C10]" aria-label="allowed" />
                      ) : (
                        <Minus className="mx-auto h-4 w-4 text-[#C8C6C4]" aria-label="not allowed" />
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="mt-3 text-xs text-[#616161]">
        Roles come from Azure AD app roles / groups in production, or from the{" "}
        <code className="rounded bg-[#F0F0F0] px-1">ADMIN_EMAILS</code> /{" "}
        <code className="rounded bg-[#F0F0F0] px-1">COMPLIANCE_EMAILS</code> environment variables when{" "}
        <code className="rounded bg-[#F0F0F0] px-1">AUTH_MODE=dev</code>. Sending and deleting email are
        out of scope for the AI by design.
      </p>
    </>
  );
}
