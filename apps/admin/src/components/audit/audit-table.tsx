"use client";

import * as React from "react";
import Link from "next/link";
import { Copy, Eye, MoreHorizontal, SquareArrowOutUpRight } from "lucide-react";
import type { AuditEvent, Language } from "@oao/shared";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EventTypeCell } from "./event-icon";
import { RiskBadge } from "./risk-badge";
import { ApprovalCell } from "./approval-cell";
import { AuditDetailSheet } from "./audit-detail-sheet";
import { formatDateTimeCompact } from "@/lib/format";
import { eventAiSource } from "@/lib/ai-load";
import { tr, type Messages } from "@/lib/i18n";
import { useToast } from "@/components/ui/toast";

export function AuditTable({
  events,
  messages,
  language,
  timeZone,
  caption,
}: {
  events: AuditEvent[];
  messages: Messages;
  language: Language;
  timeZone: string;
  caption?: string;
}) {
  const [selected, setSelected] = React.useState<AuditEvent | null>(null);
  const { toast } = useToast();
  const t = (k: string, vars?: Record<string, string | number>) => tr(messages, k, vars);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      toast({ title: t("common.copied"), description: value, tone: "info", duration: 2500 });
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <>
      <Table>
        <TableCaption className="sr-only">{caption ?? t("page.audit.title")}</TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[128px] whitespace-nowrap" aria-sort="descending">
              {t("table.timestamp")} ↓
            </TableHead>
            <TableHead className="min-w-[150px]">{t("table.user")}</TableHead>
            <TableHead className="min-w-[155px]">{t("table.actionType")}</TableHead>
            <TableHead className="min-w-[176px]">{t("table.source")}</TableHead>
            <TableHead className="min-w-[88px] whitespace-nowrap">{t("table.risk")}</TableHead>
            <TableHead className="min-w-[148px]">{t("table.approval")}</TableHead>
            <TableHead className="w-[132px] whitespace-nowrap pr-4 text-right">
              {t("table.details")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-sm text-[#616161]">
                {t("table.empty")}
              </TableCell>
            </TableRow>
          )}
          {events.map((event) => {
            const source = eventAiSource(event);
            return (
              <TableRow key={event.id}>
                <TableCell className="whitespace-nowrap text-xs text-[#424242]">
                  {formatDateTimeCompact(event.timestamp, language, timeZone)}
                </TableCell>
                <TableCell className="max-w-[170px]">
                  <span className="block truncate font-medium">
                    {event.user.displayName ?? event.user.email}
                  </span>
                  <span className="block truncate text-xs text-[#616161]">{event.user.email}</span>
                </TableCell>
                <TableCell className="text-sm">
                  <EventTypeCell type={event.type} />
                  {(source || event.model) && (
                    <span className="mt-0.5 block truncate text-xs text-[#616161]">
                      {source ? t(`source.${source}`) : t("common.na")}
                      {event.model ? ` · ${event.model}` : ""}
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-[240px]">
                  <span className="block max-w-[240px] truncate text-sm">
                    {event.source?.label ?? "—"}
                  </span>
                  {event.source?.counterpart && (
                    <span className="block max-w-[240px] truncate text-xs text-[#616161]">
                      {event.source.counterpart}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <RiskBadge level={event.riskLevel} messages={messages} />
                </TableCell>
                <TableCell className="max-w-[168px] text-sm">
                  <ApprovalCell
                    status={event.approvalStatus}
                    approvedBy={event.approvedBy}
                    policy={typeof event.details.policy === "string" ? event.details.policy : undefined}
                    messages={messages}
                  />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <div className="flex justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t("action.viewDetails")} — ${event.id}`}
                      onClick={() => setSelected(event)}
                    >
                      <Eye className="h-4 w-4 text-[#0F6CBD]" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" asChild>
                      <Link
                        href={`/audit/${event.id}`}
                        aria-label={`${t("audit.detail.openEvent")} — ${event.id}`}
                      >
                        <SquareArrowOutUpRight className="h-4 w-4 text-[#616161]" aria-hidden="true" />
                      </Link>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t("table.details")} — ${event.id}`}
                        >
                          <MoreHorizontal className="h-4 w-4 text-[#616161]" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setSelected(event)}>
                          <Eye className="h-4 w-4" aria-hidden="true" /> {t("action.viewDetails")}
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/audit/${event.id}`}>
                            <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
                            {t("audit.detail.openEvent")}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => void copy(event.correlationId ?? event.id)}
                        >
                          <Copy className="h-4 w-4" aria-hidden="true" />
                          {t("details.correlationId")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <AuditDetailSheet
        event={selected}
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        messages={messages}
        language={language}
        timeZone={timeZone}
      />
    </>
  );
}
