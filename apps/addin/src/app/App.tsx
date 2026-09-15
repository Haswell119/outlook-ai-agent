import { makeStyles } from "@fluentui/react-components";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { FeatureFlags } from "@oao/shared";
import { initApi, getApi, setLanguageGetter, type OaoApi } from "@/api";
import { I18nProvider, useI18n } from "@/i18n";
import { hasSelectedItem, isComposeMode, isPreviewMode, queryParam } from "@/office/env";
import { startObservationFlusher } from "@/office/observe";
import { loadSettings, buildInfo } from "@/app/settings";
import { initTelemetry, track } from "@/telemetry";
import { prune } from "@/cache/analysisCache";
import { ToastProvider } from "@/ui/toast";
import { OaoThemeProvider } from "@/ui/ThemeProvider";
import { OfflineBanner } from "@/ui/OfflineBanner";
import { colors } from "@/ui/theme";
import { LazyComplianceGuardian, LazySettingsSheet } from "@/features/lazy";
import { Skeleton } from "@/ui/States";
import { AppContext, adminUrl, complianceEmail } from "./AppContext";
import { ErrorBoundary } from "./ErrorBoundary";
import { BriefMode } from "./BriefMode";
import { ReadMode } from "./ReadMode";

const useStyles = makeStyles({
  // NOTE: FluentProvider copies its className onto portal mount nodes (tooltips, toasts),
  // so page-level layout styles live on an inner wrapper, never on the provider itself.
  provider: { fontFamily: "'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif" },
  page: { minHeight: "100vh", backgroundColor: colors.background, color: colors.text, minWidth: "320px" },
});

function LanguageBridge() {
  const { lang } = useI18n();
  useEffect(() => {
    setLanguageGetter(() => lang);
    try {
      document.documentElement.setAttribute("lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);
  return null;
}

export type AppMode = "read" | "compose" | "brief";

export interface AppProps {
  /** Force a mode (tests / screenshots); defaults to auto-detection. */
  mode?: AppMode;
}

/** Decide which surface to render: compose pane, daily brief, or read pane. */
export function detectMode(): AppMode {
  if (isComposeMode()) return "compose";
  const view = queryParam("view");
  if (view === "brief") return "brief";
  // Preview mode always has the sample email, so it renders the read pane.
  if (!isPreviewMode() && !hasSelectedItem()) return "brief";
  return "read";
}

export function App({ mode }: AppProps) {
  const s = useStyles();
  const preview = useMemo(() => isPreviewMode(), []);
  const detected = useMemo(detectMode, []);
  const resolvedMode = mode ?? detected;
  const [api, setApiState] = useState<OaoApi | null>(null);
  const [features, setFeatures] = useState<FeatureFlags | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Telemetry is initialised before anything else so early failures are seen.
  useEffect(() => {
    const build = buildInfo();
    initTelemetry({ enabled: loadSettings().telemetry, context: { version: build.version, mode: resolvedMode } });
    track("app.open", { mode: resolvedMode, offline: !navigator.onLine });
    void prune();
    return startObservationFlusher();
  }, [resolvedMode]);

  useEffect(() => {
    let alive = true;
    void initApi({ preview }).then(async (a) => {
      if (!alive) return;
      setApiState(a);
      // Feature flags are advisory: never block the first paint on them.
      try {
        const flags = await a.features();
        if (alive) setFeatures(flags);
      } catch {
        /* the UI degrades to its defaults */
      }
    });
    return () => {
      alive = false;
    };
  }, [preview]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const ctx = useMemo(
    () => ({ preview, api: api ?? getApi(), adminUrl: adminUrl(), complianceEmail: complianceEmail(), features, openSettings }),
    [preview, api, features, openSettings],
  );

  return (
    <OaoThemeProvider className={s.provider}>
      <I18nProvider>
        <LanguageBridge />
        <ToastProvider>
          <AppContext.Provider value={ctx}>
            <div className={s.page}>
              <OfflineBanner />
              {api === null ? null : (
                <ErrorBoundary feature="app">
                  {resolvedMode === "compose" ? (
                    <Suspense fallback={<Skeleton cards={2} />}>
                      <LazyComplianceGuardian />
                    </Suspense>
                  ) : resolvedMode === "brief" ? (
                    <BriefMode />
                  ) : (
                    <ReadMode initialTab={queryParam("tab")} initialView={queryParam("view")} />
                  )}
                </ErrorBoundary>
              )}
              {settingsOpen && (
                <Suspense fallback={null}>
                  <LazySettingsSheet open onClose={() => setSettingsOpen(false)} />
                </Suspense>
              )}
            </div>
          </AppContext.Provider>
        </ToastProvider>
      </I18nProvider>
    </OaoThemeProvider>
  );
}
