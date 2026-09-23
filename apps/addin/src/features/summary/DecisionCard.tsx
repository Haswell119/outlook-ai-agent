/**
 * Structured decisions (local decision engine, e.g. Laya) — urgency, business
 * area, suggested folder, reply expected, action required.
 *
 * Entirely optional: `analysis.decisioning` is absent when the engine is
 * disabled or runs in shadow mode, and the card then renders nothing. Only the
 * decisions that passed the confidence policy are present; `lowConfidence`
 * says at least one was set aside, and the card says so rather than guessing.
 *
 * A suggested folder is only a suggestion: filing the email goes through the
 * usual "Suggested actions" → approval dialog. Nothing here moves anything.
 *
 * Where each decision came from (engine, taxonomy, fallback), the checkpoint and
 * the taxonomy version are support details: shown in diagnostic mode only
 * (Settings → Diagnostics).
 */
import { makeStyles, mergeClasses, Text } from "@fluentui/react-components";
import { Info16Regular, TaskListSquareLtr20Regular } from "@fluentui/react-icons";
import type { EmailDecisioning, UrgencyLevel } from "@oao/shared";
import { useEffect, useState, type ReactNode } from "react";
import { loadSettings, onSettingsChange } from "@/app/settings";
import { useI18n } from "@/i18n";
import { toPlainText } from "@/security/sanitize";
import { SectionCard, colors } from "@/ui";

const useStyles = makeStyles({
  grid: { display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "6px 10px", alignItems: "baseline", fontSize: "12px" },
  k: { color: colors.textSecondary, whiteSpace: "nowrap" },
  v: { color: colors.text, fontWeight: 600, overflowWrap: "anywhere", minWidth: 0 },
  pct: { color: colors.textSecondary, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textAlign: "right" },
  level: { display: "inline-flex", paddingBlock: "1px", paddingInline: "7px", borderRadius: "10px", fontSize: "11px", fontWeight: 600, lineHeight: "16px" },
  low: { backgroundColor: colors.lowBg, color: colors.lowText },
  normal: { backgroundColor: colors.background, color: colors.textSecondary, border: `1px solid ${colors.border}` },
  high: { backgroundColor: colors.mediumBg, color: colors.mediumText },
  critical: { backgroundColor: colors.highBg, color: colors.highText },
  note: { display: "flex", gap: "6px", alignItems: "flex-start", fontSize: "12px", lineHeight: "16px", color: colors.text, marginTop: "8px" },
  hint: { fontSize: "12px", lineHeight: "16px", color: colors.textSecondary, marginTop: "6px" },
  diag: { marginTop: "8px", paddingTop: "8px", borderTop: `1px dashed ${colors.border}`, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", fontSize: "11px" },
});

/** Reads the diagnostic-mode preference and follows its changes. */
function useDiagnostics(): boolean {
  const [on, setOn] = useState(() => loadSettings().diagnostics);
  useEffect(() => onSettingsChange((s) => setOn(s.diagnostics)), []);
  return on;
}

const pct = (confidence: number) => `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`;

export interface DecisionCardProps {
  decisioning: EmailDecisioning | undefined;
}

export function DecisionCard({ decisioning: d }: DecisionCardProps) {
  const s = useStyles();
  const { t } = useI18n();
  const diagnostics = useDiagnostics();
  // Shadow decisions are never shown to the user (the backend does not send them; belt and braces).
  if (!d || d.mode !== "active") return null;

  const rows: Array<{ key: string; label: string; value: ReactNode; confidence: number }> = [];
  // Confidence = the engine's own certainty over the options it was given (not a probability of being right).
  if (d.urgency) {
    const level: UrgencyLevel = d.urgency.level;
    rows.push({
      key: "urgency",
      label: t("decision.urgency"),
      value: (
        <span className={mergeClasses(s.level, s[level])} data-testid="decision-urgency-level" data-level={level}>
          {t(`decision.level.${level}`)}
        </span>
      ),
      confidence: d.urgency.confidence,
    });
  }
  if (d.businessArea) rows.push({ key: "area", label: t("decision.businessArea"), value: toPlainText(d.businessArea.label, 120), confidence: d.businessArea.confidence });
  if (d.suggestedFolder) rows.push({ key: "folder", label: t("decision.suggestedFolder"), value: toPlainText(d.suggestedFolder.displayName, 160), confidence: d.suggestedFolder.confidence });
  if (d.replyExpected) rows.push({ key: "reply", label: t("decision.replyExpected"), value: t(d.replyExpected.value ? "decision.yes" : "decision.no"), confidence: d.replyExpected.confidence });
  if (d.actionRequired) rows.push({ key: "action", label: t("decision.actionRequired"), value: t(d.actionRequired.value ? "decision.yes" : "decision.no"), confidence: d.actionRequired.confidence });

  // Nothing decided (engine unavailable, every answer set aside): only support staff need to know.
  if (rows.length === 0 && !diagnostics) return null;

  return (
    <SectionCard icon={<TaskListSquareLtr20Regular />} title={t("decision.title")} testId="decision-card">
      {rows.length > 0 && (
        <div className={s.grid}>
          {rows.map((r) => (
            <Row key={r.key} id={r.key} label={r.label} value={r.value} confidenceLabel={t("decision.confidence", { pct: pct(r.confidence) })} styles={s} />
          ))}
        </div>
      )}
      {d.lowConfidence && (
        <div className={s.note} role="note" data-testid="decision-low-confidence">
          <Info16Regular style={{ color: colors.mediumDot, flexShrink: 0, marginTop: "1px" }} aria-hidden="true" />
          <span>{t("decision.lowConfidence")}</span>
        </div>
      )}
      {d.suggestedFolder && <Text className={s.hint} block>{t("decision.folderHint")}</Text>}
      {diagnostics && (
        <div className={s.diag} data-testid="decision-diagnostics">
          <span className={s.k}>{t("decision.source")}</span>
          <span data-testid="decision-source">{t(`decision.sourceValue.${d.source}`)}</span>
          {d.suggestedFolder?.source && (
            <>
              <span className={s.k}>{t("decision.folderSource")}</span>
              <span>{t(`decision.sourceValue.${d.suggestedFolder.source}`)}</span>
            </>
          )}
          {d.degraded && (
            <>
              <span className={s.k}>{t("decision.state")}</span>
              <span>{t("decision.degraded")}</span>
            </>
          )}
          {d.fallbackReason && (
            <>
              <span className={s.k}>{t("decision.fallbackReason")}</span>
              <span>{toPlainText(d.fallbackReason, 64)}</span>
            </>
          )}
          {d.model && (
            <>
              <span className={s.k}>{t("decision.model")}</span>
              <span>{toPlainText(d.model, 64)}</span>
            </>
          )}
          <span className={s.k}>{t("decision.versions")}</span>
          <span>
            {toPlainText(d.decisionVersion, 32)}
            {d.taxonomyVersion ? ` · ${t("decision.taxonomy")} ${toPlainText(d.taxonomyVersion, 32)}` : ""}
          </span>
        </div>
      )}
    </SectionCard>
  );
}

function Row({ id, label, value, confidenceLabel, styles: s }: { id: string; label: string; value: ReactNode; confidenceLabel: string; styles: ReturnType<typeof useStyles> }) {
  return (
    <>
      <span className={s.k}>{label}</span>
      <span className={s.v} data-testid={`decision-${id}`}>
        {value}
      </span>
      <span className={s.pct} data-testid={`decision-${id}-confidence`}>
        {confidenceLabel}
      </span>
    </>
  );
}
