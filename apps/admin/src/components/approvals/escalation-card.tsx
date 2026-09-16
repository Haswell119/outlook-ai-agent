"use client";

import * as React from "react";
import { AlertTriangle, Mail, Paperclip, ShieldCheck, User, Users } from "lucide-react";
import type { EmailAddress, Escalation, Language } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { DecisionDialog } from "./decision-dialog";
import { formatDateTime } from "@/lib/format";
import { tr, type Messages } from "@/lib/i18n";

function addressLabel(a: EmailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function formatBytes(size?: number): string {
  if (!size || size <= 0) return "";
  const units = ["B", "kB", "MB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return ` · ${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * One compliance escalation. The draft under review (`Escalation.draft`, a
 * `ComposeContext`) now comes from the contract, so recipients, subject and
 * attachments are shown against a live orchestrator too.
 */
export function EscalationCard({
  escalation,
  messages,
  language,
  timeZone,
}: {
  escalation: Escalation;
  messages: Messages;
  language: Language;
  timeZone: string;
}) {
  const t = (k: string, vars?: Record<string, string | number>) => tr(messages, k, vars);
  // Optimistic status: applied the moment the operator confirms the dialog.
  const [optimistic, setOptimistic] = React.useState<Escalation["status"] | null>(null);
  const status = optimistic ?? escalation.status;
  const pending = status === "pending";
  const draft = escalation.draft;
  const statusVariant = status === "approved" ? "low" : status === "rejected" ? "high" : "medium";

  return (
    <Card className="min-w-0" data-testid="escalation-card" data-status={status}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#8A6D00]" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#242424]">
                {draft?.subject || escalation.reason.slice(0, 64)}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[#616161]">
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3" aria-hidden="true" />
                  {t("approvals.requester")}: {escalation.requestedBy}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatDateTime(escalation.requestedAt, language, timeZone)}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{escalation.id}</span>
              </p>
            </div>
          </div>
          <Badge variant={statusVariant}>{t(`approval.${status}`)}</Badge>
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
                <li
                  key={issue.id}
                  className="flex items-start justify-between gap-3 rounded-md bg-[#FAF9F8] px-2.5 py-2"
                >
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

        <Separator />

        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
            <Mail className="h-3 w-3" aria-hidden="true" />
            {t("approvals.draft")}
          </p>
          {!draft ? (
            <p className="text-xs text-[#A19F9D]">{t("approvals.noDraft")}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 sm:col-span-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("approvals.subject")}
                </p>
                <p className="truncate text-sm text-[#242424]">{draft.subject || "—"}</p>
                {draft.from && (
                  <p className="truncate text-xs text-[#616161]">
                    {t("approvals.sender")}: {addressLabel(draft.from)}
                  </p>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("approvals.recipients")} ({draft.to.length})
                </p>
                <ul className="mt-1 space-y-0.5">
                  {draft.to.map((to) => (
                    <li
                      key={to.address}
                      className="flex items-center gap-1.5 truncate text-xs text-[#424242]"
                    >
                      <Mail className="h-3 w-3 shrink-0 text-[#616161]" aria-hidden="true" />
                      <span className="truncate">{addressLabel(to)}</span>
                    </li>
                  ))}
                </ul>
                {draft.cc.length > 0 && (
                  <p className="mt-1 truncate text-xs text-[#616161]">
                    {t("approvals.cc")}: {draft.cc.map((c) => c.address).join(", ")}
                  </p>
                )}
                {draft.isReplyAll && (
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-[#8A6D00]">
                    <Users className="h-3 w-3" aria-hidden="true" />
                    {t("approvals.replyAll")}
                  </p>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("approvals.attachments")} ({draft.attachments.length})
                </p>
                {draft.attachments.length === 0 ? (
                  <p className="mt-1 text-xs text-[#A19F9D]">—</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {draft.attachments.map((a) => (
                      <li
                        key={a.name}
                        className="flex items-center gap-1.5 truncate text-xs text-[#424242]"
                      >
                        <Paperclip className="h-3 w-3 shrink-0 text-[#616161]" aria-hidden="true" />
                        <span className="truncate">
                          {a.name}
                          {formatBytes(a.size)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {draft.sensitivityLabel && (
                  <p className="mt-1 inline-flex items-center gap-1 text-xs text-[#616161]">
                    <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                    {t("approvals.label")}: {draft.sensitivityLabel}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {!pending && escalation.decidedBy && (
          <>
            <Separator />
            <p className="text-xs text-[#616161]">
              {t("approvals.decidedBy")}{" "}
              <span className="font-medium text-[#242424]">{escalation.decidedBy}</span>
              {escalation.decidedAt &&
                ` · ${formatDateTime(escalation.decidedAt, language, timeZone)}`}
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
            successMessage={t("approvals.approved")}
            messages={messages}
            onOptimistic={() => setOptimistic("approved")}
            onRevert={() => setOptimistic(null)}
          />
          <DecisionDialog
            endpoint={`/api/escalations/${escalation.id}/decision`}
            body={{ decision: "reject" }}
            kind="reject"
            title={`${t("approvals.reject")} — ${escalation.id}`}
            description={escalation.reason}
            triggerLabel={t("approvals.reject")}
            successMessage={t("approvals.rejected")}
            requireComment
            messages={messages}
            onOptimistic={() => setOptimistic("rejected")}
            onRevert={() => setOptimistic(null)}
          />
        </CardFooter>
      )}
    </Card>
  );
}
