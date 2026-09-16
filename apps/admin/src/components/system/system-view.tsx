"use client";

import * as React from "react";
import {
  Activity,
  Cpu,
  Database,
  Gauge,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Timer,
  Zap,
} from "lucide-react";
import type { Language, SystemStatus } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { readApiError, useToast } from "@/components/ui/toast";
import { tr, type Messages } from "@/lib/i18n";
import {
  formatDateTime,
  formatDateTimeCompact,
  formatDuration,
  formatLatency,
  formatNumber,
  formatPercent,
  hitRate,
} from "@/lib/format";

const REFRESH_MS = 15_000;

const STATUS_VARIANT = { ok: "low", degraded: "medium", down: "high" } as const;

/** `llm` → `LLM`, `database` → `Database`: CSS `capitalize` mangles acronyms. */
const CHECK_LABELS: Record<string, string> = {
  llm: "LLM",
  db: "Database",
  graph: "Microsoft Graph",
};

export function checkLabel(name: string): string {
  return CHECK_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-[#EDEBE9] px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#616161]">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold text-[#242424]">{value}</p>
      {hint && <p className="truncate text-xs text-[#616161]">{hint}</p>}
    </div>
  );
}

export function SystemView({
  initial,
  messages,
  language,
  timeZone,
  metricsPath,
  probePaths,
}: {
  initial: SystemStatus;
  messages: Messages;
  language: Language;
  timeZone: string;
  metricsPath: string;
  probePaths: { live: string; ready: string };
}) {
  const [status, setStatus] = React.useState<SystemStatus>(initial);
  const [fetchedAt, setFetchedAt] = React.useState<string>(new Date().toISOString());
  const [busy, setBusy] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const { toast } = useToast();
  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>) => tr(messages, key, vars),
    [messages],
  );

  const load = React.useCallback(
    async (manual = false) => {
      if (manual) setBusy(true);
      try {
        const res = await fetch("/api/system", { cache: "no-store" });
        if (!res.ok) {
          if (manual) {
            const err = await readApiError(res);
            toast({
              title: t("error.title"),
              description: err.message,
              correlationId: err.correlationId,
              tone: "error",
              onRetry: () => void load(true),
            });
          }
          return;
        }
        const body = (await res.json()) as { status: SystemStatus; fetchedAt: string };
        setStatus(body.status);
        setFetchedAt(body.fetchedAt);
      } catch {
        if (manual) toast({ title: t("toast.failed"), tone: "error" });
      } finally {
        if (manual) setBusy(false);
      }
    },
    [t, toast],
  );

  React.useEffect(() => {
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/system/sync", { method: "POST" });
      if (!res.ok) {
        const err = await readApiError(res);
        toast({
          title: t("error.title"),
          description: err.message,
          correlationId: err.correlationId,
          tone: "error",
          onRetry: () => void syncNow(),
        });
        return;
      }
      toast({ title: t("system.syncStarted"), tone: "success" });
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const { health, features, llmQueue, cache, sync } = status;
  const analysisRate = hitRate(cache.analysisHits, cache.analysisMisses);
  const embeddingRate = hitRate(cache.embeddingHits, cache.embeddingMisses);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[#616161]">
        <Badge variant={STATUS_VARIANT[health.status]}>{health.status}</Badge>
        <span className="inline-flex items-center gap-1.5">
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          {t("system.uptime")}: {formatDuration(status.uptimeSeconds, language)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {t("system.refreshedAt")}: {formatDateTime(fetchedAt, language, timeZone)}
        </span>
        <span aria-hidden="true">·</span>
        <span>{t("system.autoRefresh")}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void load(true)}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <ShieldCheck className="h-4 w-4 text-brand" aria-hidden="true" />
            <CardTitle>{t("system.health")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-[#EDEBE9]">
              {Object.entries(health.checks).map(([name, check]) => (
                <li key={name} className="flex items-start justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium text-[#242424]">{checkLabel(name)}</span>
                    {check.detail && (
                      <span className="block text-xs text-[#616161]">{check.detail}</span>
                    )}
                  </span>
                  <Badge variant={STATUS_VARIANT[check.status]}>{check.status}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-[#616161]">
              v{health.version} · {formatDateTime(health.timestamp, language, timeZone)}
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Cpu className="h-4 w-4 text-brand" aria-hidden="true" />
            <CardTitle>{t("system.models")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <Metric label={t("system.modelGeneration")} value={features.llmModel} hint={features.llmProvider} />
            <Metric
              label={t("system.modelFast")}
              value={features.llmFastModel ?? features.llmModel}
              hint={features.llmFastModel ? undefined : t("common.na")}
            />
            <Metric
              label={t("system.modelEmbedding")}
              value={features.embeddingModel ?? t("common.na")}
              hint={features.embeddingsEnabled ? t("settings.enabled") : t("settings.disabled")}
            />
            <Metric label={t("settings.authMode")} value={features.authMode} hint={`v${features.version}`} />
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Zap className="h-4 w-4 text-brand" aria-hidden="true" />
            <CardTitle>{t("system.queue")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Metric label={t("system.queuePending")} value={formatNumber(llmQueue.pending, language)} />
              <Metric label={t("system.queueRunning")} value={formatNumber(llmQueue.running, language)} />
              <Metric
                label={t("system.queueConcurrency")}
                value={formatNumber(llmQueue.concurrency, language)}
              />
              <Metric label={t("system.queueLatency")} value={formatLatency(llmQueue.avgLatencyMs)} />
            </div>
            <p className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4 text-[#616161]" aria-hidden="true" />
              <span className="text-[#616161]">{t("system.circuit")}:</span>
              <Badge variant={llmQueue.circuitOpen ? "high" : "low"}>
                {llmQueue.circuitOpen ? t("system.circuitOpen") : t("system.circuitClosed")}
              </Badge>
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Database className="h-4 w-4 text-brand" aria-hidden="true" />
            <CardTitle>{t("system.cache")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <Metric
              label={t("system.cacheAnalysis")}
              value={analysisRate === null ? t("common.na") : formatPercent(analysisRate)}
              hint={`${formatNumber(cache.analysisHits, language)} ${t("system.hits")} · ${formatNumber(
                cache.analysisMisses,
                language,
              )} ${t("system.misses")}`}
            />
            <Metric
              label={t("system.cacheEmbedding")}
              value={embeddingRate === null ? t("common.na") : formatPercent(embeddingRate)}
              hint={`${formatNumber(cache.embeddingHits, language)} ${t("system.hits")} · ${formatNumber(
                cache.embeddingMisses,
                language,
              )} ${t("system.misses")}`}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 text-brand" aria-hidden="true" />
            {t("system.sync")}
          </CardTitle>
          <Button size="sm" onClick={() => void syncNow()} disabled={syncing || !sync?.enabled}>
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            {t("system.syncNow")}
          </Button>
        </CardHeader>
        <CardContent>
          {!sync || !sync.enabled ? (
            <p className="rounded-md bg-[#FFF4CE] px-3 py-2 text-xs text-[#8A6D00]">
              {t("system.syncDisabled")}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
              <Metric label={t("system.syncState")} value={t(`system.state.${sync.state}`)} />
              <Metric
                label={t("system.syncIndexed")}
                value={formatNumber(sync.indexedEmails, language)}
              />
              <Metric
                label={t("system.syncPrecomputed")}
                value={formatNumber(sync.precomputedAnalyses, language)}
              />
              <Metric label={t("system.syncPending")} value={formatNumber(sync.pending, language)} />
              <Metric
                label={t("system.syncLast")}
                value={
                  sync.lastSyncAt ? formatDateTimeCompact(sync.lastSyncAt, language, timeZone) : "—"
                }
              />
              <Metric
                label={t("system.syncNext")}
                value={
                  sync.nextSyncAt ? formatDateTimeCompact(sync.nextSyncAt, language, timeZone) : "—"
                }
              />
            </div>
          )}
          {sync?.lastError && (
            <p className="mt-3 rounded-md bg-[#FDE7E9] px-3 py-2 text-xs text-[#C4314B]">
              {sync.lastError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Gauge className="h-4 w-4 text-brand" aria-hidden="true" />
          <CardTitle>{t("system.probes")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-[#616161]">
          <p>{t("system.metricsNote", { path: metricsPath })}</p>
          <ul className="flex flex-wrap gap-2 font-mono text-[11px]">
            {[probePaths.live, probePaths.ready, metricsPath].map((p) => (
              <li key={p} className="rounded-md bg-[#F5F5F5] px-2 py-1 text-[#424242]">
                {p}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
