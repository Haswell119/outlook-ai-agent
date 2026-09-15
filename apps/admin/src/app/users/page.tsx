import { Users } from "lucide-react";
import { currentLanguage, getUsers } from "@/lib/api";
import { dictionaries } from "@/lib/i18n";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

const ROLE_VARIANT = { admin: "info", compliance: "medium", user: "neutral" } as const;

export default async function UsersPage() {
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Record<string, string>;
  const t = (k: string) => messages[k] ?? k;
  const users = await getUsers();

  return (
    <>
      <PageHeader
        icon={<Users className="h-5 w-5" />}
        title={t("page.users.title")}
        subtitle={t("page.users.subtitle")}
      />
      <Card className="min-w-0">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-[180px]">{t("users.name")}</TableHead>
                <TableHead className="min-w-[220px]">{t("users.email")}</TableHead>
                <TableHead className="min-w-[180px]">{t("users.roles")}</TableHead>
                <TableHead className="min-w-[110px] text-right">{t("users.actions")}</TableHead>
                <TableHead className="min-w-[170px]">{t("users.lastActivity")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.displayName ?? u.email}</TableCell>
                  <TableCell className="text-sm text-[#424242]">{u.email}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <Badge key={r} variant={ROLE_VARIANT[r]}>
                          {r}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(u.actions, language)}</TableCell>
                  <TableCell className="text-sm text-[#424242]">
                    {u.lastActivityAt ? formatDateTime(u.lastActivityAt, language) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
