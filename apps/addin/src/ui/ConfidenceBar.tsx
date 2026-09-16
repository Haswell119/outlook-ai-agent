import { makeStyles, mergeClasses, ProgressBar, Text, Tooltip } from "@fluentui/react-components";
import { Info16Regular } from "@fluentui/react-icons";
import { useI18n } from "@/i18n";
import { colors } from "./theme";

const useStyles = makeStyles({
  root: { display: "flex", alignItems: "center", gap: "8px", width: "100%" },
  label: { color: colors.textSecondary, whiteSpace: "nowrap", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px" },
  bar: { flexGrow: 1 },
  value: { fontWeight: 600, fontSize: "12px", color: colors.text, minWidth: "34px", textAlign: "right" },
});

export interface ConfidenceBarProps {
  /** 0..1 */
  value: number;
  label?: string;
  className?: string;
  info?: string;
}

export function ConfidenceBar({ value, label, className, info }: ConfidenceBarProps) {
  const s = useStyles();
  const { t } = useI18n();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const color = pct >= 75 ? "success" : pct >= 40 ? "warning" : "error";
  return (
    <div className={mergeClasses(s.root, className)} role="group" aria-label={label ?? t("footer.confidence")}>
      <Text className={s.label}>
        {label ?? t("footer.confidence")}
        {info && (
          <Tooltip content={info} relationship="description">
            <Info16Regular />
          </Tooltip>
        )}
      </Text>
      <ProgressBar className={s.bar} value={pct / 100} thickness="large" color={color} aria-valuenow={pct} />
      <Text className={s.value} data-testid="confidence-value">
        {pct}%
      </Text>
    </div>
  );
}
