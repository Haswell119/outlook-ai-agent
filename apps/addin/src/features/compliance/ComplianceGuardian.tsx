import { Button, Link, makeStyles, Spinner, Text } from "@fluentui/react-components";
import { ArrowSync20Regular, CheckmarkCircle20Filled, ChevronRight20Regular, Info16Regular, ShieldCheckmark24Regular, Warning24Filled } from "@fluentui/react-icons";
import type { ComplianceCheckResponse, ComplianceIssue, ComposeContext, SuggestedAction } from "@oao/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/app/AppContext";
import { Header } from "@/app/Header";
import { useI18n } from "@/i18n";
import { executeClientAction } from "@/office/actions";
import { onComposeChanged, readCompose } from "@/office/readCompose";
import { clearComplianceBanner, showComplianceBanner } from "@/office/notifications";
import { composeContentHash } from "@/util/hash";
import { track } from "@/telemetry";
import { ConfidenceBar, ErrorState, RiskBadge, SectionCard, Skeleton, colors, useErrorMessage, useToast } from "@/ui";
import { actionIcon } from "@/features/actions/actionIcons";

const useStyles = makeStyles({
  content: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px" },
  titleRow: { display: "flex", alignItems: "center", gap: "8px" },
  title: { fontWeight: 600, fontSize: "15px", flexGrow: 1 },
  headline: { display: "flex", gap: "8px", alignItems: "flex-start" },
  headlineTitle: { fontWeight: 600, fontSize: "14px" },
  headlineSub: { color: colors.textSecondary, fontSize: "12px" },
  row: { display: "flex", alignItems: "flex-start", gap: "10px", padding: "8px 0", borderTop: `1px solid ${colors.border}` },
  rowFirst: { borderTop: "none", paddingTop: 0 },
  rowIcon: { color: colors.primary, display: "inline-flex", flexShrink: 0, marginTop: "1px" },
  rowText: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  rowTitle: { fontWeight: 600, fontSize: "13px" },
  rowSub: { color: colors.textSecondary, fontSize: "12px", wordBreak: "break-word" },
  actionBtn: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0", borderTop: `1px solid ${colors.border}`, width: "100%", background: "none", border: "none", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: colors.text },
  help: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", color: colors.textSecondary, flexWrap: "wrap", gap: "6px" },
  footer: { display: "flex", alignItems: "center", gap: "8px" },
});

export function ComplianceIssueRow({ issue, first }: { issue: ComplianceIssue; first?: boolean }) {
  const s = useStyles();
  return (
    <div className={`${s.row} ${first ? s.rowFirst : ""}`} data-testid="compliance-issue" data-severity={issue.severity}>
      <span className={s.rowIcon} style={{ color: issue.severity === "high" ? colors.red : issue.severity === "medium" ? "#C19C00" : colors.lowText }}>
        <Warning24Filled />
      </span>
      <span className={s.rowText}>
        <Text className={s.rowTitle}>{issue.title}</Text>
        <Text className={s.rowSub}>{issue.description}</Text>
      </span>
      <RiskBadge level={issue.severity} />
    </div>
  );
}

export function ComplianceGuardian() {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api, complianceEmail, preview } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const [draft, setDraft] = useState<ComposeContext | null>(null);
  const [result, setResult] = useState<ComplianceCheckResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const runId = useRef(0);
  /** Hash of the draft the last check ran on — re-checking identical content
   *  would cost a model call for a guaranteed-identical answer. */
  const lastHash = useRef<string | null>(null);

  const check = useCallback(
    async (opts: { force?: boolean } = {}) => {
      const my = ++runId.current;
      setError(null);
      try {
        const d = await readCompose();
        if (my !== runId.current) return;
        setDraft(d);

        // Nothing changed since the previous check (the debounce fired because
        // the user clicked in and out of a field) → keep the current verdict.
        const hash = composeContentHash(d);
        if (!opts.force && lastHash.current === hash) {
          track("compliance.skipped", { reason: "unchanged" });
          setLoading(false);
          return;
        }

        setLoading(true);
        const r = await api.complianceCheck({ draft: d, language: lang });
        if (my !== runId.current) return;
        lastHash.current = hash;
        setResult(r);
        track("compliance.checked", { verdict: r.verdict, issues: r.issues.length });

        // Mock-up E: the banner inside the compose window itself.
        void showComplianceBanner({
          lang,
          issueCount: r.issues.length,
          highestSeverity: r.issues.some((i) => i.severity === "high") ? "high" : r.issues.some((i) => i.severity === "medium") ? "medium" : r.issues[0]?.severity ?? null,
          verdict: r.verdict,
        }).catch(() => undefined);
      } catch (e) {
        if (my === runId.current) setError(e);
      } finally {
        if (my === runId.current) setLoading(false);
      }
    },
    [api, lang],
  );

  // Auto-run on load; re-run (1.5 s debounce) when recipients or attachments
  // change — and skip the call entirely when the content hash is unchanged.
  useEffect(() => {
    void check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onComposeChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void check(), 1500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
      void clearComplianceBanner();
    };
  }, [check]);

  const onAction = async (action: SuggestedAction) => {
    setBusy(action.type);
    try {
      switch (action.type) {
        case "apply_label": {
          const out = await executeClientAction({ operation: "applyLabel", parameters: { label: "Confidential", ...action.parameters } }, lang);
          if (out.message) (out.status === "executed" ? toast.success : toast.info)(out.message);
          break;
        }
        case "remove_attachment": {
          const out = await executeClientAction({ operation: "removeAttachment", parameters: action.parameters }, lang);
          if (out.message) (out.status === "executed" ? toast.success : out.status === "failed" ? toast.error : toast.info)(out.message);
          if (out.status === "executed") void check({ force: true });
          break;
        }
        case "request_approval":
        case "escalate_compliance": {
          const esc = await api.createEscalation({ reason: action.title, draft: draft ?? undefined, issues: result?.issues ?? [] });
          toast.success(t("compliance.escalationSent", { id: esc.id }));
          break;
        }
        default: {
          const out = await executeClientAction({ operation: action.type, parameters: action.parameters }, lang);
          if (out.message) toast.info(out.message);
        }
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const issues = result?.issues ?? [];
  const count = issues.length;

  return (
    <>
      <Header subtitle={t("app.complianceGuardian")} />
      <div className={s.content} data-testid="compliance-guardian">
        <div className={s.titleRow}>
          <ShieldCheckmark24Regular style={{ color: colors.primary }} />
          <Text className={s.title}>{t("compliance.title")}</Text>
          <Button size="small" appearance="subtle" icon={loading ? <Spinner size="extra-tiny" /> : <ArrowSync20Regular />} onClick={() => void check({ force: true })} disabled={loading} data-testid="recheck">
            {t("compliance.recheck")}
          </Button>
        </div>

        {loading && !result && <Skeleton cards={2} label={t("compliance.checking")} />}
        {!!error && !result && <ErrorState error={error} onRetry={() => void check({ force: true })} />}

        {result && (
          <>
            <SectionCard tint={count ? "red" : "green"} testId="compliance-headline">
              <div className={s.headline}>
                {count ? <Warning24Filled style={{ color: colors.red, flexShrink: 0 }} /> : <CheckmarkCircle20Filled style={{ color: colors.lowText, flexShrink: 0 }} />}
                <div>
                  <div className={s.headlineTitle}>{count === 0 ? t("compliance.noIssues") : count === 1 ? t("compliance.oneIssueDetected") : t("compliance.issuesDetected", { count })}</div>
                  <div className={s.headlineSub}>{count ? t("compliance.addressIssues") : t("compliance.noIssuesHint")}</div>
                </div>
              </div>
            </SectionCard>

            {count > 0 && (
              <SectionCard title={t("compliance.riskSummary")} actions={<Text size={200} style={{ color: colors.textSecondary }}>{t(`compliance.verdict.${result.verdict}`)}</Text>}>
                {issues.map((issue, i) => (
                  <ComplianceIssueRow key={issue.id} issue={issue} first={i === 0} />
                ))}
              </SectionCard>
            )}

            {result.recommendedActions.length > 0 && (
              <SectionCard title={t("compliance.recommendedActions")}>
                {result.recommendedActions.map((a, i) => (
                  <button key={`${a.type}-${i}`} type="button" className={s.actionBtn} style={i === 0 ? { borderTop: "none", paddingTop: 0 } : undefined} onClick={() => void onAction(a)} disabled={busy !== null}>
                    <span className={s.rowIcon}>{actionIcon(a.type)}</span>
                    <span className={s.rowText}>
                      <Text className={s.rowTitle}>{a.title}</Text>
                      <Text className={s.rowSub}>{a.description}</Text>
                    </span>
                    {busy === a.type ? <Spinner size="extra-tiny" /> : <ChevronRight20Regular style={{ color: colors.textSecondary }} />}
                  </button>
                ))}
              </SectionCard>
            )}

            <div className={s.help}>
              <span>{t("compliance.needHelp")}</span>
              <Link href={`mailto:${complianceEmail}?subject=${encodeURIComponent(`[Compliance Guardian] ${draft?.subject ?? ""}`)}`}>{t("compliance.contactCompliance")}</Link>
            </div>

            <div className={s.footer}>
              <ConfidenceBar value={result.confidence} info={preview ? t("app.previewMode") : result.auditId} />
              <Link href={`mailto:${complianceEmail}`} style={{ fontSize: "12px", whiteSpace: "nowrap" }}>
                {t("compliance.learnMore")} <Info16Regular style={{ verticalAlign: "-3px" }} />
              </Link>
            </div>
          </>
        )}
      </div>
    </>
  );
}
