/**
 * Resolves the theme (Office host theme → dark / light / high contrast), keeps
 * it in sync with `OfficeThemeChanged`, `prefers-color-scheme` and
 * `forced-colors`, injects the palette as CSS custom properties and renders the
 * matching Fluent theme.
 *
 * The palette is written to a single `<style id="oao-theme">` element instead of
 * React state so that a host theme change repaints without re-rendering the
 * tree (no flash, no lost scroll position, no aborted fetch).
 */
import { FluentProvider, webDarkTheme, webLightTheme, teamsHighContrastTheme, type Theme } from "@fluentui/react-components";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isOfficeAvailable, officeGlobal } from "@/office/env";
import { loadSettings, onSettingsChange, saveSettings, type Settings } from "@/app/settings";
import { paletteCss, resolveThemeMode, type OfficeThemeLike, type ThemeMode, type ThemePreference } from "./theme";

const STYLE_ID = "oao-theme";

export function fluentThemeFor(mode: ThemeMode): Theme {
  if (mode === "dark") return webDarkTheme;
  if (mode === "highContrast") return teamsHighContrastTheme;
  return webLightTheme;
}

function officeTheme(): OfficeThemeLike | null {
  try {
    return (officeGlobal()?.context as { officeTheme?: OfficeThemeLike } | undefined)?.officeTheme ?? null;
  } catch {
    return null;
  }
}

function media(query: string): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;
  } catch {
    return false;
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  try {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = paletteCss(mode);
    document.documentElement.setAttribute("data-oao-theme", mode);
  } catch {
    /* non-DOM environment */
  }
}

export interface ThemeContextValue {
  mode: ThemeMode;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** True when the user asked the OS to reduce motion. */
  reducedMotion: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "light",
  preference: "office",
  setPreference: () => undefined,
  reducedMotion: false,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function OaoThemeProvider({ children, className }: { children: ReactNode; className?: string }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => loadSettings().theme);
  const [hostTick, setHostTick] = useState(0);
  const [prefersDark, setPrefersDark] = useState(() => media("(prefers-color-scheme: dark)"));
  const [forcedColors, setForcedColors] = useState(() => media("(forced-colors: active)") || media("(-ms-high-contrast: active)"));
  const [reducedMotion, setReducedMotion] = useState(() => media("(prefers-reduced-motion: reduce)"));

  // Office theme changes (new Outlook / OWA switch between light and dark).
  useEffect(() => {
    if (!isOfficeAvailable()) return;
    const office = officeGlobal();
    const handler = () => setHostTick((t) => t + 1);
    try {
      const evType = (office as unknown as { EventType?: { OfficeThemeChanged?: string } }).EventType?.OfficeThemeChanged;
      const ctx = office?.context as unknown as {
        mailbox?: { addHandlerAsync?: (t: string, h: () => void, cb?: (r: unknown) => void) => void; removeHandlerAsync?: (t: string, cb?: (r: unknown) => void) => void };
      };
      if (evType && ctx?.mailbox?.addHandlerAsync) {
        ctx.mailbox.addHandlerAsync(evType, handler, () => undefined);
        return () => {
          try {
            ctx.mailbox?.removeHandlerAsync?.(evType, () => undefined);
          } catch {
            /* ignore */
          }
        };
      }
    } catch {
      /* host without the event: prefers-color-scheme still covers it */
    }
    return undefined;
  }, []);

  // OS-level media queries.
  useEffect(() => {
    const subs: Array<() => void> = [];
    const watch = (query: string, set: (v: boolean) => void) => {
      try {
        const mql = window.matchMedia(query);
        const handler = () => set(mql.matches);
        set(mql.matches);
        mql.addEventListener?.("change", handler);
        subs.push(() => mql.removeEventListener?.("change", handler));
      } catch {
        /* ignore */
      }
    };
    watch("(prefers-color-scheme: dark)", setPrefersDark);
    watch("(forced-colors: active)", setForcedColors);
    watch("(prefers-reduced-motion: reduce)", setReducedMotion);
    return () => subs.forEach((off) => off());
  }, []);

  useEffect(() => onSettingsChange((s: Settings) => setPreferenceState(s.theme)), []);

  const mode = useMemo(
    () => resolveThemeMode({ preference, officeTheme: officeTheme(), prefersDark, forcedColors }),
    // hostTick forces a re-read of Office.context.officeTheme
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preference, prefersDark, forcedColors, hostTick],
  );

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.setAttribute("data-oao-motion", reducedMotion ? "reduce" : "full");
  }, [reducedMotion]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    saveSettings({ theme: p });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ mode, preference, setPreference, reducedMotion }), [mode, preference, setPreference, reducedMotion]);

  return (
    <ThemeContext.Provider value={value}>
      <FluentProvider theme={fluentThemeFor(mode)} className={className}>
        {children}
      </FluentProvider>
    </ThemeContext.Provider>
  );
}
