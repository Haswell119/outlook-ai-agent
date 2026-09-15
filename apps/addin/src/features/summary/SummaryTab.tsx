import { Button, makeStyles, Spinner, Text } from "@fluentui/react-components";
import { Add16Regular, CheckboxChecked20Regular, ClipboardTask20Regular, DocumentBulletList20Regular, Lightbulb20Regular, Warning20Regular, Warning24Filled } from "@fluentui/react-icons";
import type { ActionType, EmailAnalysis, EmailContext, SuggestedAction } from "@oao/shared";
import { useState } from "react";
import { useApp } from "@/app/AppContext";
import type { AsyncState } from "@/app/useAsync";
import { useI18n } from "@/i18n";
import { AiFooter, BulletList, ErrorState, SectionCard, SeverityDot, Skeleton, colors, useErrorMessage, useToast } from "@/ui";
import { ActionApprovalDialog } from "@/features/actions/ActionApprovalDialog";
import { actionIcon } from "@/features/actions/actionIcons";
import { runDraftReply } from "@/features/actions/actionRunner";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  phishing: { backgroundColor: colors.highBg, border: `1px solid #F1BBC1`, borderRadius: "8px", padding: "10px 12px", display: "flex", gap: "8px", alignItems: "flex-start", color: colors.text },
  riskRow: { display: "flex", alignItems: "center", gap: "8px" },
  actionRow: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0", borderTop: `1px solid ${colors.border}` },
  actionIcon: { color: colors.primary, display: "inline-flex", flexShrink: 0 },
  actionText: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  actionTitle: { fontWeight: 600, fontSize: "13px" },
  actionSub: { color: colors.textSecondary, fontSize: "12px" },
  chips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  chip: { borderRadius: "14px", fontSize: "12px", fontWeight: 400, height: "auto", padding: "4px 10px", whiteSpace: "normal", textAlign: "left" },
  review: { width: "100%" },
});

export interface SummaryTabProps {
  email: EmailContext;
  state: AsyncState<EmailAnalysis>;
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

  if (state.loading && !a) return <Skeleton cards={4} label={t("summary.analyzing")} />;
  if (state.error && !a) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!a) return null;

  const phishing = a.phishing && a.phishing.verdict !== "clean" ? a.phishing : null;

  return (
    <div className={s.stack} data-testid="summary-tab">
      {phishing && (
        <div className={s.phishing} role="alert" data-testid="phishing-banner">
          <Warning24Filled style={{ color: colors.red, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600 }}>{t("summary.phishingWarning")}</div>
            <div style={{ fontSize: "12px" }}>{t(phishing.verdict === "likely_phishing" ? "summary.phishingLikely" : "summary.phishingSuspicious", { score: Math.round(phishing.score * 100) })}</div>
          </div>
        </div>
      )}

      <SectionCard icon={<DocumentBulletList20Regular />} title={t("summary.summary")}>
        {a.summary}
      </SectionCard>

      <SectionCard icon={<CheckboxChecked20Regular />} iconColor={colors.lowText} iconBg={colors.lowBg} title={t("summary.decisions")}>
        <BulletList items={a.decisions} empty={t("summary.noDecisions")} />
      </SectionCard>

      <SectionCard icon={<ClipboardTask20Regular />} iconColor="#8A6D00" iconBg={colors.mediumBg} title={t("summary.pendingTasks")}>
        <BulletList items={a.pendingTasks} empty={t("summary.noTasks")} />
      </SectionCard>

      <SectionCard icon={<Warning20Regular />} iconColor={colors.red} iconBg={colors.highBg} title={t("summary.detectedRisks")}>
        <BulletList
          items={a.risks.map((r) => (
            <span className={s.riskRow} key={r.code}>
              <SeverityDot level={r.severity} />
              <span>
                {r.title}
                {r.description ? <span style={{ color: colors.textSecondary }}> — {r.description}</span> : null}
              </span>
            </span>
          ))}
          empty={t("summary.noRisks")}
        />
      </SectionCard>

      {a.suggestedActions.length > 0 && (
        <SectionCard icon={<Lightbulb20Regular />} title={t("summary.suggestedActions")} testId="suggested-actions">
          {a.suggestedActions.map((action, i) => (
            <div key={`${action.type}-${i}`} className={s.actionRow} style={i === 0 ? { borderTop: "none", paddingTop: 0 } : undefined}>
              <span className={s.actionIcon}>{actionIcon(action.type)}</span>
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
                disabled={busy !== null}
              />
            </div>
          ))}
        </SectionCard>
      )}

      {a.quickReplies.length > 0 && (
        <SectionCard title={t("summary.quickReplies")}>
          <div className={s.chips}>
            {a.quickReplies.map((q) => (
              <Button key={q} size="small" appearance="outline" className={s.chip} disabled={busy !== null} onClick={() => void draft("custom", q, `chip:${q}`)}>
                {busy === `chip:${q}` ? <Spinner size="extra-tiny" /> : q}
              </Button>
            ))}
          </div>
        </SectionCard>
      )}

      <Button appearance="primary" className={s.review} onClick={() => setDialog({ open: true })} data-testid="review-actions">
        {t("summary.reviewActions")}
      </Button>

      <AiFooter auditId={a.auditId} confidence={a.confidence} />

      {dialog.open && <ActionApprovalDialog open onClose={() => setDialog({ open: false })} email={email} filterType={dialog.filter} analysisAuditId={a.auditId} />}
    </div>
  );
}
