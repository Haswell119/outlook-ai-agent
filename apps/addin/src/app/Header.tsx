import { Button, makeStyles, Text, Tooltip } from "@fluentui/react-components";
import { Dismiss20Regular, Settings20Regular } from "@fluentui/react-icons";
import { useI18n } from "@/i18n";
import { isOfficeAvailable, isSetSupported, officeGlobal } from "@/office/env";
import { prefetchSettings } from "@/features/lazy";
import { colors } from "@/ui/theme";
import { useApp } from "./AppContext";

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    paddingBlock: "10px 8px",
    paddingInline: "12px",
    backgroundColor: colors.card,
    borderBottom: `1px solid ${colors.border}`,
    position: "sticky",
    top: 0,
    zIndex: 5,
  },
  titles: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  title: { color: colors.primary, fontSize: "16px", fontWeight: 600, lineHeight: "20px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  subtitle: { color: colors.textSecondary, fontSize: "12px", lineHeight: "16px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  pill: {
    fontSize: "11px",
    fontWeight: 600,
    paddingBlock: "1px",
    paddingInline: "8px",
    borderRadius: "10px",
    backgroundColor: colors.mediumBg,
    color: colors.mediumText,
    whiteSpace: "nowrap",
  },
  pillMock: { backgroundColor: colors.primaryTint, color: colors.primary },
  lang: { display: "inline-flex", border: `1px solid ${colors.border}`, borderRadius: "4px", overflow: "hidden", flexShrink: 0 },
  langBtn: {
    minWidth: "28px",
    paddingInline: "6px",
    height: "22px",
    fontSize: "11px",
    fontWeight: 600,
    borderRadius: 0,
    border: "none",
    backgroundColor: "transparent",
    color: colors.textSecondary,
    cursor: "pointer",
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "-2px" },
  },
  langActive: { backgroundColor: colors.primary, color: colors.card },
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
  const { preview, api, openSettings } = useApp();
  return (
    <header className={s.header} data-testid="header">
      <div className={s.titles}>
        <Text className={s.title} as="h1" style={{ margin: 0 }}>
          {t("app.title")}
        </Text>
        {subtitle && <Text className={s.subtitle}>{subtitle}</Text>}
      </div>
      {preview && (
        <span className={s.pill} data-testid="preview-pill">
          {t("app.previewMode")}
        </span>
      )}
      {/* Shown whenever the mock client is active — including in preview mode, where
          both pills appear: "Preview mode" (no Outlook) and "Mock data" (no backend). */}
      {api?.mode === "mock" && (
        <span className={`${s.pill} ${s.pillMock}`} data-testid="mock-pill">
          {t("app.mockApi")}
        </span>
      )}
      <div className={s.lang} role="group" aria-label={t("app.language")}>
        {(["fr", "en"] as const).map((l) => (
          <button key={l} type="button" className={`${s.langBtn} ${lang === l ? s.langActive : ""}`} onClick={() => setLang(l)} aria-pressed={lang === l}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <Tooltip content={t("settings.title")} relationship="label">
        <Button
          appearance="subtle"
          size="small"
          icon={<Settings20Regular />}
          onClick={openSettings}
          onMouseEnter={prefetchSettings}
          onFocus={prefetchSettings}
          aria-label={t("settings.title")}
          data-testid="open-settings"
        />
      </Tooltip>
      <Tooltip content={t("app.close")} relationship="label">
        <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} onClick={closePane} aria-label={t("app.close")} />
      </Tooltip>
    </header>
  );
}
