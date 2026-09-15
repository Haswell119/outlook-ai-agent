"use client";

import * as React from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Eye,
  Sparkles,
  XCircle,
  Zap,
} from "lucide-react";
import type { Automation, Language } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DecisionDialog } from "@/components/approvals/decision-dialog";
import { AutomationStatusBadge } from "./automation-status";
import { formatConfidence, formatDateTime, formatNumber } from "@/lib/format";
import { RiskBadge } from "@/components/audit/risk-badge";

function Actions({
  automation,
  messages,
  iconOnly = false,
}: {
  automation: Automation;
  messages: Record<string, string>;
  /** Dense variant for the table rows. */
  iconOnly?: boolean;
}) {
  const t = (k: string) => messages[k] ?? k;
  const endpoint = `/api/automations/${automation.id}/decision`;
  const canApprove = automation.status !== "active" && automation.status !== "approved";
  const canPause = automation.status === "active";
  return (
    <div className="flex flex-wrap gap-1.5">
      {canApprove && (
        <DecisionDialog
          endpoint={endpoint}
          body={{ action: "approve" }}
          kind="approve"
          title={`${t("approvals.approve")} — ${automation.name}`}
          description={automation.description}
          triggerLabel={t("approvals.approve")}
          messages={messages}
          iconOnly={iconOnly}
        />
      )}
      {canPause && (
        <DecisionDialog
          endpoint={endpoint}
          body={{ action: "pause" }}
          kind="pause"
          title={`${t("automations.pause")} — ${automation.name}`}
          description={automation.description}
          triggerLabel={t("automations.pause")}
          messages={messages}
          iconOnly={iconOnly}
        />
      )}
      {automation.status !== "rejected" && (
        <DecisionDialog
          endpoint={endpoint}
          body={{ action: "reject" }}
          kind="reject"
          title={`${t("approvals.reject")} — ${automation.name}`}
          description={automation.description}
          triggerLabel={t("approvals.reject")}
          messages={messages}
          iconOnly={iconOnly}
        />
      )}
    </div>
  );
}

export function AutomationsView({
  automations,
  messages,
  language,
}: {
  automations: Automation[];
  messages: Record<string, string>;
  language: Language;
}) {
  const [selected, setSelected] = React.useState<Automation | null>(null);
  const t = (k: string) => messages[k] ?? k;

  return (
    <>
      <Card className="mb-4 hidden min-w-0 lg:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-[190px]">{t("automations.name")}</TableHead>
                <TableHead className="min-w-[200px]">{t("automations.trigger")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("automations.steps")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("automations.status")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("automations.occurrences")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("automations.minutesSavedShort")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("automations.confidence")}</TableHead>
                <TableHead className="min-w-[150px] whitespace-nowrap text-right">{t("table.details")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {automations.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="max-w-[200px]">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-[#616161]">{a.description}</span>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-xs text-[#424242]">
                    {a.trigger.description}
                  </TableCell>
                  <TableCell className="tabular-nums">{a.steps.length}</TableCell>
                  <TableCell>
                    <AutomationStatusBadge status={a.status} />
                  </TableCell>
                  <TableCell className="tabular-nums">{formatNumber(a.stats.occurrences, language)}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatNumber(a.stats.estimatedMinutesSavedPerWeek, language)}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatConfidence(a.confidence)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("action.viewDetails")}
                        title={t("action.viewDetails")}
                        onClick={() => setSelected(a)}
                      >
                        <Eye className="h-4 w-4 text-brand" />
                      </Button>
                      <Actions automation={a} messages={messages} iconOnly />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Card layout below 1024px */}
      <div className="grid gap-4 lg:hidden">
        {automations.map((a) => (
          <Card key={a.id}>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[#242424]">{a.name}</p>
                  <p className="text-xs text-[#616161]">{a.trigger.description}</p>
                </div>
                <AutomationStatusBadge status={a.status} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <span>
                  <span className="block text-[#616161]">{t("automations.steps")}</span>
                  <span className="font-semibold">{a.steps.length}</span>
                </span>
                <span>
                  <span className="block text-[#616161]">{t("automations.minutesSaved")}</span>
                  <span className="font-semibold">{a.stats.estimatedMinutesSavedPerWeek}</span>
                </span>
                <span>
                  <span className="block text-[#616161]">{t("automations.confidence")}</span>
                  <span className="font-semibold">{formatConfidence(a.confidence)}</span>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setSelected(a)}>
                  <Eye className="h-4 w-4" /> {t("action.viewDetails")}
                </Button>
                <Actions automation={a} messages={messages} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  {selected.name}
                </SheetTitle>
                <SheetDescription>{selected.description}</SheetDescription>
              </SheetHeader>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <AutomationStatusBadge status={selected.status} />
                <RiskBadge level={selected.riskLevel} messages={messages} />
                <Badge variant="info">
                  <Sparkles className="h-3 w-3" /> {formatConfidence(selected.confidence)}
                </Badge>
                <Badge variant="neutral">
                  <Clock className="h-3 w-3" /> {selected.stats.estimatedMinutesSavedPerWeek} min / week
                </Badge>
              </div>

              <div className="mt-5">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("automations.trigger")}
                </p>
                <p className="rounded-md bg-[#E8F1FB] px-3 py-2 text-sm text-[#0E5FA6]">
                  {selected.trigger.description}
                </p>
              </div>

              <div className="mt-5">
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                  {t("automations.stepFlow")}
                </p>
                <ol className="space-y-2">
                  {selected.steps.map((step, i) => (
                    <li key={step.order} className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-white">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 rounded-md border border-[#E1DFDD] px-2.5 py-1.5">
                        <span className="block text-sm font-medium text-[#242424]">{step.title}</span>
                        <span className="block text-xs text-[#616161]">{step.description}</span>
                      </span>
                      {i < selected.steps.length - 1 && (
                        <ArrowRight className="mt-2 h-3.5 w-3.5 shrink-0 text-[#C8C6C4]" />
                      )}
                    </li>
                  ))}
                </ol>
              </div>

              {selected.lastSimulation && (
                <>
                  <Separator className="my-5" />
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">
                    {t("automations.lastSimulation")}
                  </p>
                  <p className="mt-0.5 text-xs text-[#616161]">
                    {formatDateTime(selected.lastSimulation.runAt, language)} · n=
                    {selected.lastSimulation.sampleSize}
                  </p>

                  <p className="mb-1.5 mt-3 text-xs font-semibold text-[#242424]">{t("automations.checks")}</p>
                  <ul className="space-y-1">
                    {selected.lastSimulation.checks.map((c) => (
                      <li key={c.name} className="flex items-start gap-1.5 text-xs">
                        {c.passed ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#107C10]" />
                        ) : (
                          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#C4314B]" />
                        )}
                        <span className="min-w-0">
                          <span className="font-medium text-[#242424]">{c.name}</span>
                          {c.detail && <span className="block text-[#616161]">{c.detail}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <p className="mb-1.5 mt-4 text-xs font-semibold text-[#242424]">{t("automations.results")}</p>
                  <ul className="space-y-1">
                    {selected.lastSimulation.results.map((r) => (
                      <li
                        key={r.emailId}
                        className="flex items-center justify-between gap-2 rounded-md bg-[#FAF9F8] px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 truncate text-[#424242]">{r.subject}</span>
                        <Badge variant={r.wouldApply ? "low" : "neutral"}>
                          {r.wouldApply ? t("automations.wouldApply") : t("automations.wouldSkip")}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="mt-6">
                <Actions automation={selected} messages={messages} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
