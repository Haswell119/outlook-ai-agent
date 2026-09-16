/**
 * Telemetry with a pluggable sink.
 *
 * Privacy contract (enforced here, not by convention):
 *  - only the event name, a small set of *numeric* / *enumerated* properties and
 *    a correlation id ever leave the pane. `scrub()` drops anything that looks
 *    like mail content: long strings, e-mail addresses, anything under a
 *    disallowed key.
 *  - no email body, subject, recipient, attachment name, audit text or chat
 *    message is ever sent. Ids are hashed by the caller when needed.
 *  - the user can opt out (`settings.telemetry = false`); the opt-out is checked
 *    on every `track`, so turning it off stops the very next event.
 *
 * Sinks, chosen at build time:
 *  - dev / preview                       → console sink (grouped, collapsed)
 *  - `VITE_TELEMETRY_URL` set            → fetch-beacon sink (keepalive POST,
 *                                          batched, never awaited, never retried)
 *  - `VITE_APPINSIGHTS_CONNECTION_STRING`→ the beacon sink is used with the
 *                                          Application Insights track endpoint
 *                                          derived from the connection string.
 *                                          No SDK is bundled (the web SDK adds
 *                                          ~70 kB gz, which the bundle budget
 *                                          does not allow).
 *  - otherwise                           → no-op sink
 */

export type TelemetrySeverity = "info" | "warning" | "error";

export interface TelemetryEvent {
  name: string;
  /** Scrubbed, non-identifying properties. */
  properties: Record<string, string | number | boolean>;
  severity: TelemetrySeverity;
  /** Correlation id of the API call this event belongs to, when any. */
  correlationId?: string;
  at: string;
}

export interface TelemetrySink {
  readonly name: string;
  send(events: TelemetryEvent[]): void;
}

/* --------------------------------------------------------------- scrubbing */

/** Keys we accept; everything else is dropped. */
const ALLOWED_KEYS = new Set([
  "source",
  "kind",
  "mode",
  "tab",
  "view",
  "status",
  "verdict",
  "reason",
  "backend",
  "theme",
  "lang",
  "cacheHit",
  "bypass",
  "ms",
  "count",
  "attempt",
  "code",
  "httpStatus",
  "entries",
  "sent",
  "dropped",
  "remaining",
  "issues",
  "actions",
  "confidence",
  "triage",
  "precomputed",
  "offline",
  "version",
  "feature",
  "errorKind",
]);

const EMAILISH = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MAX_STRING = 64;

export function scrub(properties: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!properties) return out;
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 1000) / 1000;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") {
      if (value.length > MAX_STRING || EMAILISH.test(value)) continue;
      out[key] = value;
    }
  }
  return out;
}

/* ------------------------------------------------------------------- sinks */

export const noopSink: TelemetrySink = { name: "noop", send: () => undefined };

export function consoleSink(): TelemetrySink {
  return {
    name: "console",
    send: (events) => {
      for (const e of events) {
        const fn = e.severity === "error" ? console.error : e.severity === "warning" ? console.warn : console.info;
        fn(`[oao/telemetry] ${e.name}`, { ...e.properties, ...(e.correlationId ? { correlationId: e.correlationId } : {}) });
      }
    },
  };
}

/**
 * `POST /` with `keepalive` so events survive the pane closing. Batched by the
 * queue below, never retried: telemetry must never cost the user anything.
 */
export function beaconSink(url: string, extraHeaders: Record<string, string> = {}): TelemetrySink {
  return {
    name: "beacon",
    send: (events) => {
      try {
        void fetch(url, {
          method: "POST",
          keepalive: true,
          mode: "cors",
          headers: { "Content-Type": "application/json", ...extraHeaders },
          body: JSON.stringify({ events }),
        }).catch(() => undefined);
      } catch {
        /* telemetry is best-effort */
      }
    },
  };
}

/**
 * Parse an Application Insights connection string and return its track URL.
 * Returns null when the string is missing or has no InstrumentationKey.
 */
export function appInsightsEndpoint(connectionString: string | undefined): { url: string; instrumentationKey: string } | null {
  if (!connectionString) return null;
  const parts = new Map<string, string>();
  for (const chunk of connectionString.split(";")) {
    const i = chunk.indexOf("=");
    if (i > 0) parts.set(chunk.slice(0, i).trim().toLowerCase(), chunk.slice(i + 1).trim());
  }
  const key = parts.get("instrumentationkey");
  if (!key) return null;
  const ingestion = (parts.get("ingestionendpoint") ?? "https://dc.services.visualstudio.com").replace(/\/+$/, "");
  return { url: `${ingestion}/v2/track`, instrumentationKey: key };
}

/* ----------------------------------------------------------------- tracker */

const FLUSH_DELAY_MS = 2_000;
const MAX_BATCH = 20;

let sink: TelemetrySink = noopSink;
let enabled = true;
let queue: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let context: Record<string, string | number | boolean> = {};

function resolveSink(): TelemetrySink {
  const env = import.meta.env;
  const ai = appInsightsEndpoint(env.VITE_APPINSIGHTS_CONNECTION_STRING);
  if (ai) return beaconSink(ai.url, { "x-instrumentation-key": ai.instrumentationKey });
  const url = env.VITE_TELEMETRY_URL?.trim();
  if (url) return beaconSink(url);
  if (env.DEV) return consoleSink();
  return noopSink;
}

/** Called once at startup (and again when the user toggles the opt-out). */
export function initTelemetry(opts: { enabled: boolean; sink?: TelemetrySink; context?: Record<string, string | number | boolean> }): void {
  enabled = opts.enabled;
  sink = opts.sink ?? resolveSink();
  context = scrub(opts.context);
  if (!enabled) queue = [];
}

export function telemetrySinkName(): string {
  return enabled ? sink.name : "disabled";
}

export function setTelemetryEnabled(next: boolean): void {
  enabled = next;
  if (!next) {
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

export function flushTelemetry(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!enabled || queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  sink.send(batch);
  if (queue.length > 0) schedule();
}

function schedule(): void {
  if (timer || typeof setTimeout !== "function") return;
  timer = setTimeout(flushTelemetry, FLUSH_DELAY_MS);
}

export function track(
  name: string,
  properties?: Record<string, unknown>,
  opts: { severity?: TelemetrySeverity; correlationId?: string } = {},
): void {
  if (!enabled) return;
  queue.push({
    name,
    properties: { ...context, ...scrub(properties) },
    severity: opts.severity ?? "info",
    correlationId: opts.correlationId,
    at: new Date().toISOString(),
  });
  if (queue.length >= MAX_BATCH) flushTelemetry();
  else schedule();
}

/** Convenience wrapper: measure a promise and emit `<name>` with `ms`/`status`. */
export async function trackTiming<T>(name: string, run: () => Promise<T>, properties?: Record<string, unknown>): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    track(name, { ...properties, ms: Date.now() - started, status: "ok" });
    return value;
  } catch (err) {
    track(name, { ...properties, ms: Date.now() - started, status: "error" }, { severity: "warning" });
    throw err;
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => flushTelemetry());
}
