/**
 * User preferences that live only on this device (localStorage, memory
 * fallback). Nothing here is sent anywhere; the language override is kept by
 * the i18n module under its own key for backwards compatibility.
 */
import type { ThemePreference } from "@/ui/theme";

const KEY = "oao.addin.settings.v1";

export interface Settings {
  /** "office" follows Office.context.officeTheme / prefers-color-scheme. */
  theme: ThemePreference;
  /** Product telemetry opt-in. Defaults to true; no mail content is ever sent. */
  telemetry: boolean;
  /** Collapse the "what's precomputed" explainer once the user dismissed it. */
  hideSourceHint: boolean;
  /**
   * Diagnostic mode (support): shows where each structured decision came from
   * (decision engine, taxonomy, fallback) under the Summary. Off by default.
   */
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: Settings = { theme: "office", telemetry: true, hideSourceHint: false, diagnostics: false };

let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

function sanitize(raw: unknown): Settings {
  const o = (raw ?? {}) as Partial<Settings>;
  return {
    theme: o.theme === "light" || o.theme === "dark" ? o.theme : "office",
    telemetry: o.telemetry !== false,
    hideSourceHint: o.hideSourceHint === true,
    diagnostics: o.diagnostics === true,
  };
}

export function loadSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = sanitize(raw ? JSON.parse(raw) : {});
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = sanitize({ ...loadSettings(), ...patch });
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* memory only */
  }
  for (const l of [...listeners]) {
    try {
      l(next);
    } catch {
      /* ignore */
    }
  }
  return next;
}

export function onSettingsChange(listener: (s: Settings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetSettings(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Build info stamped at compile time (see vite.config.ts `define`). */
export interface BuildInfo {
  version: string;
  commit: string;
  builtAt: string;
}

export function buildInfo(): BuildInfo {
  // `__OAO_BUILD__` is a compile-time *identifier* replaced by vite `define`,
  // so it must be referenced directly (a `globalThis.__OAO_BUILD__` property
  // access would not be substituted). It is undefined under vitest.
  let stamped: Partial<BuildInfo> | undefined;
  try {
    stamped = typeof __OAO_BUILD__ === "undefined" ? undefined : __OAO_BUILD__;
  } catch {
    stamped = undefined;
  }
  return {
    version: stamped?.version ?? "0.0.0-dev",
    commit: stamped?.commit ?? "local",
    builtAt: stamped?.builtAt ?? "",
  };
}
