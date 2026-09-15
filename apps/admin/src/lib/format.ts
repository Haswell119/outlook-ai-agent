import type { Language } from "@oao/shared";

/** Locale-aware integer formatting (8642 -> "8,642" / "8 642"). */
export function formatNumber(value: number, language: Language = "en"): string {
  return new Intl.NumberFormat(language === "fr" ? "fr-FR" : "en-US").format(value);
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

export function formatDateTime(iso: string, language: Language = "en"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

/** Table-density timestamp, without the year: "May 18, 06:53 PM". */
export function formatDateTimeCompact(iso: string, language: Language = "en"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

export function formatDateShort(iso: string, language: Language = "en"): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** "May 12 – May 18, 2025" */
export function formatDateRange(from: string, to: string, language: Language = "en"): string {
  const f = new Date(from);
  const t = new Date(to);
  const fmt = (d: Date, withYear: boolean) =>
    new Intl.DateTimeFormat(language === "fr" ? "fr-FR" : "en-US", {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    }).format(d);
  return `${fmt(f, false)} – ${fmt(t, true)}`;
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function formatConfidence(c: number | undefined): string {
  if (c === undefined) return "—";
  return `${Math.round(c * 100)}%`;
}

export function humanizeEventType(type: string): string {
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
