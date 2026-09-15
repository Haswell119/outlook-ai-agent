import { AlertTriangle, Mail, Paperclip, User } from "lucide-react";
import type { Escalation, Language } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DecisionDialog } from "./decision-dialog";
import { formatDateTime } from "@/lib/format";

export interface EscalationDraft {
  subject: string;
  to: string[];
  attachments: string[];
}

export function EscalationCard({
  escalation,
  draft,
  messages,
  language,
}: {
  escalation: Escalation;
  draft?: EscalationDraft;
  messages: Record<string, string>;
  language: Language;
}) {
  const t = (k: string) => messages[k] ?? k;
  const pending = escalation.status === "pending";
  const statusVariant =
    escalation.status === "approved" ? "low" : escalation.status === "rejected" ? "high" : "medium";

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8A6D00]" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#242424]">
                {draft?.subject ?? escalation.reason.slice(0, 64)}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#616161]">
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {t("approvals.requester")}: {escalation.requestedBy}
                </span>
                <span>·</span>
                <span>{formatDateTime(escalation.requestedAt, language)}</span>
                <span>·</span>
                <span className="font-mono">{escalation.id}</span>
              </p>
            </div>
          </div>
          <Badge variant={statusVariant}>{t(`approval.${escalation.status}`)}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
            {t("approvals.reason")}
          </p>
          <p className="mt-0.5 text-sm text-[#242424]">{escalation.reason}</p>
        </div>

        {escalation.issues.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
              {t("approvals.issues")} ({escalation.issues.length})
            </p>
            <ul className="space-y-1.5">
              {escalation.issues.map((issue) => (
                <li key={issue.id} className="flex items-start justify-between gap-3 rounded-md bg-[#FAF9F8] px-2.5 py-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[#242424]">{issue.title}</span>
                    <span className="block text-xs text-[#616161]">{issue.description}</span>
                  </span>
                  <Badge variant={issue.severity}>{t(`risk.${issue.severity}`)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {draft && (
          <>
            <Separator />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("approvals.recipients")}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {draft.to.map((to) => (
                    <li key={to} className="flex items-center gap-1.5 truncate text-xs text-[#424242]">
                      <Mail className="h-3 w-3 shrink-0 text-[#616161]" />
                      {to}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("approvals.attachments")}
                </p>
                {draft.attachments.length === 0 ? (
                  <p className="mt-1 text-xs text-[#A19F9D]">—</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {draft.attachments.map((a) => (
                      <li key={a} className="flex items-center gap-1.5 truncate text-xs text-[#424242]">
                        <Paperclip className="h-3 w-3 shrink-0 text-[#616161]" />
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}

        {!pending && escalation.decidedBy && (
          <>
            <Separator />
            <p className="text-xs text-[#616161]">
              {t("approvals.decidedBy")} <span className="font-medium text-[#242424]">{escalation.decidedBy}</span>
              {escalation.decidedAt && ` · ${formatDateTime(escalation.decidedAt, language)}`}
              {escalation.decisionComment && (
                <span className="mt-1 block rounded-md bg-[#F5F5F5] px-2.5 py-2 italic text-[#424242]">
                  “{escalation.decisionComment}”
                </span>
              )}
            </p>
          </>
        )}
      </CardContent>

      {pending && (
        <CardFooter className="gap-2">
          <DecisionDialog
            endpoint={`/api/escalations/${escalation.id}/decision`}
            body={{ decision: "approve" }}
            kind="approve"
            title={`${t("approvals.approve")} — ${escalation.id}`}
            description={escalation.reason}
            triggerLabel={t("approvals.approve")}
            messages={messages}
          />
          <DecisionDialog
            endpoint={`/api/escalations/${escalation.id}/decision`}
            body={{ decision: "reject" }}
            kind="reject"
            title={`${t("approvals.reject")} — ${escalation.id}`}
            description={escalation.reason}
            triggerLabel={t("approvals.reject")}
            messages={messages}
          />
        </CardFooter>
      )}
    </Card>
  );
}
