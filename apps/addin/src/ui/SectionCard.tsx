import { makeStyles, mergeClasses, Text } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { colors, radius } from "./theme";

const useStyles = makeStyles({
  card: {
    backgroundColor: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: radius,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    minWidth: 0,
  },
  header: { display: "flex", alignItems: "center", gap: "8px", minHeight: "20px" },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    borderRadius: "6px",
    flexShrink: 0,
    fontSize: "16px",
  },
  title: { fontWeight: 600, fontSize: "14px", color: colors.text, flexGrow: 1 },
  body: { color: colors.text, fontSize: "13px", lineHeight: "18px" },
  tintBlue: { backgroundColor: colors.primaryTint, border: `1px solid #B4D6FA` },
  tintAmber: { backgroundColor: colors.amberBg, border: `1px solid ${colors.amberBorder}` },
  tintGreen: { backgroundColor: colors.greenBg, border: `1px solid #9FD89F` },
  tintRed: { backgroundColor: colors.highBg, border: `1px solid #F1BBC1` },
  tintGrey: { backgroundColor: colors.background },
});

export interface SectionCardProps {
  icon?: ReactNode;
  iconColor?: string;
  iconBg?: string;
  title?: ReactNode;
  actions?: ReactNode;
  tint?: "blue" | "amber" | "green" | "red" | "grey";
  className?: string;
  children?: ReactNode;
  testId?: string;
}

export function SectionCard({ icon, iconColor = colors.primary, iconBg = colors.primaryTint, title, actions, tint, className, children, testId }: SectionCardProps) {
  const s = useStyles();
  const tintClass = tint === "blue" ? s.tintBlue : tint === "amber" ? s.tintAmber : tint === "green" ? s.tintGreen : tint === "red" ? s.tintRed : tint === "grey" ? s.tintGrey : undefined;
  return (
    <section className={mergeClasses(s.card, tintClass, className)} data-testid={testId}>
      {(title || icon) && (
        <div className={s.header}>
          {icon && (
            <span className={s.icon} style={{ color: iconColor, backgroundColor: iconBg }}>
              {icon}
            </span>
          )}
          {title && <Text className={s.title}>{title}</Text>}
          {actions}
        </div>
      )}
      <div className={s.body}>{children}</div>
    </section>
  );
}

const useListStyles = makeStyles({
  ul: { margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px" },
  li: { fontSize: "13px", lineHeight: "18px" },
});

export function BulletList({ items, empty }: { items: ReactNode[]; empty?: ReactNode }) {
  const s = useListStyles();
  if (!items.length) return <Text style={{ color: colors.textSecondary, fontSize: "13px" }}>{empty}</Text>;
  return (
    <ul className={s.ul}>
      {items.map((it, i) => (
        <li key={i} className={s.li}>
          {it}
        </li>
      ))}
    </ul>
  );
}
