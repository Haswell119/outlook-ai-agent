/**
 * Design tokens (docs/mockups.md) exposed as CSS custom properties.
 *
 * Every component keeps importing `colors.*`, but the values are now
 * `var(--oao-…)` references. That means a single `data-oao-theme` attribute on
 * `<html>` re-themes the whole pane with no React re-render and no component
 * change — which is what the Office `OfficeThemeChanged` event needs.
 *
 * Palettes: light (the mock-ups), dark (Outlook dark mode) and high contrast
 * (Windows HC / `forced-colors`). All foreground/background pairs below are
 * >= 4.5:1 for body text and >= 3:1 for the large text and UI borders
 * (WCAG 2.1 AA); the badge pairs are verified by a unit test.
 */

export type ThemeMode = "light" | "dark" | "highContrast";
/** What the user picked in the settings sheet. */
export type ThemePreference = "office" | "light" | "dark";

/** Token names, without the `--oao-` prefix. */
export const TOKEN_NAMES = [
  "primary",
  "primaryHover",
  "primaryTint",
  "primaryBorder",
  "text",
  "textSecondary",
  "border",
  "background",
  "card",
  "lowBg",
  "lowText",
  "lowBorder",
  "mediumBg",
  "mediumText",
  "mediumDot",
  "mediumBorder",
  "highBg",
  "highText",
  "highBorder",
  "amberBg",
  "amberBorder",
  "greenBg",
  "red",
  "focus",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

export type Palette = Record<TokenName, string>;

/** Light palette — the mock-ups. Contrast on #FFFFFF / #F5F5F5. */
export const LIGHT: Palette = {
  primary: "#0F6CBD",
  primaryHover: "#115EA3",
  primaryTint: "#EBF3FC",
  primaryBorder: "#B4D6FA",
  text: "#242424",
  textSecondary: "#5A5A5A",
  border: "#E1DFDD",
  background: "#F5F5F5",
  card: "#FFFFFF",
  lowBg: "#DFF6DD",
  lowText: "#0E700E",
  lowBorder: "#9FD89F",
  mediumBg: "#FFF4CE",
  mediumText: "#6E5600",
  mediumDot: "#9A7A00",
  mediumBorder: "#F2C94C",
  highBg: "#FDE7E9",
  highText: "#B02A44",
  highBorder: "#F1BBC1",
  amberBg: "#FFF8E5",
  amberBorder: "#F2C94C",
  greenBg: "#F1FAF1",
  red: "#B02A44",
  focus: "#0F6CBD",
};

/** Dark palette — mirrors Outlook dark mode; tints become low-alpha overlays. */
export const DARK: Palette = {
  primary: "#6CB8F6",
  primaryHover: "#8FCBF8",
  primaryTint: "#12314B",
  primaryBorder: "#2A557C",
  text: "#F3F2F1",
  textSecondary: "#BDBDBD",
  border: "#3B3A39",
  background: "#1B1A19",
  card: "#252423",
  lowBg: "#123212",
  lowText: "#8CD98C",
  lowBorder: "#2F6B2F",
  mediumBg: "#3A2F06",
  mediumText: "#F5D77A",
  mediumDot: "#E0B100",
  mediumBorder: "#7A6200",
  highBg: "#3B1620",
  highText: "#F2A2B0",
  highBorder: "#7E2E40",
  amberBg: "#332A08",
  amberBorder: "#7A6200",
  greenBg: "#132A13",
  red: "#F2A2B0",
  focus: "#8FCBF8",
};

/**
 * High contrast — delegates to the system colours so Windows HC themes and
 * `forced-colors: active` are respected instead of fought.
 */
export const HIGH_CONTRAST: Palette = {
  primary: "LinkText",
  primaryHover: "LinkText",
  primaryTint: "Canvas",
  primaryBorder: "CanvasText",
  text: "CanvasText",
  textSecondary: "CanvasText",
  border: "CanvasText",
  background: "Canvas",
  card: "Canvas",
  lowBg: "Canvas",
  lowText: "CanvasText",
  lowBorder: "CanvasText",
  mediumBg: "Canvas",
  mediumText: "CanvasText",
  mediumDot: "CanvasText",
  mediumBorder: "CanvasText",
  highBg: "Canvas",
  highText: "CanvasText",
  highBorder: "CanvasText",
  amberBg: "Canvas",
  amberBorder: "CanvasText",
  greenBg: "Canvas",
  red: "CanvasText",
  focus: "Highlight",
};

export const PALETTES: Record<ThemeMode, Palette> = { light: LIGHT, dark: DARK, highContrast: HIGH_CONTRAST };

function tokenRefs(): Palette {
  const out = {} as Palette;
  for (const name of TOKEN_NAMES) out[name] = `var(--oao-${name})`;
  return out;
}

/**
 * The object every component imports. Values are `var(--oao-…)` so themes swap
 * without touching a single component.
 */
export const colors: Palette = tokenRefs();

export const radius = "8px";

/** CSS text declaring one palette on `:root`. */
export function paletteCss(mode: ThemeMode): string {
  const palette = PALETTES[mode];
  const body = TOKEN_NAMES.map((name) => `--oao-${name}:${palette[name]};`).join("");
  return `:root{${body}color-scheme:${mode === "dark" ? "dark" : "light"};}`;
}

/** Relative luminance of a `#rrggbb` / `#rgb` colour, 0..1. */
export function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(Number.parseInt(h.slice(0, 2), 16));
  const g = channel(Number.parseInt(h.slice(2, 4), 16));
  const b = channel(Number.parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours (null when not parseable). */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface OfficeThemeLike {
  bodyBackgroundColor?: string;
  bodyForegroundColor?: string;
  controlBackgroundColor?: string;
  controlForegroundColor?: string;
}

/**
 * Map `Office.context.officeTheme` to one of our modes.
 *  - a dark body background (luminance < 0.35) → dark
 *  - pure black on pure white, or vice versa   → high contrast
 *  - anything else / unavailable               → light
 */
export function modeFromOfficeTheme(theme: OfficeThemeLike | undefined | null): ThemeMode | null {
  const bg = theme?.bodyBackgroundColor;
  const fg = theme?.bodyForegroundColor;
  if (!bg) return null;
  const lumBg = luminance(bg);
  if (lumBg === null) return null;
  const lumFg = fg ? luminance(fg) : null;
  if (lumFg !== null) {
    const ratio = contrastRatio(bg, fg!);
    // Windows high-contrast themes are literally #000/#FFF (ratio 21).
    if (ratio !== null && ratio > 19.5) return "highContrast";
  }
  return lumBg < 0.35 ? "dark" : "light";
}

/** Resolve the effective mode from the user preference + host signals. */
export function resolveThemeMode(opts: {
  preference: ThemePreference;
  officeTheme?: OfficeThemeLike | null;
  prefersDark?: boolean;
  forcedColors?: boolean;
}): ThemeMode {
  if (opts.forcedColors) return "highContrast";
  if (opts.preference === "light") return "light";
  if (opts.preference === "dark") return "dark";
  const fromOffice = modeFromOfficeTheme(opts.officeTheme);
  if (fromOffice) return fromOffice;
  return opts.prefersDark ? "dark" : "light";
}
