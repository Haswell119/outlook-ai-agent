/**
 * Settings sheet — a modal drawer with everything a user or a support engineer
 * needs, and nothing else: language, theme (following the Office theme by
 * default), telemetry opt-out, "Clear local cache", and a diagnostics block
 * (version, build, backend URL + live health, auth mode, cache backend,
 * telemetry sink, queued events).
 *
 * Focus management: the Fluent `Drawer` traps focus; we additionally move focus
 * to the heading on open and restore it to the trigger on close, and the drawer
 * is labelled by its heading (`aria-labelledby`).
 */
import {
  Button,
  Divider,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Link,
  makeStyles,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  Text,
} from "@fluentui/react-components";
import { CheckmarkCircle16Filled, Delete20Regular, Dismiss20Regular, ErrorCircle16Filled, Warning16Filled } from "@fluentui/react-icons";
import type { Health, Language } from "@oao/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "@/api/client";
import { useApp } from "@/app/AppContext";
import { buildInfo, loadSettings, saveSettings } from "@/app/settings";
import { cacheStats, clearCache } from "@/cache/analysisCache";
import { formatDate, useI18n } from "@/i18n";
import { size as outboxSize } from "@/net/outbox";
import { authMode, tokenStatus } from "@/office/sso";
import { setTelemetryEnabled, telemetrySinkName, track } from "@/telemetry";
import { colors, useTheme, useToast } from "@/ui";
import type { ThemePreference } from "@/ui/theme";

const useStyles = makeStyles({
  drawer: { maxWidth: "min(420px, 100vw)" },
  body: { display: "flex", flexDirection: "column", gap: "16px", paddingBottom: "24px" },
  group: { display: "flex", flexDirection: "column", gap: "8px" },
  groupTitle: { fontWeight: 600, fontSize: "13px", color: colors.text },
  hint: { color: colors.textSecondary, fontSize: "12px", lineHeight: "16px" },
  kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: "12px", alignItems: "baseline" },
  k: { color: colors.textSecondary, whiteSpace: "nowrap" },
  v: { overflowWrap: "break-word" },
  /** Only URLs may break mid-token. */
  vUrl: { wordBreak: "break-all" },
  row: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
});

export interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsSheet({ open, onClose }: SettingsSheetProps) {
  const s = useStyles();
  const { t, lang, setLang } = useI18n();
  const { api, preview, features, adminUrl } = useApp();
  const { preference, setPreference, mode } = useTheme();
  const toast = useToast();

  const [telemetry, setTelemetry] = useState(() => loadSettings().telemetry);
  const [diagnostics, setDiagnostics] = useState(() => loadSettings().diagnostics);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cache, setCache] = useState<{ entries: number; backend: string }>({ entries: 0, backend: "-" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const build = buildInfo();

  const refreshDiagnostics = useCallback(async () => {
    setChecking(true);
    setHealthError(false);
    try {
      setHealth(await api.health());
    } catch {
      setHealth(null);
      setHealthError(true);
    } finally {
      setChecking(false);
    }
    setCache(await cacheStats());
  }, [api]);

  useEffect(() => {
    if (!open) return;
    void refreshDiagnostics();
    const timer = setTimeout(() => headingRef.current?.focus(), 30);
    return () => clearTimeout(timer);
  }, [open, refreshDiagnostics]);

  const onTelemetry = useCallback(
    (next: boolean) => {
      setTelemetry(next);
      saveSettings({ telemetry: next });
      setTelemetryEnabled(next);
      if (next) track("settings.telemetryEnabled");
    },
    [],
  );

  const onDiagnostics = useCallback((next: boolean) => {
    setDiagnostics(next);
    saveSettings({ diagnostics: next });
  }, []);

  const onClear = useCallback(async () => {
    await clearCache();
    setCache(await cacheStats());
    track("settings.cacheCleared");
    toast.success(t("settings.cacheCleared"));
  }, [t, toast]);

  const token = tokenStatus();

  return (
    <Drawer type="overlay" position="end" open={open} onOpenChange={(_, d) => !d.open && onClose()} className={s.drawer} aria-labelledby="oao-settings-title">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" icon={<Dismiss20Regular />} onClick={onClose} aria-label={t("app.close")} />}
        >
          <h2 id="oao-settings-title" ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: "16px", outline: "none" }}>
            {t("settings.title")}
          </h2>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={s.body} data-testid="settings-sheet">
        <div className={s.group}>
          <Text className={s.groupTitle} id="oao-settings-lang">
            {t("settings.language")}
          </Text>
          <RadioGroup value={lang} onChange={(_, d) => setLang(d.value as Language)} layout="horizontal" aria-labelledby="oao-settings-lang">
            <Radio value="fr" label="Français" />
            <Radio value="en" label="English" />
          </RadioGroup>
        </div>

        <Divider />

        <div className={s.group}>
          <Text className={s.groupTitle} id="oao-settings-theme">
            {t("settings.theme")}
          </Text>
          <RadioGroup
            value={preference}
            onChange={(_, d) => setPreference(d.value as ThemePreference)}
            aria-labelledby="oao-settings-theme"
            data-testid="settings-theme"
          >
            <Radio value="office" label={t("settings.themeOffice")} />
            <Radio value="light" label={t("settings.themeLight")} />
            <Radio value="dark" label={t("settings.themeDark")} />
          </RadioGroup>
          <Text className={s.hint}>{t("settings.themeHint", { mode: t(`settings.mode.${mode}`) })}</Text>
        </div>

        <Divider />

        <div className={s.group}>
          <Text className={s.groupTitle}>{t("settings.privacy")}</Text>
          <Switch
            checked={telemetry}
            onChange={(_, d) => onTelemetry(!!d.checked)}
            label={t("settings.telemetry")}
            data-testid="settings-telemetry"
          />
          <Text className={s.hint}>{t("settings.telemetryHint")}</Text>
        </div>

        <Divider />

        <div className={s.group}>
          <Text className={s.groupTitle}>{t("settings.localData")}</Text>
          <Text className={s.hint}>{t("settings.cacheHint")}</Text>
          <Field label={t("settings.cacheEntries")} hint={`${cache.backend}`}>
            <Text>{cache.entries}</Text>
          </Field>
          <div className={s.row}>
            <Button appearance="outline" size="small" icon={<Delete20Regular />} onClick={() => void onClear()} data-testid="settings-clear-cache">
              {t("settings.clearCache")}
            </Button>
          </div>
        </div>

        <Divider />

        <div className={s.group}>
          <Text className={s.groupTitle}>{t("settings.diagnostics")}</Text>
          <div className={s.kv}>
            <span className={s.k}>{t("settings.version")}</span>
            <span className={s.v} data-testid="settings-version">
              {build.version} · {build.commit}
              {build.builtAt ? ` · ${formatDate(build.builtAt, lang)}` : ""}
            </span>
            <span className={s.k}>{t("settings.backend")}</span>
            <span className={`${s.v} ${s.vUrl}`} data-testid="settings-backend">
              {apiBaseUrl()}
            </span>
            <span className={s.k}>{t("settings.health")}</span>
            <span className={s.v}>
              <span className={s.row}>
                {checking ? (
                  <Spinner size="extra-tiny" />
                ) : health ? (
                  health.status === "ok" ? (
                    <CheckmarkCircle16Filled style={{ color: colors.lowText }} aria-hidden="true" />
                  ) : (
                    <Warning16Filled style={{ color: colors.mediumDot }} aria-hidden="true" />
                  )
                ) : (
                  <ErrorCircle16Filled style={{ color: colors.red }} aria-hidden="true" />
                )}
                <span data-testid="settings-health">{health ? t(`settings.healthStatus.${health.status}`) : healthError ? t("settings.healthUnreachable") : "—"}</span>
                {health?.version && <span className={s.hint}>({health.version})</span>}
              </span>
            </span>
            <span className={s.k}>{t("settings.apiMode")}</span>
            <span className={s.v}>
              {api.mode === "mock" ? t("app.mockApi") : "live"}
              {preview ? ` · ${t("app.previewMode")}` : ""}
            </span>
            <span className={s.k}>{t("settings.authMode")}</span>
            <span className={s.v}>
              {authMode()}
              {token.cached ? ` · ${t("settings.tokenCached", { minutes: Math.round((token.expiresInMs ?? 0) / 60_000) })}` : ""}
            </span>
            <span className={s.k}>{t("settings.telemetrySink")}</span>
            <span className={s.v}>{telemetrySinkName()}</span>
            <span className={s.k}>{t("settings.queued")}</span>
            <span className={s.v}>{outboxSize()}</span>
            {features?.llmModel && (
              <>
                <span className={s.k}>{t("settings.models")}</span>
                <span className={s.v}>
                  {features.llmModel}
                  {features.llmFastModel ? ` · ${features.llmFastModel}` : ""}
                </span>
              </>
            )}
            {features && (
              <>
                <span className={s.k}>{t("settings.featureFlags")}</span>
                <span className={s.v}>
                  {[
                    features.graphEnabled ? "graph" : null,
                    features.embeddingsEnabled ? "embeddings" : null,
                    features.precomputeEnabled ? "precompute" : null,
                    features.dailyBriefEnabled ? "brief" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || t("settings.noneEnabled")}
                </span>
              </>
            )}
          </div>
          <Switch
            checked={diagnostics}
            onChange={(_, d) => onDiagnostics(!!d.checked)}
            label={t("settings.diagnosticMode")}
            data-testid="settings-diagnostics"
          />
          <Text className={s.hint}>{t("settings.diagnosticModeHint")}</Text>
          <div className={s.row}>
            <Button appearance="subtle" size="small" onClick={() => void refreshDiagnostics()} disabled={checking}>
              {t("app.refreshStatus")}
            </Button>
            <Link href={`${adminUrl}/audit`} target="_blank" rel="noopener" style={{ fontSize: "12px" }}>
              {t("insights.viewAuditLog")}
            </Link>
          </div>
        </div>
      </DrawerBody>
    </Drawer>
  );
}
