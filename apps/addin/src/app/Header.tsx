import { Button, makeStyles, Text, Tooltip } from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { useI18n } from "@/i18n";
import { isOfficeAvailable, isSetSupported, officeGlobal } from "@/office/env";
import { colors } from "@/ui/theme";
import { useApp } from "./AppContext";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 12px 8px",
    backgroundColor: colors.card,
    borderBottom: `1px solid ${colors.border}`,
    position: "sticky",
    top: 0,
    zIndex: 5,
  },
  titles: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  title: { color: colors.primary, fontSize: "16px", fontWeight: 600, lineHeight: "20px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  subtitle: { color: colors.textSecondary, fontSize: "12px", lineHeight: "16px" },
  pill: {
    fontSize: "11px",
    fontWeight: 600,
    padding: "1px 8px",
    borderRadius: "10px",
    backgroundColor: colors.mediumBg,
    color: colors.mediumText,
    whiteSpace: "nowrap",
  },
  pillMock: { backgroundColor: colors.primaryTint, color: colors.primary },
  lang: { display: "inline-flex", border: `1px solid ${colors.border}`, borderRadius: "4px", overflow: "hidden" },
  langBtn: { minWidth: "28px", padding: "0 6px", height: "22px", fontSize: "11px", fontWeight: 600, borderRadius: 0, border: "none", backgroundColor: "transparent", color: colors.textSecondary, cursor: "pointer" },
  langActive: { backgroundColor: colors.primary, color: "#fff" },
});

function closePane(): void {
  try {
    if (isOfficeAvailable() && isSetSupported("Mailbox", "1.5")) {
      officeGlobal()!.context.ui.closeContainer();
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    window.close();
  } catch {
    /* ignore */
  }
}

export function Header({ subtitle }: { subtitle?: string }) {
  const s = useStyles();
  const { t, lang, setLang } = useI18n();
  const { preview, api } = useApp();
  return (
    <header className={s.header} data-testid="header">
      <div className={s.titles}>
        <Text className={s.title}>{t("app.title")}</Text>
        {subtitle && <Text className={s.subtitle}>{subtitle}</Text>}
      </div>
      {preview && (
        <span className={s.pill} data-testid="preview-pill">
          {t("app.previewMode")}
        </span>
      )}
      {!preview && api?.mode === "mock" && <span className={`${s.pill} ${s.pillMock}`}>{t("app.mockApi")}</span>}
      <div className={s.lang} role="group" aria-label={t("app.language")}>
        {(["fr", "en"] as const).map((l) => (
          <button key={l} type="button" className={`${s.langBtn} ${lang === l ? s.langActive : ""}`} onClick={() => setLang(l)} aria-pressed={lang === l}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <Tooltip content={t("app.close")} relationship="label">
        <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} onClick={closePane} aria-label={t("app.close")} />
      </Tooltip>
    </header>
  );
}
