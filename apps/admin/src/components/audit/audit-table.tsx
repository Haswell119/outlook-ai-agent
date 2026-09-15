"use client";

import * as React from "react";
import { Eye, MoreHorizontal } from "lucide-react";
import type { AuditEvent, Language } from "@oao/shared";
import {
  Table,
  TableBody,
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

export function AuditTable({
  events,
  messages,
  language,
}: {
  events: AuditEvent[];
  messages: Record<string, string>;
  language: Language;
}) {
  const [selected, setSelected] = React.useState<AuditEvent | null>(null);
  const t = (k: string) => messages[k] ?? k;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-[128px] whitespace-nowrap">{t("table.timestamp")} ↓</TableHead>
            <TableHead className="min-w-[160px]">{t("table.user")}</TableHead>
            <TableHead className="min-w-[168px]">{t("table.actionType")}</TableHead>
            <TableHead className="min-w-[200px]">{t("table.source")}</TableHead>
            <TableHead className="min-w-[88px] whitespace-nowrap">{t("table.risk")}</TableHead>
            <TableHead className="min-w-[164px]">{t("table.approval")}</TableHead>
            <TableHead className="w-[80px] whitespace-nowrap text-right">{t("table.details")}</TableHead>
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
          {events.map((event) => (
            <TableRow key={event.id}>
              <TableCell className="whitespace-nowrap text-xs text-[#424242]">
                {formatDateTimeCompact(event.timestamp, language)}
              </TableCell>
              <TableCell className="max-w-[180px]">
                <span className="block truncate font-medium">{event.user.displayName ?? event.user.email}</span>
                <span className="block truncate text-xs text-[#616161]">{event.user.email}</span>
              </TableCell>
              <TableCell className="text-sm">
                <EventTypeCell type={event.type} />
              </TableCell>
              <TableCell className="max-w-[240px]">
                <span className="block max-w-[240px] truncate text-sm">{event.source?.label ?? "—"}</span>
                {event.source?.counterpart && (
                  <span className="block max-w-[240px] truncate text-xs text-[#616161]">
                    From: {event.source.counterpart}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <RiskBadge level={event.riskLevel} messages={messages} />
              </TableCell>
              <TableCell className="max-w-[184px] text-sm">
                <ApprovalCell
                  status={event.approvalStatus}
                  approvedBy={event.approvedBy}
                  policy={typeof event.details.policy === "string" ? event.details.policy : undefined}
                  messages={messages}
                />
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("action.viewDetails")}
                    onClick={() => setSelected(event)}
                  >
                    <Eye className="h-4 w-4 text-[#0F6CBD]" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="More">
                        <MoreHorizontal className="h-4 w-4 text-[#616161]" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setSelected(event)}>
                        <Eye className="h-4 w-4" /> {t("action.viewDetails")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          void navigator.clipboard?.writeText(event.correlationId ?? event.id);
                        }}
                      >
                        {t("details.correlationId")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
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
      />
    </>
  );
}
