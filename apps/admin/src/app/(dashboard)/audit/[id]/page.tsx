import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, Fingerprint, Link2, ScrollText } from "lucide-react";
import { adminConfig, currentLanguage, getAuditEvent, getRelatedAuditEvents } from "@/lib/api";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { formatConfidence, formatDateTime, formatLatency } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { eventMeta } from "@/components/audit/event-icon";
import { RiskBadge } from "@/components/audit/risk-badge";
import { ApprovalCell } from "@/components/audit/approval-cell";
import { eventAiSource } from "@/lib/ai-load";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Audit event — Outlook AI Orchestrator" };

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm text-[#242424] ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function hashOf(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

export default async function AuditEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRoles("admin", "compliance");
  const { id } = await params;
  const language = await currentLanguage();
  const messages = dictionaries[language] as unknown as Messages;
  const t = (key: string, vars?: Record<string, string | number>) => tr(messages, key, vars);
  const cfg = adminConfig();

  const event = await getAuditEvent(id);
  if (!event) notFound();

  const related = await getRelatedAuditEvents(event);
  const meta = eventMeta(event.type);
  const Icon = meta.icon;
  const aiSource = eventAiSource(event);
  const promptHash = hashOf(event.details, "promptSha256");
  const responseHash = hashOf(event.details, "responseSha256");

  return (
    <>
      <PageHeader
        icon={<ScrollText className="h-5 w-5" />}
        title={t("page.auditDetail.title")}
        subtitle={t("page.auditDetail.subtitle")}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/audit">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t("audit.detail.back")}
              </Link>
            </Button>
            <CopyButton
              value={`/audit/${event.id}`}
              label={t("audit.detail.copyLink")}
              copiedLabel={t("common.copied")}
            />
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Icon className={`h-4 w-4 ${meta.tone}`} aria-hidden="true" />
              {meta.label}
            </CardTitle>
            <RiskBadge level={event.riskLevel} messages={messages} />
            {aiSource && <Badge variant="info">{t(`source.${aiSource}`)}</Badge>}
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("table.timestamp")}
                value={formatDateTime(event.timestamp, language, cfg.timeZone)}
              />
              <Field
                label={t("table.user")}
                value={
                  <>
                    {event.user.displayName ?? event.user.email}
                    <span className="block text-xs text-[#616161]">{event.user.email}</span>
                  </>
                }
              />
              <Field
                label={t("table.source")}
                value={
                  <>
                    {event.source?.label ?? "—"}
                    {event.source?.counterpart && (
                      <span className="block text-xs text-[#616161]">{event.source.counterpart}</span>
                    )}
                  </>
                }
              />
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
              <Field label={t("details.model")} value={event.model ?? t("common.na")} />
              <Field label={t("details.latency")} value={formatLatency(event.latencyMs)} />
              <Field label={t("details.confidence")} value={formatConfidence(event.confidence)} />
              <Field
                label={t("audit.detail.aiSource")}
                value={aiSource ? t(`source.${aiSource}`) : t("common.na")}
              />
              <Field label="Audit id" value={event.id} mono />
              <Field
                label={t("details.correlationId")}
                value={event.correlationId ?? t("common.na")}
                mono
              />
              {event.source?.emailId && <Field label="Email id" value={event.source.emailId} mono />}
              {event.source?.conversationId && (
                <Field label="Conversation id" value={event.source.conversationId} mono />
              )}
            </dl>
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card className="min-w-0">
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <Fingerprint className="h-4 w-4 text-brand" aria-hidden="true" />
              <CardTitle>{t("audit.detail.hashes")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                <Field
                  label={t("audit.detail.promptHash")}
                  value={promptHash ?? t("common.na")}
                  mono
                />
                <Field
                  label={t("audit.detail.responseHash")}
                  value={responseHash ?? t("common.na")}
                  mono
                />
              </dl>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader className="space-y-0">
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-brand" aria-hidden="true" />
                {t("audit.detail.related")}
              </CardTitle>
              <p className="text-xs text-[#616161]">{t("audit.detail.relatedHint")}</p>
            </CardHeader>
            <CardContent>
              {related.length === 0 ? (
                <p className="text-sm text-[#616161]">{t("audit.detail.relatedEmpty")}</p>
              ) : (
                <ul className="space-y-1.5">
                  {related.map((r) => {
                    const rm = eventMeta(r.type);
                    const RIcon = rm.icon;
                    return (
                      <li key={r.id}>
                        <Link
                          href={`/audit/${r.id}`}
                          className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[#FAF9F8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <RIcon className={`mt-0.5 h-4 w-4 shrink-0 ${rm.tone}`} aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[#242424]">
                              {rm.label}
                            </span>
                            <span className="block truncate text-xs text-[#616161]">
                              {formatDateTime(r.timestamp, language, cfg.timeZone)}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0 xl:col-span-3">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>{t("audit.detail.json")}</CardTitle>
            <Badge variant="neutral">JSON</Badge>
          </CardHeader>
          <CardContent>
            <pre
              tabIndex={0}
              className="oao-scroll max-h-[420px] overflow-auto rounded-md bg-[#F5F5F5] p-3 text-[11px] leading-relaxed text-[#242424] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {JSON.stringify(event, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
