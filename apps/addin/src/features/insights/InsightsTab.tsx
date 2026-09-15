import { Button, makeStyles, Text } from "@fluentui/react-components";
import { Open16Regular, ShieldError20Regular, Tag20Regular, Translate20Regular } from "@fluentui/react-icons";
import type { EmailAnalysis, EmailContext } from "@oao/shared";
import { useApp } from "@/app/AppContext";
import { formatDate, useI18n } from "@/i18n";
import { BulletList, ConfidenceBar, RiskBadge, SectionCard, Skeleton, SourceBadge, colors, type DisplaySource } from "@/ui";
import { AutomationCoach } from "@/features/automation/AutomationCoach";
import { SyncStatusPill } from "./SyncStatusPill";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px", alignItems: "center" },
  k: { color: colors.textSecondary },
  mono: { fontFamily: "Consolas, monospace", fontSize: "11px", wordBreak: "break-all" },
});

export function InsightsTab({
  analysis,
  loading,
  source,
}: {
  email: EmailContext;
  analysis: EmailAnalysis | null;
  loading: boolean;
  source?: DisplaySource;
}) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { adminUrl } = useApp();

  const verdictLevel = analysis?.phishing?.verdict === "likely_phishing" ? "high" : analysis?.phishing?.verdict === "suspicious" ? "medium" : "low";
  const verdictLabel = analysis?.phishing?.verdict === "likely_phishing" ? t("insights.verdictLikely") : analysis?.phishing?.verdict === "suspicious" ? t("insights.verdictSuspicious") : t("insights.verdictClean");

  return (
    <div className={s.stack} data-testid="insights-tab">
      {/* Precomputation status first: it explains why the pane was instant. */}
      <SyncStatusPill />

      {loading && !analysis && <Skeleton cards={2} />}
      {analysis && (
        <>
          <SectionCard icon={<Tag20Regular />} title={t("insights.classification")}>
            <div className={s.kv}>
              <span className={s.k}>{t("insights.category")}</span>
              <span style={{ fontWeight: 600 }}>{analysis.classification?.category ?? "—"}</span>
            </div>
            {analysis.classification && <ConfidenceBar value={analysis.classification.confidence} label={t("insights.confidence")} />}
          </SectionCard>

          <SectionCard icon={<ShieldError20Regular />} iconColor={colors.red} iconBg={colors.highBg} title={t("insights.phishing")}>
            <div className={s.kv} style={{ marginBottom: "6px" }}>
              <span className={s.k}>{t("insights.verdict")}</span>
              <span>
                <RiskBadge level={verdictLevel} /> <Text size={200}>{verdictLabel}</Text>
              </span>
              {analysis.phishing && (
                <>
                  <span className={s.k}>Score</span>
                  <span>{Math.round(analysis.phishing.score * 100)}%</span>
                </>
              )}
            </div>
            <Text size={200} weight="semibold" style={{ display: "block", marginBottom: "4px" }}>
              {t("insights.indicators")}
            </Text>
            <BulletList items={analysis.phishing?.indicators ?? []} empty={t("insights.noIndicators")} />
          </SectionCard>

          <SectionCard icon={<Translate20Regular />} title={t("insights.details")} actions={<SourceBadge source={source ?? (analysis.source as DisplaySource | undefined)} />}>
            <div className={s.kv}>
              <span className={s.k}>{t("insights.language")}</span>
              <span>{analysis.language.toUpperCase()}</span>
              <span className={s.k}>{t("insights.model")}</span>
              <span>{analysis.model ?? "—"}</span>
              <span className={s.k}>{t("insights.source")}</span>
              <span data-testid="insights-source">{t(`source.${source ?? analysis.source ?? "llm"}`)}</span>
              {analysis.triage && (
                <>
                  <span className={s.k}>{t("insights.triage")}</span>
                  <span>{t(`triage.kind.${analysis.triage.kind}`)}</span>
                </>
              )}
              <span className={s.k}>{t("insights.auditId")}</span>
              <span className={s.mono}>{analysis.auditId}</span>
              <span className={s.k}>{t("insights.generatedAt")}</span>
              <span>{formatDate(analysis.generatedAt, lang)}</span>
            </div>
            <Button
              as="a"
              size="small"
              appearance="outline"
              icon={<Open16Regular />}
              iconPosition="after"
              href={`${adminUrl}/audit?search=${encodeURIComponent(analysis.auditId)}`}
              target="_blank"
              rel="noopener"
              style={{ marginTop: "8px" }}
            >
              {t("insights.viewAuditLog")}
            </Button>
          </SectionCard>
        </>
      )}

      <AutomationCoach />
    </div>
  );
}
