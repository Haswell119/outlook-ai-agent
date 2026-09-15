/**
 * "Where did this answer come from?" — a deliberately quiet badge next to a
 * card title.
 *
 * It matters for two reasons: it tells the user the panel is not re-running a
 * model behind their back (trust), and it tells them a refresh *will* cost one
 * (control). The wording is neutral; the tooltip carries the detail.
 */
import { makeStyles, mergeClasses, Tooltip } from "@fluentui/react-components";
import { BrainSparkle16Regular, Clock16Regular, Database16Regular, Flash16Regular } from "@fluentui/react-icons";
import type { EmailAnalysis } from "@oao/shared";
import { useI18n } from "@/i18n";
import { colors } from "./theme";

export type AnalysisSource = NonNullable<EmailAnalysis["source"]>;
/** `local` = served from this device's IndexedDB cache, no request at all. */
export type DisplaySource = AnalysisSource | "local";

const useStyles = makeStyles({
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    paddingBlock: "1px",
    paddingInline: "7px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: 600,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  },
  instant: { backgroundColor: colors.lowBg, color: colors.lowText, border: `1px solid ${colors.lowBorder}` },
  model: { backgroundColor: colors.primaryTint, color: colors.primary, border: `1px solid ${colors.primaryBorder}` },
  heuristic: { backgroundColor: colors.background, color: colors.textSecondary, border: `1px solid ${colors.border}` },
  icon: { display: "inline-flex", flexShrink: 0 },
});

const ICONS: Record<DisplaySource, JSX.Element> = {
  precomputed: <Flash16Regular />,
  cache: <Database16Regular />,
  local: <Clock16Regular />,
  llm: <BrainSparkle16Regular />,
  heuristic: <BrainSparkle16Regular />,
};

export function SourceBadge({ source, ageMs, className }: { source: DisplaySource | undefined; ageMs?: number; className?: string }) {
  const s = useStyles();
  const { t } = useI18n();
  if (!source) return null;

  const tone = source === "precomputed" || source === "cache" || source === "local" ? s.instant : source === "heuristic" ? s.heuristic : s.model;
  const label = t(`source.${source}`);
  const tip = ageMs !== undefined && ageMs > 60_000 ? t("source.tipAge", { label: t(`source.tip.${source}`), age: humanAge(ageMs, t) }) : t(`source.tip.${source}`);

  return (
    <Tooltip content={tip} relationship="description" withArrow>
      <span className={mergeClasses(s.badge, tone, className)} data-testid="source-badge" data-source={source}>
        <span className={s.icon} aria-hidden="true">
          {ICONS[source]}
        </span>
        {label}
      </span>
    </Tooltip>
  );
}

function humanAge(ms: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("source.minutesAgo", { count: minutes });
  return t("source.hoursAgo", { count: Math.round(minutes / 60) });
}
