/**
 * Mailbox sync / precomputation status (`GET /mailbox/sync`).
 *
 * This is the honest answer to "why was that instant?" and "why wasn't it?":
 * last sync time, how many analyses are already precomputed, how many are
 * pending. "Sync now" (`POST /mailbox/sync`) nudges the worker; it does not
 * call the model itself.
 *
 * Fully optional: when the backend reports `enabled: false` (no Graph consent)
 * the card explains that instead of pretending something is broken.
 */
import { Button, makeStyles, Spinner, Text, Tooltip } from "@fluentui/react-components";
import { ArrowSync20Regular, CloudSync20Regular } from "@fluentui/react-icons";
import type { MailboxSyncStatus } from "@oao/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/app/AppContext";
import { formatDate, useI18n } from "@/i18n";
import { track } from "@/telemetry";
import { RiskBadge, SectionCard, colors, useErrorMessage, useToast } from "@/ui";

const useStyles = makeStyles({
  row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    paddingBlock: "1px",
    paddingInline: "8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: 600,
    lineHeight: "16px",
    whiteSpace: "nowrap",
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.background,
    color: colors.textSecondary,
  },
  pillOk: { backgroundColor: colors.lowBg, color: colors.lowText, border: `1px solid ${colors.lowBorder}` },
  pillBusy: { backgroundColor: colors.primaryTint, color: colors.primary, border: `1px solid ${colors.primaryBorder}` },
  pillError: { backgroundColor: colors.highBg, color: colors.highText, border: `1px solid ${colors.highBorder}` },
  kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px", alignItems: "center" },
  k: { color: colors.textSecondary },
  spacer: { flexGrow: 1 },
  error: { color: colors.highText, fontSize: "12px", wordBreak: "break-word" },
});

export function SyncStatusPill({ status: injected }: { status?: MailboxSyncStatus } = {}) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const [status, setStatus] = useState<MailboxSyncStatus | null>(injected ?? null);
  const [loading, setLoading] = useState(!injected);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useRef(0);

  const load = useCallback(async () => {
    const my = ++run.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.mailboxSync();
      if (my === run.current) setStatus(next);
    } catch (err) {
      if (my === run.current) setError(err);
    } finally {
      if (my === run.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (injected) return;
    void load();
  }, [injected, load]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const next = await api.syncNow();
      setStatus(next);
      track("sync.requested", { status: next.state });
      toast.success(t("sync.requested"));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSyncing(false);
    }
  }, [api, errMsg, t, toast]);

  if (loading && !status) {
    return (
      <SectionCard icon={<CloudSync20Regular />} title={t("sync.title")} testId="sync-status">
        <Spinner size="extra-tiny" label={t("app.loading")} labelPosition="after" />
      </SectionCard>
    );
  }

  if (error && !status) {
    // A missing sync endpoint is not an error worth shouting about.
    return (
      <SectionCard icon={<CloudSync20Regular />} title={t("sync.title")} testId="sync-status">
        <Text className={s.error}>{errMsg(error)}</Text>
      </SectionCard>
    );
  }

  if (!status) return null;

  const pillClass =
    status.state === "error" ? s.pillError : status.state === "syncing" ? s.pillBusy : status.state === "idle" && status.enabled ? s.pillOk : s.pill;

  return (
    <SectionCard
      icon={<CloudSync20Regular />}
      title={t("sync.title")}
      testId="sync-status"
      actions={
        <span className={`${s.pill} ${pillClass}`} data-testid="sync-pill" data-state={status.state}>
          {t(`sync.state.${status.state}`)}
        </span>
      }
    >
      {!status.enabled ? (
        <Text style={{ color: colors.textSecondary, fontSize: "12px" }}>{t("sync.disabled")}</Text>
      ) : (
        <div className={s.kv}>
          <span className={s.k}>{t("sync.lastSync")}</span>
          <span data-testid="sync-last">{status.lastSyncAt ? formatDate(status.lastSyncAt, lang) : t("sync.never")}</span>
          <span className={s.k}>{t("sync.precomputed")}</span>
          <span data-testid="sync-precomputed">{status.precomputedAnalyses}</span>
          <span className={s.k}>{t("sync.indexed")}</span>
          <span>{status.indexedEmails}</span>
          <span className={s.k}>{t("sync.pending")}</span>
          <span>{status.pending}</span>
          {status.nextSyncAt && (
            <>
              <span className={s.k}>{t("sync.nextSync")}</span>
              <span>{formatDate(status.nextSyncAt, lang)}</span>
            </>
          )}
        </div>
      )}
      {status.lastError && (
        <div className={s.row} style={{ marginTop: "6px" }}>
          <RiskBadge level="medium" />
          <Text className={s.error}>{status.lastError}</Text>
        </div>
      )}
      <div className={s.row} style={{ marginTop: "8px" }}>
        <Tooltip content={t("sync.syncNowHint")} relationship="description">
          <Button
            size="small"
            appearance="outline"
            icon={syncing || status.state === "syncing" ? <Spinner size="extra-tiny" /> : <ArrowSync20Regular />}
            onClick={() => void syncNow()}
            disabled={syncing || !status.enabled || status.state === "syncing"}
            data-testid="sync-now"
          >
            {t("sync.syncNow")}
          </Button>
        </Tooltip>
        <span className={s.spacer} />
        <Button size="small" appearance="subtle" onClick={() => void load()} disabled={loading}>
          {t("app.refreshStatus")}
        </Button>
      </div>
    </SectionCard>
  );
}
