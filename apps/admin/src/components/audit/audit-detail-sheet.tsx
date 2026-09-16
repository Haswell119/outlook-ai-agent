"use client";

import type { AuditEvent, Language } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { eventMeta } from "./event-icon";
import { RiskBadge } from "./risk-badge";
import { ApprovalCell } from "./approval-cell";
import { formatConfidence, formatDateTime, formatLatency } from "@/lib/format";
import { eventAiSource } from "@/lib/ai-load";
import Link from "next/link";
import { SquareArrowOutUpRight } from "lucide-react";

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">{label}</p>
      <p className={`mt-0.5 break-words text-sm text-[#242424] ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}

export function AuditDetailSheet({
  event,
  open,
  onOpenChange,
  messages,
  language,
  timeZone,
}: {
  event: AuditEvent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: Record<string, string>;
  language: Language;
  timeZone: string;
}) {
  const t = (k: string) => messages[k] ?? k;
  if (!event) return <Sheet open={open} onOpenChange={onOpenChange} />;
  const meta = eventMeta(event.type);
  const Icon = meta.icon;
  const aiSource = eventAiSource(event);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${meta.tone}`} />
            {t("details.title")}
          </SheetTitle>
          <SheetDescription>
            {meta.label} · {formatDateTime(event.timestamp, language, timeZone)}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("table.user")} value={`${event.user.displayName ?? event.user.email}`} />
            <Field label="Email" value={event.user.email} />
            <Field label={t("table.risk")} value={<RiskBadge level={event.riskLevel} messages={messages} />} />
            <Field
              label={t("table.approval")}
              value={
                <ApprovalCell
                  status={event.approvalStatus}
                  approvedBy={event.approvedBy}
                  policy={typeof event.details.policy === "string" ? event.details.policy : undefined}
                  messages={messages}
                />
              }
            />
          </div>

          <Separator />

          <Field
            label={t("table.source")}
            value={
              <>
                {event.source?.label ?? "—"}
                {event.source?.counterpart && (
                  <span className="block text-xs text-[#616161]">From: {event.source.counterpart}</span>
                )}
              </>
            }
          />

          <div className="grid grid-cols-2 gap-4">
            <Field label={t("details.model")} value={event.model ?? "—"} />
            <Field
              label={t("audit.detail.aiSource")}
              value={aiSource ? t(`source.${aiSource}`) : t("common.na")}
            />
            <Field label={t("details.latency")} value={formatLatency(event.latencyMs)} />
            <Field label={t("details.confidence")} value={formatConfidence(event.confidence)} />
            <Field label="Audit id" value={event.id} mono />
            <Field label={t("details.correlationId")} value={event.correlationId ?? "—"} mono />
            {event.source?.emailId && <Field label="Email id" value={event.source.emailId} mono />}
          </div>

          <Separator />

          <div>
            <p className="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
              {t("details.payload")}
              <Badge variant="neutral">JSON</Badge>
            </p>
            <pre
              tabIndex={0}
              className="oao-scroll max-h-[320px] overflow-auto rounded-md bg-[#F5F5F5] p-3 text-[11px] leading-relaxed text-[#242424] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {JSON.stringify(event, null, 2)}
            </pre>
          </div>

          <div>
            <Link
              href={`/audit/${event.id}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
              {t("audit.detail.openEvent")}
            </Link>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
