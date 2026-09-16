import type { Language } from "@oao/shared";

/**
 * Locale- and timezone-aware formatting.
 *
 * Every date/time is rendered through `Intl` in the operator's UI language and
 * in the timezone configured by `ADMIN_TZ` (default `Europe/Zurich`), which the
 * server passes down as a `timeZone` prop so the client and the server agree —
 * a mismatch would otherwise produce a hydration error.
 */
export const FALLBACK_TIME_ZONE = "UTC";

export function localeOf(language: Language = "en"): string {
  return language === "fr" ? "fr-CH" : "en-GB";
}

/** Guards against an invalid IANA zone reaching `Intl` (it would throw). */
export function safeTimeZone(timeZone?: string): string {
  const candidate = timeZone?.trim();
  if (!candidate) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** Locale-aware integer formatting (8642 -> "8,642" / "8 642"). */
export function formatNumber(value: number, language: Language = "en"): string {
  return new Intl.NumberFormat(localeOf(language)).format(value);
}

/**
 * Formats a KPI delta as a signed percentage with one decimal.
 * `12.4` -> "+12.4%", `-3` -> "-3.0%", `0` -> "0.0%".
 */
export function formatDelta(delta: number | undefined): string {
  if (delta === undefined || Number.isNaN(delta)) return "—";
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)}%`;
}

/**
 * Semantics of a KPI delta arrow, per the mock-up: a rising number is good
 * (green) for every tile *except* compliance alerts, where "more alerts" is a
 * warning and must stay red.
 */
export type DeltaTone = "positive" | "negative" | "neutral";

export function deltaTone(delta: number | undefined, invert = false): DeltaTone {
  if (delta === undefined || delta === 0 || Number.isNaN(delta)) return "neutral";
  const up = delta > 0;
  if (invert) return up ? "negative" : "positive";
  return up ? "positive" : "negative";
}

export function formatPercent(share: number, digits = 1): string {
  return `${share.toFixed(digits)}%`;
}

function dateTimeFormat(
  language: Language,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(localeOf(language), {
    ...options,
    timeZone: safeTimeZone(timeZone),
  });
}

export function formatDateTime(iso: string, language: Language = "en", timeZone?: string): string {
  return dateTimeFormat(language, timeZone, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Table-density timestamp, without the year: "18 May, 18:53". */
export function formatDateTimeCompact(
  iso: string,
  language: Language = "en",
  timeZone?: string,
): string {
  return dateTimeFormat(language, timeZone, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDateShort(iso: string, language: Language = "en", timeZone?: string): string {
  return dateTimeFormat(language, timeZone, { month: "short", day: "numeric" }).format(new Date(iso));
}

/** "12 May – 18 May 2025" */
export function formatDateRange(
  from: string,
  to: string,
  language: Language = "en",
  timeZone?: string,
): string {
  const fmt = (iso: string, withYear: boolean) =>
    dateTimeFormat(language, timeZone, {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
    }).format(new Date(iso));
  return `${fmt(from, false)} – ${fmt(to, true)}`;
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function formatConfidence(c: number | undefined): string {
  if (c === undefined) return "—";
  return `${Math.round(c * 100)}%`;
}

/** "4 d 14 h 23 min" / "4 j 14 h 23 min" — uptime on `/system`. */
export function formatDuration(seconds: number, language: Language = "en"): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const dayUnit = language === "fr" ? "j" : "d";
  const parts: string[] = [];
  if (d > 0) parts.push(`${formatNumber(d, language)} ${dayUnit}`);
  if (d > 0 || h > 0) parts.push(`${h} h`);
  parts.push(`${m} min`);
  return parts.join(" ");
}

/** Hit rate of a cache, `null` when it was never exercised. */
export function hitRate(hits: number, misses: number): number | null {
  const total = hits + misses;
  if (total <= 0) return null;
  return (hits / total) * 100;
}

export function humanizeEventType(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
