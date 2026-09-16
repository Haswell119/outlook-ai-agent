/**
 * Compact layout for an email the backend triaged as not worth a model call:
 * a newsletter, a system notification, an out-of-office reply, a calendar
 * message…
 *
 * One line of summary, the triage reason, and a single explicit escape hatch:
 * "Analyse anyway", which is the only thing on this screen that spends a model
 * call. Everything else (decisions, tasks, risks, suggested actions) is hidden,
 * because for this class of mail it is noise — and rendering four empty cards is
 * exactly the kind of thing that makes an assistant feel slow and dumb.
 */
import { Button, makeStyles, Spinner, Text } from "@fluentui/react-components";
import { CalendarLtr20Regular, MailInbox20Regular, News20Regular, PersonAvailable20Regular, Sparkle16Regular, Alert20Regular } from "@fluentui/react-icons";
import type { EmailAnalysis } from "@oao/shared";
import type { ReactElement } from "react";
import { useI18n } from "@/i18n";
import { SectionCard, SourceBadge, colors, type DisplaySource } from "@/ui";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  summary: { fontSize: "13px", lineHeight: "18px", color: colors.text },
  reason: { fontSize: "12px", lineHeight: "16px", color: colors.textSecondary },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px" },
});

const KIND_ICONS: Record<string, ReactElement> = {
  newsletter: <News20Regular />,
  notification: <Alert20Regular />,
  out_of_office: <PersonAvailable20Regular />,
  automatic: <MailInbox20Regular />,
  calendar: <CalendarLtr20Regular />,
  trivial: <MailInbox20Regular />,
  conversation: <MailInbox20Regular />,
};

export interface TriageCardProps {
  analysis: EmailAnalysis;
  source: DisplaySource | undefined;
  ageMs?: number;
  busy?: boolean;
  /**
   * The user pressed "Analyse anyway" and the orchestrator *still* answered with
   * its triage rules. Saying so is the difference between an honest answer and a
   * button that looks broken: the triage decision is taken server-side from the
   * policy, so pressing it again will not change anything.
   */
  stillTriaged?: boolean;
  onAnalyseAnyway: () => void;
}

export function TriageCard({ analysis, source, ageMs, busy, stillTriaged, onAnalyseAnyway }: TriageCardProps) {
  const s = useStyles();
  const { t } = useI18n();
  const kind = analysis.triage?.kind ?? "trivial";
  const kindLabel = t(`triage.kind.${kind}`);

  return (
    <div className={s.stack} data-testid="triage-card" data-kind={kind}>
      <SectionCard
        icon={KIND_ICONS[kind] ?? KIND_ICONS.trivial}
        iconColor={colors.textSecondary}
        iconBg={colors.background}
        title={kindLabel}
        actions={<SourceBadge source={source} ageMs={ageMs} />}
        testId="triage-summary"
      >
        <Text className={s.summary} block>
          {analysis.summary}
        </Text>
        {analysis.triage?.reason && (
          <Text className={s.reason} block style={{ marginTop: "4px" }}>
            {t("triage.reason", { reason: analysis.triage.reason })}
          </Text>
        )}
        <div className={s.actions}>
          <Button
            appearance="outline"
            size="small"
            icon={busy ? <Spinner size="extra-tiny" /> : <Sparkle16Regular />}
            onClick={onAnalyseAnyway}
            disabled={busy || stillTriaged}
            data-testid="analyse-anyway"
          >
            {t("triage.analyseAnyway")}
          </Button>
        </div>
        {stillTriaged && !busy && (
          <Text className={s.reason} block style={{ marginTop: "6px" }} data-testid="triage-still-triaged">
            {t("triage.stillTriaged")}
          </Text>
        )}
        <Text className={s.reason} block style={{ marginTop: "6px" }}>
          {t("triage.savesModel")}
        </Text>
      </SectionCard>
    </div>
  );
}
