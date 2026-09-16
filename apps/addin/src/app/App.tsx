import { makeStyles } from "@fluentui/react-components";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureFlags } from "@oao/shared";
import { initApi, getApi, setLanguageGetter, type OaoApi } from "@/api";
import { I18nProvider, useI18n } from "@/i18n";
import { isPreviewMode, queryParam } from "@/office/env";
import { detectSurfaceSync, resolveSurface, type AppSurface } from "@/office/host";
import { addMailboxListener } from "@/office/events";
import { startObservationFlusher } from "@/office/observe";
import { loadSettings, buildInfo } from "@/app/settings";
import { initTelemetry, track } from "@/telemetry";
import { prune } from "@/cache/analysisCache";
import { ToastProvider } from "@/ui/toast";
import { OaoThemeProvider } from "@/ui/ThemeProvider";
import { OfflineBanner } from "@/ui/OfflineBanner";
import { colors } from "@/ui/theme";
import { LazyComplianceGuardian, LazySelectionView, LazySettingsSheet } from "@/features/lazy";
import { Skeleton } from "@/ui/States";
import { AppContext, adminUrl, complianceEmail } from "./AppContext";
import { ErrorBoundary } from "./ErrorBoundary";
import { BackendUnreachable } from "./BackendUnreachable";
import { BriefMode } from "./BriefMode";
import { Header } from "./Header";
import { HomeMode } from "./HomeMode";
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

/** Surfaces the shell can render (see `office/host.ts` for how they are picked). */
export type AppMode = AppSurface;

export interface AppProps {
  /** Force a mode (tests / screenshots); defaults to auto-detection. */
  mode?: AppMode;
}

/** Decide which surface to render. Synchronous: used for the first paint. */
export function detectMode(): AppMode {
  return detectSurfaceSync();
}

export function App({ mode }: AppProps) {
  const s = useStyles();
  const preview = useMemo(() => isPreviewMode(), []);
  const [api, setApiState] = useState<OaoApi | null>(null);
  const [features, setFeatures] = useState<FeatureFlags | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * The pane is **pinnable**, so the surface is not decided once and for all:
   * the user keeps navigating the message list while it stays open. `surface`
   * is re-resolved on every `ItemChanged` / `SelectedItemsChanged`, and
   * `itemVersion` is bumped so the read / selection views re-read the item(s)
   * (which costs nothing when the analysis is already cached).
   */
  const [surface, setSurface] = useState<AppMode>(() => mode ?? detectSurfaceSync());
  const [itemVersion, setItemVersion] = useState(0);
  const resolvedMode = mode ?? surface;

  useEffect(() => {
    if (mode) return; // forced by a test / screenshot
    let alive = true;
    const refresh = () => {
      void resolveSurface().then((next) => {
        if (alive) setSurface(next);
      });
    };
    refresh();
    const onChange = (event: "item" | "selection") => () => {
      if (!alive) return;
      setItemVersion((v) => v + 1);
      track("pane.itemChanged", { kind: event });
      refresh();
    };
    // One Office handler per event for the whole pane, removed on unmount
    // (see office/events.ts) — a pinned pane must not leak a handler per item.
    const offItem = addMailboxListener("ItemChanged", onChange("item"));
    const offSelection = addMailboxListener("SelectedItemsChanged", onChange("selection"));
    return () => {
      alive = false;
      offItem();
      offSelection();
    };
  }, [mode]);

  // Telemetry is initialised before anything else so early failures are seen.
  const opened = useRef(false);
  useEffect(() => {
    const build = buildInfo();
    initTelemetry({ enabled: loadSettings().telemetry, context: { version: build.version, mode: resolvedMode } });
    if (!opened.current) {
      opened.current = true;
      track("app.open", { mode: resolvedMode, offline: !navigator.onLine });
    } else {
      track("pane.surface", { mode: resolvedMode });
    }
    void prune();
    return startObservationFlusher();
  }, [resolvedMode]);

  /**
   * Backend availability. Inside an Outlook host the pane never falls back to
   * the mock client (that used to show the *sample* email's analysis for a real
   * message) — it blocks with `BackendUnreachable` until Retry succeeds.
   */
  const [healthError, setHealthError] = useState<unknown>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [connectTick, setConnectTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setConnecting(true);
    void initApi({ preview }).then(async (result) => {
      if (!alive) return;
      setApiState(result.api);
      setBaseUrl(result.baseUrl);
      setHealthError(result.healthError);
      setConnecting(false);
      track("api.mode", { mode: result.api.mode, reason: result.decision.reason });
      if (result.healthError) return; // blocked: do not call the backend again
      // Feature flags are advisory: never block the first paint on them.
      try {
        const flags = await result.api.features();
        if (alive) setFeatures(flags);
      } catch {
        /* the UI degrades to its defaults */
      }
    });
    return () => {
      alive = false;
    };
  }, [preview, connectTick]);

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
              {api === null ? null : healthError !== null ? (
                <BackendUnreachable baseUrl={baseUrl} error={healthError} retrying={connecting} onRetry={() => setConnectTick((t) => t + 1)} />
              ) : (
                <ErrorBoundary feature="app">
                  {resolvedMode === "compose" ? (
                    <Suspense fallback={<Skeleton cards={2} />}>
                      <LazyComplianceGuardian />
                    </Suspense>
                  ) : resolvedMode === "home" ? (
                    <HomeMode initialTab={queryParam("tab")} />
                  ) : resolvedMode === "selection" ? (
                    <SelectionSurface itemVersion={itemVersion} />
                  ) : resolvedMode === "brief" ? (
                    <BriefMode />
                  ) : (
                    <ReadMode initialTab={queryParam("tab")} initialView={queryParam("view")} itemVersion={itemVersion} />
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

/** The multi-select surface: header + the (lazy) selection view. */
function SelectionSurface({ itemVersion }: { itemVersion: number }) {
  const { t } = useI18n();
  return (
    <>
      <Header subtitle={t("selection.title")} />
      <main id="oao-main" tabIndex={-1} style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
        <Suspense fallback={<Skeleton cards={2} label={t("selection.loading")} />}>
          <LazySelectionView itemVersion={itemVersion} initialTab={queryParam("tab")} />
        </Suspense>
      </main>
    </>
  );
}
