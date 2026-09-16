/**
 * Daily brief — the "Résumé journalier" promised in the deck, and the first
 * thing the pane shows when it opens without an item selected (the New-mail
 * ribbon button, or the Apps menu on an empty reading pane).
 *
 * Load policy, same discipline as the email analysis:
 *   1. local cache (keyed by date + language, TTL 24 h) → instant
 *   2. `GET /brief/daily` → the brief the sync worker precomputed this morning
 *   3. nothing at all → an empty state; we never generate one on our own
 *
 * "Regenerate" is the only path that calls the model, and it asks first, in
 * plain words, because it costs one. That confirmation is the whole point: the
 * user decides when to spend.
 */
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, makeStyles, Spinner, Text } from "@fluentui/react-components";
import {
  ArrowSync20Regular,
  CalendarLtr20Regular,
  CheckboxChecked20Regular,
  ClipboardTask20Regular,
  MailUnread20Regular,
  Open16Regular,
  ShieldError20Regular,
  Sparkle20Filled,
  Warning20Regular,
} from "@fluentui/react-icons";
import type { BriefEmail, DailyBrief } from "@oao/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/app/AppContext";
import { formatDate, useI18n } from "@/i18n";
import { readCached, writeCached } from "@/cache/analysisCache";
import { openMessage } from "@/office/actions";
import { toPlainText } from "@/security/sanitize";
import { track } from "@/telemetry";
import { AiFooter, BulletList, EmptyState, ErrorState, RiskBadge, SectionCard, Skeleton, SourceBadge, colors, useErrorMessage, useToast, type DisplaySource } from "@/ui";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  headlineRow: { display: "flex", alignItems: "flex-start", gap: "8px" },
  headline: { fontWeight: 600, fontSize: "15px", lineHeight: "20px", color: colors.text, flexGrow: 1, minWidth: 0 },
  date: { color: colors.textSecondary, fontSize: "12px" },
  statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(84px, 1fr))", gap: "8px" },
  stat: {
    border: `1px solid ${colors.border}`,
    borderRadius: "8px",
    paddingBlock: "8px",
    paddingInline: "10px",
    backgroundColor: colors.card,
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  statValue: { fontWeight: 600, fontSize: "18px", lineHeight: "22px", color: colors.text },
  statLabel: { color: colors.textSecondary, fontSize: "11px", lineHeight: "14px" },
  /** The separator lives on the <li>, so the <button> can stay border-free. */
  emailItem: { borderTop: `1px solid ${colors.border}` },
  emailItemFirst: { borderTop: "none" },
  emailRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    width: "100%",
    paddingBlock: "8px",
    paddingInline: "4px",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "6px",
    textAlign: "start",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "13px",
    color: colors.text,
    ":hover": { backgroundColor: colors.primaryTint },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "-2px" },
  },
  emailMain: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  emailSubject: { fontWeight: 600, fontSize: "13px", lineHeight: "17px" },
  emailMeta: { color: colors.textSecondary, fontSize: "12px", lineHeight: "16px" },
  taskRow: { display: "flex", alignItems: "flex-start", gap: "6px", fontSize: "13px", lineHeight: "18px" },
  taskCritical: { fontWeight: 600 },
  deadline: { fontSize: "13px", lineHeight: "18px" },
  deadlineAtRisk: { color: colors.red, fontWeight: 600 },
  toolbar: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  spacer: { flexGrow: 1 },
});

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DailyBriefViewProps {
  /** Rendered in tests / screenshots instead of calling the API. */
  brief?: DailyBrief;
}

export function DailyBriefView({ brief: injected }: DailyBriefViewProps = {}) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api, features } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();

  const [brief, setBrief] = useState<DailyBrief | null>(injected ?? null);
  const [loading, setLoading] = useState(!injected);
  const [error, setError] = useState<unknown>(null);
  const [source, setSource] = useState<DisplaySource | undefined>(injected ? "precomputed" : undefined);
  const [ageMs, setAgeMs] = useState<number | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const run = useRef(0);
  const date = todayIso();

  const load = useCallback(
    async (bypass: boolean) => {
      const my = ++run.current;
      setError(null);
      if (!bypass) setLoading(true);
      try {
        if (!bypass) {
          const hit = await readCached<DailyBrief>("brief", `${date}:${lang}`, "v1");
          if (hit && my === run.current) {
            setBrief(hit.value);
            setSource("local");
            setAgeMs(hit.ageMs);
            setLoading(false);
            track("brief.resolved", { source: "local", cacheHit: true });
            return;
          }
        } else {
          await readCached<DailyBrief>("brief", `${date}:${lang}`, "v1", { bypass: true });
        }
        const stored = await api.dailyBrief({ date, language: lang });
        if (my !== run.current) return;
        if (stored) {
          await writeCached("brief", `${date}:${lang}`, "v1", stored);
          setBrief(stored);
          setSource(stored.source === "heuristic" ? "heuristic" : stored.source === "llm" ? "llm" : "precomputed");
          setAgeMs(undefined);
          track("brief.resolved", { source: stored.source });
        } else {
          setBrief(null);
          setSource(undefined);
        }
      } catch (err) {
        if (my === run.current) setError(err);
      } finally {
        if (my === run.current) setLoading(false);
      }
    },
    [api, date, lang],
  );

  useEffect(() => {
    if (injected) return;
    void load(false);
  }, [injected, load]);

  const regenerate = useCallback(async () => {
    setConfirmOpen(false);
    setRegenerating(true);
    try {
      const fresh = await api.generateDailyBrief({ date, language: lang, refresh: true });
      await writeCached("brief", `${date}:${lang}`, "v1", fresh);
      setBrief(fresh);
      setSource(fresh.source === "heuristic" ? "heuristic" : "llm");
      setAgeMs(undefined);
      track("brief.regenerated", { source: fresh.source });
      toast.success(t("brief.regenerated"));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setRegenerating(false);
    }
  }, [api, date, lang, errMsg, t, toast]);

  const open = useCallback(
    (email: BriefEmail) => {
      if (!openMessage(email.emailId, email.webLink)) toast.info(t("chat.openFailed"));
      else track("brief.openEmail", { kind: email.priority });
    },
    [t, toast],
  );

  const orgName = features?.organizationName?.trim();
  const subtitle = useMemo(() => (orgName ? t("brief.subtitleOrg", { org: orgName }) : t("brief.subtitle")), [orgName, t]);

  if (loading && !brief) return <Skeleton cards={4} label={t("brief.loading")} />;
  if (error && !brief) return <ErrorState error={error} onRetry={() => void load(false)} />;

  if (!brief) {
    return (
      <div className={s.stack} data-testid="daily-brief">
        <EmptyState
          title={t("brief.emptyTitle")}
          description={features && features.dailyBriefEnabled === false ? t("brief.disabled") : t("brief.emptyBody")}
          icon={<Sparkle20Filled style={{ color: colors.primary }} />}
          action={
            <Button appearance="primary" size="small" onClick={() => setConfirmOpen(true)} disabled={regenerating} data-testid="brief-generate">
              {regenerating ? <Spinner size="extra-tiny" /> : t("brief.generate")}
            </Button>
          }
        />
        <RegenerateDialog open={confirmOpen} onCancel={() => setConfirmOpen(false)} onConfirm={() => void regenerate()} />
      </div>
    );
  }

  const stats: Array<{ key: string; value: number }> = [
    { key: "newEmails", value: brief.stats.newEmails },
    { key: "analysed", value: brief.stats.analysed },
    { key: "awaitingReply", value: brief.stats.awaitingReply },
    { key: "phishingSuspected", value: brief.stats.phishingSuspected },
  ];

  return (
    <div className={s.stack} data-testid="daily-brief">
      <SectionCard tint="blue" testId="brief-headline">
        <div className={s.headlineRow}>
          <Sparkle20Filled style={{ color: colors.primary, flexShrink: 0 }} aria-hidden="true" />
          <div className={s.emailMain}>
            <Text className={s.headline} block>
              {toPlainText(brief.headline, 300)}
            </Text>
            <Text className={s.date} block>
              {formatDate(`${brief.date}T00:00:00.000Z`, lang, false)} · {subtitle}
            </Text>
          </div>
          <SourceBadge source={source} ageMs={ageMs} />
        </div>
      </SectionCard>

      <SectionCard icon={<CheckboxChecked20Regular />} iconColor={colors.lowText} iconBg={colors.lowBg} title={t("brief.highlights")} testId="brief-highlights">
        <BulletList items={brief.highlights.map((h) => toPlainText(h, 400))} empty={t("brief.noHighlights")} />
      </SectionCard>

      <SectionCard icon={<MailUnread20Regular />} title={t("brief.priorityEmails")} testId="brief-priority">
        {brief.priorityEmails.length === 0 ? (
          <Text style={{ color: colors.textSecondary, fontSize: "13px" }}>{t("brief.noPriority")}</Text>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {brief.priorityEmails.map((e, i) => (
              <li key={e.emailId} className={i === 0 ? s.emailItemFirst : s.emailItem}>
                <button type="button" className={s.emailRow} onClick={() => open(e)} data-testid="brief-email">
                  <span className={s.emailMain}>
                    <span className={s.emailSubject}>{toPlainText(e.subject, 200)}</span>
                    <span className={s.emailMeta}>
                      {e.from ? toPlainText(e.from, 80) : ""}
                      {e.receivedAt ? ` · ${formatDate(e.receivedAt, lang)}` : ""}
                    </span>
                    <span className={s.emailMeta}>{toPlainText(e.reason, 200)}</span>
                  </span>
                  <RiskBadge level={e.riskLevel ?? (e.priority === "high" ? "high" : e.priority === "medium" ? "medium" : "low")} />
                  <Open16Regular style={{ color: colors.textSecondary, flexShrink: 0 }} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard icon={<ClipboardTask20Regular />} iconColor={colors.mediumText} iconBg={colors.mediumBg} title={t("brief.openTasks")} testId="brief-tasks">
        {brief.openTasks.length === 0 ? (
          <Text style={{ color: colors.textSecondary, fontSize: "13px" }}>{t("brief.noTasks")}</Text>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
            {brief.openTasks.map((task, i) => (
              <li key={`${task.title}-${i}`} className={`${s.taskRow} ${task.critical ? s.taskCritical : ""}`}>
                <span aria-hidden="true">•</span>
                <span>
                  {toPlainText(task.title, 200)}
                  <span className={s.emailMeta}>
                    {task.owner ? ` — ${t("thread.owner")}: ${toPlainText(task.owner, 60)}` : ""}
                    {task.dueDate ? ` · ${formatDate(task.dueDate, lang, false)}` : ""}
                    {` · ${t("thread.priority")}: ${t(`risk.${task.priority}`)}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard icon={<CalendarLtr20Regular />} iconColor={colors.red} iconBg={colors.highBg} title={t("brief.deadlines")} testId="brief-deadlines">
        {brief.deadlines.length === 0 ? (
          <Text style={{ color: colors.textSecondary, fontSize: "13px" }}>{t("brief.noDeadlines")}</Text>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
            {brief.deadlines.map((d, i) => (
              <li key={`${d.title}-${i}`} className={`${s.deadline} ${d.atRisk ? s.deadlineAtRisk : ""}`}>
                {toPlainText(d.title, 200)}
                {d.date ? `: ${formatDate(d.date, lang, false)}` : ""}
                {d.description ? ` — ${toPlainText(d.description, 200)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {brief.alerts.length > 0 && (
        <SectionCard icon={<ShieldError20Regular />} iconColor={colors.red} iconBg={colors.highBg} tint="red" title={t("brief.alerts")} testId="brief-alerts">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
            {brief.alerts.map((a) => (
              <li key={a.code} style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
                <Warning20Regular style={{ color: colors.red, flexShrink: 0 }} aria-hidden="true" />
                <span>
                  {toPlainText(a.title, 200)}
                  {a.description ? <span className={s.emailMeta}> — {toPlainText(a.description, 300)}</span> : null}
                </span>
                <RiskBadge level={a.severity} />
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard title={t("brief.stats")} testId="brief-stats">
        <div className={s.statsGrid}>
          {stats.map((st) => (
            <div key={st.key} className={s.stat}>
              <span className={s.statValue}>{st.value}</span>
              <span className={s.statLabel}>{t(`brief.stat.${st.key}`)}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className={s.toolbar}>
        <Button
          appearance="outline"
          size="small"
          icon={regenerating ? <Spinner size="extra-tiny" /> : <ArrowSync20Regular />}
          onClick={() => setConfirmOpen(true)}
          disabled={regenerating}
          data-testid="brief-regenerate"
        >
          {t("brief.regenerate")}
        </Button>
        <span className={s.spacer} />
      </div>

      <AiFooter auditId={brief.auditId} confidence={brief.confidence} />
      <RegenerateDialog open={confirmOpen} onCancel={() => setConfirmOpen(false)} onConfirm={() => void regenerate()} />
    </div>
  );
}

function RegenerateDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onCancel()} modalType="alert">
      <DialogSurface aria-describedby="oao-brief-regen-desc">
        <DialogBody>
          <DialogTitle>{t("brief.regenerateTitle")}</DialogTitle>
          <DialogContent id="oao-brief-regen-desc">{t("brief.regenerateBody")}</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>
              {t("app.cancel")}
            </Button>
            <Button appearance="primary" onClick={onConfirm} data-testid="brief-regenerate-confirm">
              {t("brief.regenerateConfirm")}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
