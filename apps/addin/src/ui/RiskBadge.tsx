import { makeStyles, mergeClasses } from "@fluentui/react-components";
import type { RiskLevel } from "@oao/shared";
import { useI18n } from "@/i18n";
import { colors } from "./theme";

const useStyles = makeStyles({
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    borderRadius: "10px",
    fontSize: "11px",
    fontWeight: 600,
    lineHeight: "16px",
    whiteSpace: "nowrap",
  },
  low: { backgroundColor: colors.lowBg, color: colors.lowText },
  medium: { backgroundColor: colors.mediumBg, color: colors.mediumText },
  high: { backgroundColor: colors.highBg, color: colors.highText },
  dot: { width: "8px", height: "8px", borderRadius: "50%", display: "inline-block", flexShrink: 0, marginTop: "5px" },
  dotLow: { backgroundColor: colors.lowText },
  dotMedium: { backgroundColor: colors.mediumDot },
  dotHigh: { backgroundColor: colors.highText },
});

export function RiskBadge({ level, className }: { level: RiskLevel; className?: string }) {
  const s = useStyles();
  const { t } = useI18n();
  return (
    <span className={mergeClasses(s.badge, s[level], className)} data-testid={`risk-badge-${level}`} data-level={level}>
      {t(`risk.${level}`)}
    </span>
  );
}

/** Small coloured severity dot (used in bullet lists). */
export function SeverityDot({ level }: { level: RiskLevel }) {
  const s = useStyles();
  const cls = level === "low" ? s.dotLow : level === "medium" ? s.dotMedium : s.dotHigh;
  return <span className={mergeClasses(s.dot, cls)} aria-label={level} title={level} />;
}
