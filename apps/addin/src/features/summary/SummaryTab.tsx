import { Button, makeStyles, Spinner, Text } from "@fluentui/react-components";
import { Add16Regular, ArrowSync16Regular, CheckboxChecked20Regular, ClipboardTask20Regular, DocumentBulletList20Regular, Lightbulb20Regular, Warning20Regular, Warning24Filled } from "@fluentui/react-icons";
import type { ActionType, EmailContext, SuggestedAction } from "@oao/shared";
import { Suspense, useState } from "react";
import { useApp } from "@/app/AppContext";
import { useI18n } from "@/i18n";
import { toPlainText } from "@/security/sanitize";
import { AiFooter, BulletList, EmptyState, ErrorState, SectionCard, SeverityDot, Skeleton, SourceBadge, colors, useErrorMessage, useToast } from "@/ui";
import { LazyActionApprovalDialog, prefetchApproval } from "@/features/lazy";
import { actionIcon } from "@/features/actions/actionIcons";
import { runDraftReply } from "@/features/actions/actionRunner";
import { TriageCard } from "./TriageCard";
import { isCompactTriage, isDegraded, isEmptyAnalysis, type AnalysisState } from "./useAnalysis";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  degraded: {
    backgroundColor: colors.amberBg,
    border: `1px solid ${colors.amberBorder}`,
    borderRadius: "8px",
    paddingBlock: "8px",
    paddingInline: "10px",
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
    color: colors.text,
  },
  degradedBody: { display: "flex", flexDirection: "column", gap: "6px", minWidth: 0, flexGrow: 1 },
  phishing: {
    backgroundColor: colors.highBg,
    border: `1px solid ${colors.highBorder}`,
    borderRadius: "8px",
    paddingBlock: "10px",
    paddingInline: "12px",
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
    color: colors.text,
  },
  riskRow: { display: "flex", alignItems: "flex-start", gap: "8px" },
  actionRow: { display: "flex", alignItems: "center", gap: "10px", paddingBlock: "8px", borderTop: `1px solid ${colors.border}` },
  actionIcon: { color: colors.primary, display: "inline-flex", flexShrink: 0 },
  actionText: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  actionTitle: { fontWeight: 600, fontSize: "13px" },
  actionSub: { color: colors.textSecondary, fontSize: "12px" },
  chips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  chip: { borderRadius: "14px", fontSize: "12px", fontWeight: 400, height: "auto", paddingBlock: "4px", paddingInline: "10px", whiteSpace: "normal", textAlign: "start" },
  review: { width: "100%" },
});

export interface SummaryTabProps {
  email: EmailContext;
  state: AnalysisState;
}

export function SummaryTab({ email, state }: SummaryTabProps) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const [dialog, setDialog] = useState<{ open: boolean; filter?: ActionType }>({ open: false });
  const [busy, setBusy] = useState<string | null>(null);

  const a = state.data;

  const draft = async (intent: "acknowledge" | "custom", instructions?: string, key = "draft") => {
    setBusy(key);
    try {
      const out = await runDraftReply({ api, email, intent, instructions, lang });
      if (out.status === "executed") toast.success(t("summary.draftOpened"));
      else if (out.message) toast.info(out.message);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const onSuggested = (action: SuggestedAction) => {
    if (action.type === "draft_reply") {
      const intent = action.parameters.intent === "acknowledge" ? "acknowledge" : "custom";
      void draft(intent, undefined, action.type);
      return;
    }
    setDialog({ open: true, filter: action.type });
  };

  // Loading, named: the skeleton says *which* email is being analysed, so a slow
  // analysis can never be mistaken for the pane being stuck on the previous one.
  if (state.loading && !a) return <Skeleton cards={4} label={t("summary.analyzing")} />;
  if (state.error && !a) return <ErrorState error={state.error} onRetry={state.refresh} retrying={state.loading || state.revalidating} />;
  // No result, no error, not loading: say so instead of rendering an empty pane
  // (this is what "the Summary shows nothing" looked like).
  if (!a) {
    return (
      <EmptyState
        title={t("summary.emptyTitle")}
        description={t("summary.emptyBody")}
        action={
          <Button appearance="primary" size="small" icon={<ArrowSync16Regular />} onClick={state.refresh} data-testid="analyse-now">
            {t("summary.analyseNow")}
          </Button>
        }
      />
    );
  }

  // Newsletters, notifications, OOO replies… get the one-line layout and an
  // explicit opt-in to spend a model call.
  if (isCompactTriage(a)) {
    return (
      <TriageCard
        analysis={a}
        source={state.source}
        ageMs={state.ageMs}
        busy={state.revalidating}
        stillTriaged={state.forced}
        onAnalyseAnyway={state.analyseAnyway}
      />
    );
  }

  const phishing = a.phishing && a.phishing.verdict !== "clean" ? a.phishing : null;
  // `heuristic` + the `ai_output_unreliable` risk means the model failed and the
  // orchestrator answered with rules. That is worth a banner: the user must know
  // the answer is thinner than usual, and that Retry may now succeed.
  const degraded = isDegraded(a);
  const summaryText = toPlainText(a.summary, 2_000);
  const decisions = a.decisions ?? [];
  const pendingTasks = a.pendingTasks ?? [];
  const risks = a.risks ?? [];
  const suggestedActions = a.suggestedActions ?? [];
  const quickReplies = a.quickReplies ?? [];
  const actionsDisabled = busy !== null || state.revalidating;

  return (
    <div className={s.stack} data-testid="summary-tab" data-degraded={degraded ? "true" : "false"}>
      {degraded && (
        <div className={s.degraded} role="status" data-testid="degraded-banner">
          <Warning24Filled style={{ color: "#C19C00", flexShrink: 0 }} aria-hidden="true" />
          <div className={s.degradedBody}>
            <div style={{ fontWeight: 600 }}>{t("summary.degradedTitle")}</div>
            <div style={{ fontSize: "12px" }}>{t("summary.degradedBody")}</div>
            <div>
              <Button
                appearance="outline"
                size="small"
                icon={state.revalidating ? <Spinner size="extra-tiny" /> : <ArrowSync16Regular />}
                onClick={state.refresh}
                disabled={state.revalidating}
                data-testid="degraded-retry"
              >
                {t("app.retry")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {isEmptyAnalysis(a) && (
        <SectionCard tint="amber" testId="empty-analysis">
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <Text style={{ fontWeight: 600 }}>{t("summary.emptyResultTitle")}</Text>
            <Text size={200}>{t("summary.emptyResultBody")}</Text>
            <div>
              <Button appearance="outline" size="small" icon={<ArrowSync16Regular />} onClick={state.refresh} disabled={state.revalidating} data-testid="empty-retry">
                {t("app.retry")}
              </Button>
            </div>
          </div>
        </SectionCard>
      )}

      {phishing && (
        <div className={s.phishing} role="alert" data-testid="phishing-banner">
          <Warning24Filled style={{ color: colors.red, flexShrink: 0 }} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600 }}>{t("summary.phishingWarning")}</div>
            <div style={{ fontSize: "12px" }}>{t(phishing.verdict === "likely_phishing" ? "summary.phishingLikely" : "summary.phishingSuspicious", { score: Math.round(phishing.score * 100) })}</div>
          </div>
        </div>
      )}

      <SectionCard
        icon={<DocumentBulletList20Regular />}
        title={t("summary.summary")}
        actions={<SourceBadge source={state.source} ageMs={state.ageMs} />}
        testId="summary-card"
      >
        {summaryText || t("summary.noSummary")}
      </SectionCard>

      <SectionCard icon={<CheckboxChecked20Regular />} iconColor={colors.lowText} iconBg={colors.lowBg} title={t("summary.decisions")}>
        <BulletList items={decisions.map((d) => toPlainText(d, 500))} empty={t("summary.noDecisions")} />
      </SectionCard>

      <SectionCard icon={<ClipboardTask20Regular />} iconColor={colors.mediumText} iconBg={colors.mediumBg} title={t("summary.pendingTasks")}>
        <BulletList items={pendingTasks.map((p) => toPlainText(p, 500))} empty={t("summary.noTasks")} />
      </SectionCard>

      <SectionCard icon={<Warning20Regular />} iconColor={colors.red} iconBg={colors.highBg} title={t("summary.detectedRisks")}>
        <BulletList
          items={risks.map((r) => (
            <span className={s.riskRow} key={r.code}>
              <SeverityDot level={r.severity} />
              <span>
                {toPlainText(r.title, 300)}
                {r.description ? <span style={{ color: colors.textSecondary }}> — {toPlainText(r.description, 300)}</span> : null}
              </span>
            </span>
          ))}
          empty={t("summary.noRisks")}
        />
      </SectionCard>

      {suggestedActions.length > 0 && (
        <SectionCard icon={<Lightbulb20Regular />} title={t("summary.suggestedActions")} testId="suggested-actions">
          {suggestedActions.map((action, i) => (
            <div key={`${action.type}-${i}`} className={s.actionRow} style={i === 0 ? { borderTop: "none", paddingTop: 0 } : undefined}>
              <span className={s.actionIcon} aria-hidden="true">
                {actionIcon(action.type)}
              </span>
              <span className={s.actionText}>
                <Text className={s.actionTitle}>{action.title}</Text>
                <Text className={s.actionSub}>{action.description}</Text>
              </span>
              <Button
                size="small"
                appearance="outline"
                shape="circular"
                icon={busy === action.type ? <Spinner size="extra-tiny" /> : <Add16Regular />}
                aria-label={`${t("summary.addAction")}: ${action.title}`}
                onClick={() => onSuggested(action)}
                onMouseEnter={prefetchApproval}
                disabled={actionsDisabled}
              />
            </div>
          ))}
        </SectionCard>
      )}

      {quickReplies.length > 0 && (
        <SectionCard title={t("summary.quickReplies")}>
          <div className={s.chips} role="group" aria-label={t("summary.quickReplies")}>
            {quickReplies.map((q) => (
              <Button key={q} size="small" appearance="outline" className={s.chip} disabled={actionsDisabled} onClick={() => void draft("custom", q, `chip:${q}`)}>
                {busy === `chip:${q}` ? <Spinner size="extra-tiny" /> : q}
              </Button>
            ))}
          </div>
        </SectionCard>
      )}

      <Button appearance="primary" className={s.review} onClick={() => setDialog({ open: true })} onMouseEnter={prefetchApproval} disabled={actionsDisabled} data-testid="review-actions">
        {t("summary.reviewActions")}
      </Button>

      <AiFooter auditId={a.auditId} confidence={a.confidence} />

      {dialog.open && (
        <Suspense fallback={null}>
          <LazyActionApprovalDialog open onClose={() => setDialog({ open: false })} email={email} filterType={dialog.filter} analysisAuditId={a.auditId} />
        </Suspense>
      )}
    </div>
  );
}
