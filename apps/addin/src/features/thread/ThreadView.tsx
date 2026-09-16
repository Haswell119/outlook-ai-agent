import { Button, Checkbox, makeStyles, mergeClasses, Spinner, Text } from "@fluentui/react-components";
import { CalendarLtr20Regular, CheckboxChecked20Regular, ChevronRight20Regular, ClipboardTask20Regular, Lightbulb20Regular, MailMultiple20Regular, ShieldCheckmark20Regular, Warning20Regular, Warning24Filled } from "@fluentui/react-icons";
import type { EmailContext, SuggestedAction, ThreadContext, ThreadSynthesis } from "@oao/shared";
import { useState } from "react";
import { useApp } from "@/app/AppContext";
import type { AsyncState } from "@/app/useAsync";
import { useMediaQuery } from "@/app/useMediaQuery";
import { formatDate, useI18n } from "@/i18n";
import { AiFooter, BulletList, ConfidenceBar, ErrorState, SectionCard, SeverityDot, Skeleton, colors, useErrorMessage, useToast } from "@/ui";
import { ActionApprovalDialog } from "@/features/actions/ActionApprovalDialog";
import { actionIcon } from "@/features/actions/actionIcons";
import { runDraftReply } from "@/features/actions/actionRunner";

const useStyles = makeStyles({
  grid: { display: "grid", gridTemplateColumns: "1fr", gap: "10px" },
  gridWide: { gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)" },
  col: { display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 },
  missing: { display: "flex", gap: "8px", alignItems: "flex-start" },
  task: { display: "flex", alignItems: "flex-start", gap: "6px", padding: "6px 8px", borderRadius: "6px" },
  taskCritical: { backgroundColor: colors.mediumBg },
  taskTitle: { fontSize: "13px" },
  taskMeta: { color: colors.textSecondary, fontSize: "12px" },
  deadline: { color: colors.red, fontWeight: 600, fontSize: "13px" },
  deadlineSub: { color: colors.textSecondary, fontSize: "12px" },
  actionCard: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", border: `1px solid ${colors.border}`, borderRadius: "8px", backgroundColor: colors.card, cursor: "pointer", textAlign: "left", width: "100%", fontFamily: "inherit" },
  actionText: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  sources: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", color: colors.primary, fontSize: "13px", background: "none", border: "none", padding: 0, fontFamily: "inherit" },
  sourceList: { margin: "6px 0 0", paddingLeft: "16px", fontSize: "12px", color: colors.textSecondary, display: "flex", flexDirection: "column", gap: "2px" },
});

export interface ThreadViewProps {
  email: EmailContext;
  thread: ThreadContext | null;
  state: AsyncState<ThreadSynthesis>;
}

export function ThreadView({ email, thread, state }: ThreadViewProps) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const wide = useMediaQuery("(min-width: 480px)");
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; filter?: SuggestedAction["type"] }>({ open: false });
  const [showSources, setShowSources] = useState(false);

  const syn = state.data;
  if (state.loading && !syn) return <Skeleton cards={4} label={t("thread.synthesizing")} />;
  if (state.error && !syn) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!syn) return null;

  const followUp = async (instructions: string, key: string) => {
    setBusy(key);
    try {
      const out = await runDraftReply({ api, email, thread: thread ?? undefined, intent: "follow_up", instructions, lang });
      if (out.status === "executed") toast.success(t("summary.draftOpened"));
      else if (out.message) toast.info(out.message);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const onAction = (action: SuggestedAction) => {
    if (action.type === "draft_reply" || action.type === "request_document") {
      const doc = syn.missingDocuments[0]?.name;
      void followUp(doc ? `${action.title}: ${doc}` : action.title, action.type);
      return;
    }
    if (action.type === "notify") {
      const text = [syn.executiveSummary, "", ...syn.openTasks.map((o) => `- ${o.title}${o.owner ? ` (${o.owner})` : ""}`)].join("\n");
      void navigator.clipboard?.writeText(text).then(() => toast.success(t("thread.shareCopied"))).catch(() => undefined);
      return;
    }
    setDialog({ open: true, filter: action.type });
  };

  const left = (
    <div className={s.col}>
      <SectionCard icon={<ShieldCheckmark20Regular />} title={t("thread.executiveSummary")}>
        {syn.executiveSummary}
      </SectionCard>

      {syn.missingDocuments.map((d) => (
        <SectionCard key={d.name} tint="amber" testId="missing-document">
          <div className={s.missing}>
            <Warning24Filled style={{ color: "#C19C00", flexShrink: 0 }} />
            <div style={{ flexGrow: 1 }}>
              <div style={{ fontWeight: 600 }}>{t("thread.missingDocument", { name: d.name })}</div>
              {d.requestedOn && <div style={{ color: colors.textSecondary, fontSize: "12px" }}>{t("thread.requestedOn", { date: formatDate(d.requestedOn, lang, false) })}</div>}
              <Button size="small" appearance="primary" style={{ marginTop: "8px" }} disabled={busy !== null} icon={busy === `doc:${d.name}` ? <Spinner size="extra-tiny" /> : undefined} onClick={() => void followUp(`${t("thread.requestDocument")}: ${d.name}`, `doc:${d.name}`)}>
                {t("thread.requestDocument")}
              </Button>
            </div>
          </div>
        </SectionCard>
      ))}

      <SectionCard icon={<CheckboxChecked20Regular />} iconColor={colors.lowText} iconBg={colors.lowBg} title={t("thread.decisions")}>
        <BulletList items={syn.decisions} empty={t("summary.noDecisions")} />
      </SectionCard>

      <SectionCard icon={<ClipboardTask20Regular />} iconColor="#8A6D00" iconBg={colors.mediumBg} title={t("thread.openTasks")}>
        {syn.openTasks.map((task) => (
          <div key={task.title} className={mergeClasses(s.task, task.critical && s.taskCritical)}>
            <Checkbox checked={task.done} readOnly size="medium" aria-label={task.title} />
            <div>
              <div className={s.taskTitle} style={{ fontWeight: task.critical ? 600 : 400 }}>
                {task.title}
              </div>
              <div className={s.taskMeta}>
                {task.owner ? `${t("thread.owner")}: ${task.owner}` : ""}
                {task.owner ? " · " : ""}
                {t("thread.priority")}: {t(`risk.${task.priority}`)}
              </div>
            </div>
          </div>
        ))}
      </SectionCard>

      <SectionCard icon={<CalendarLtr20Regular />} iconColor={colors.red} iconBg={colors.highBg} title={t("thread.deadlines")}>
        {syn.deadlines.map((d, i) => (
          <div key={i} style={{ marginBottom: "4px" }}>
            <div className={d.atRisk ? s.deadline : s.taskTitle}>
              {d.title}
              {d.description ? `: ${d.description}` : d.date ? `: ${formatDate(d.date, lang, false)}` : ""}
            </div>
          </div>
        ))}
      </SectionCard>

      <SectionCard icon={<Warning20Regular />} iconColor={colors.red} iconBg={colors.highBg} title={t("thread.potentialRisks")}>
        <BulletList
          items={syn.risks.map((r) => (
            <span key={r.code} style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}>
              <SeverityDot level={r.severity} /> {r.title}
            </span>
          ))}
          empty={t("summary.noRisks")}
        />
      </SectionCard>
    </div>
  );

  const right = (
    <div className={s.col}>
      <SectionCard icon={<Lightbulb20Regular />} title={t("thread.recommendedActions")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {syn.recommendedActions.map((a) => (
            <button key={a.title} type="button" className={s.actionCard} onClick={() => onAction(a)} disabled={busy !== null}>
              <span style={{ color: colors.primary, display: "inline-flex" }}>{actionIcon(a.type)}</span>
              <span className={s.actionText}>
                <Text weight="semibold" size={300}>
                  {a.title}
                </Text>
                <Text size={200} style={{ color: colors.textSecondary }}>
                  {a.description}
                </Text>
              </span>
              {busy === a.type ? <Spinner size="extra-tiny" /> : <ChevronRight20Regular style={{ color: colors.textSecondary }} />}
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard>
        <ConfidenceBar value={syn.confidence} />
      </SectionCard>

      <SectionCard icon={<MailMultiple20Regular />} title={t("thread.sourcesUsed")}>
        <button type="button" className={s.sources} onClick={() => setShowSources((v) => !v)} aria-expanded={showSources}>
          {t("thread.emailsInConversation", { count: syn.sources.length })} <ChevronRight20Regular style={{ transform: showSources ? "rotate(90deg)" : undefined }} />
        </button>
        {showSources && (
          <ol className={s.sourceList}>
            {syn.sources.map((src) => (
              <li key={src.emailId}>
                {src.subject}
                {src.from ? ` — ${src.from}` : ""}
                {src.date ? ` · ${formatDate(src.date, lang, false)}` : ""}
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      {syn.recommendedNextStep && (
        <SectionCard tint="blue" title={t("thread.recommendedNextStep")} icon={<Lightbulb20Regular />}>
          <div style={{ fontWeight: 600 }}>{syn.recommendedNextStep.title}</div>
          <div style={{ color: colors.textSecondary, fontSize: "12px", margin: "4px 0 8px" }}>{syn.recommendedNextStep.description}</div>
          <Button appearance="primary" size="small" disabled={busy !== null} icon={busy === "next" ? <Spinner size="extra-tiny" /> : undefined} onClick={() => void followUp(syn.recommendedNextStep!.title, "next")}>
            {syn.recommendedNextStep.action?.title ?? t("thread.recommendedNextStep")}
          </Button>
        </SectionCard>
      )}
    </div>
  );

  return (
    <div data-testid="thread-view" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div className={mergeClasses(s.grid, wide && s.gridWide)}>
        {left}
        {right}
      </div>
      <AiFooter auditId={syn.auditId} />
      {dialog.open && <ActionApprovalDialog open onClose={() => setDialog({ open: false })} email={email} thread={thread ?? undefined} filterType={dialog.filter} analysisAuditId={syn.auditId} />}
    </div>
  );
}
