import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCsp, cspMetaTag, frameAncestors, HEADER_ONLY_DIRECTIVES, toOrigin } from "@/security/csp";
import { escapeHtml, looksLikeHtml, toPlainText } from "@/security/sanitize";
import {
  contrastRatio,
  DARK,
  LIGHT,
  luminance,
  modeFromOfficeTheme,
  paletteCss,
  resolveThemeMode,
  TOKEN_NAMES,
} from "@/ui/theme";
import { clearOutbox, enqueue, expire, flush, MAX_AGE_MS, MAX_ITEMS, peek, size } from "@/net/outbox";
import { connectivity, reportNetworkFailure, reportReachable, resetConnectivity } from "@/net/connectivity";
import { appInsightsEndpoint, initTelemetry, scrub, track, flushTelemetry, type TelemetryEvent } from "@/telemetry";
import { backoffDelayMs, isRetryable, newCorrelationId } from "@/api/client";
import { ApiClientError, correlationIdOf } from "@/api/errors";
import { formatErrorReport } from "@/app/ErrorBoundary";
import type { UserActionEvent } from "@oao/shared";

const event = (id: string): UserActionEvent => ({
  type: "open_email",
  occurredAt: new Date().toISOString(),
  email: { id },
  parameters: {},
});

describe("CSP builder", () => {
  it("locks connect-src to 'self' plus the configured backend origin", () => {
    const policy = buildCsp({ apiOrigin: "https://api.example.com/api/v1" });
    expect(policy).toContain("connect-src 'self' https://api.example.com");
    expect(policy).not.toContain("https://api.example.com/api/v1");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("allows office.js and the Office CDN in script-src only", () => {
    const policy = buildCsp({});
    expect(policy).toMatch(/script-src 'self' https:\/\/appsforoffice\.microsoft\.com/);
    expect(policy).toContain("https://*.office.net");
    // style-src needs unsafe-inline for Griffel, script-src must not have it.
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(/script-src[^;]*unsafe-inline/.test(policy)).toBe(false);
  });

  it("adds the dev websocket origins only in dev", () => {
    expect(buildCsp({ dev: true })).toContain("ws://localhost:*");
    expect(buildCsp({ dev: false })).not.toContain("ws://localhost:*");
    expect(buildCsp({ dev: true })).toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("includes extra connect origins and a report-uri when given", () => {
    const policy = buildCsp({ apiOrigin: "https://api.example.com", extraConnect: ["https://telemetry.example.com/x"], reportUri: "/csp" });
    expect(policy).toContain("https://telemetry.example.com");
    expect(policy).toContain("report-uri /csp");
  });

  it("normalises origins and escapes the meta tag", () => {
    expect(toOrigin("https://a.example.com/path?q=1")).toBe("https://a.example.com");
    expect(toOrigin("a.example.com")).toBe("https://a.example.com");
    expect(toOrigin("")).toBeNull();
    expect(cspMetaTag({})).toMatch(/^<meta http-equiv="Content-Security-Policy" content="[^"]+" \/>$/);
  });
});

describe("output sanitising", () => {
  it("reduces HTML to text and drops script contents", () => {
    expect(looksLikeHtml("<b>hi</b>")).toBe(true);
    expect(toPlainText("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(toPlainText('<script>alert("x")</script>safe')).toBe("safe");
    expect(toPlainText("<img src=x onerror=alert(1)>text")).toBe("text");
    expect(toPlainText("a<br/>b")).toBe("a\nb");
  });

  it("decodes entities and truncates", () => {
    expect(toPlainText("caf&eacute; &amp; co")).toContain("&");
    expect(toPlainText("&lt;not a tag&gt;")).toBe("<not a tag>");
    expect(toPlainText("x".repeat(50), 10)).toHaveLength(10);
    expect(toPlainText(undefined)).toBe("");
  });

  it("escapes text destined for an Office.js reply body", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

describe("theme mapping", () => {
  it("maps a dark Office body background to the dark theme", () => {
    expect(modeFromOfficeTheme({ bodyBackgroundColor: "#1B1A19", bodyForegroundColor: "#F3F2F1" })).toBe("dark");
    expect(modeFromOfficeTheme({ bodyBackgroundColor: "#FFFFFF", bodyForegroundColor: "#242424" })).toBe("light");
    expect(modeFromOfficeTheme({ bodyBackgroundColor: "#000000", bodyForegroundColor: "#FFFFFF" })).toBe("highContrast");
    expect(modeFromOfficeTheme(undefined)).toBeNull();
    expect(modeFromOfficeTheme({ bodyBackgroundColor: "not-a-colour" })).toBeNull();
  });

  it("lets an explicit preference win, and forced-colors win over everything", () => {
    expect(resolveThemeMode({ preference: "light", officeTheme: { bodyBackgroundColor: "#1B1A19" } })).toBe("light");
    expect(resolveThemeMode({ preference: "dark", prefersDark: false })).toBe("dark");
    expect(resolveThemeMode({ preference: "office", officeTheme: { bodyBackgroundColor: "#1B1A19" } })).toBe("dark");
    expect(resolveThemeMode({ preference: "office", prefersDark: true })).toBe("dark");
    expect(resolveThemeMode({ preference: "office" })).toBe("light");
    expect(resolveThemeMode({ preference: "light", forcedColors: true })).toBe("highContrast");
  });

  it("emits every token for every palette", () => {
    for (const mode of ["light", "dark", "highContrast"] as const) {
      const css = paletteCss(mode);
      for (const token of TOKEN_NAMES) expect(css, `${mode}/${token}`).toContain(`--oao-${token}:`);
    }
    expect(paletteCss("dark")).toContain("color-scheme:dark");
  });

  it("keeps badge and body contrast at WCAG AA in both palettes", () => {
    const pairs: Array<[string, string]> = [
      [LIGHT.text, LIGHT.card],
      [LIGHT.textSecondary, LIGHT.card],
      [LIGHT.lowText, LIGHT.lowBg],
      [LIGHT.mediumText, LIGHT.mediumBg],
      [LIGHT.highText, LIGHT.highBg],
      [LIGHT.primary, LIGHT.card],
      [DARK.text, DARK.card],
      [DARK.textSecondary, DARK.card],
      [DARK.lowText, DARK.lowBg],
      [DARK.mediumText, DARK.mediumBg],
      [DARK.highText, DARK.highBg],
      [DARK.primary, DARK.card],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `${fg} on ${bg}`).not.toBeNull();
      expect(ratio!, `${fg} on ${bg} = ${ratio?.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 3);
    expect(luminance("#000")).toBeCloseTo(0, 3);
    expect(contrastRatio("nope", "#fff")).toBeNull();
  });
});

describe("offline outbox", () => {
  beforeEach(() => clearOutbox());

  it("queues, flushes in order and empties", async () => {
    enqueue(event("a"));
    enqueue(event("b"));
    expect(size()).toBe(2);
    const sent: string[] = [];
    const result = await flush(async (e) => void sent.push(e.email.id));
    expect(sent).toEqual(["a", "b"]);
    expect(result.sent).toBe(2);
    expect(size()).toBe(0);
  });

  it("stops at the first failure and keeps the rest queued", async () => {
    enqueue(event("a"));
    enqueue(event("b"));
    const result = await flush(async (e) => {
      if (e.email.id === "b") throw new Error("offline");
    });
    expect(result.sent).toBe(1);
    expect(size()).toBe(1);
    expect(peek()[0]!.event.email.id).toBe("b");
  });

  it("drops events older than 24 h instead of sending them", async () => {
    const now = Date.now();
    const old = now - MAX_AGE_MS - 1_000;
    enqueue(event("old-1"), old);
    enqueue(event("old-2"), old);
    expect(size()).toBe(2);
    const sent: string[] = [];
    const result = await flush(async (e) => void sent.push(e.email.id), now);
    expect(result.dropped).toBe(2);
    expect(sent).toEqual([]);
    expect(size()).toBe(0);
  });

  it("expires stale events as soon as a new one is queued", () => {
    const now = Date.now();
    enqueue(event("old"), now - MAX_AGE_MS - 1_000);
    enqueue(event("new"), now);
    expect(size()).toBe(1);
    expect(peek()[0]!.event.email.id).toBe("new");
  });

  it("is bounded: the oldest events are dropped past the cap", () => {
    for (let i = 0; i < MAX_ITEMS + 25; i++) enqueue(event(`e-${i}`));
    expect(size()).toBe(MAX_ITEMS);
    expect(peek()[0]!.event.email.id).toBe(`e-25`);
  });

  it("expire() is a no-op on an empty queue", () => {
    expect(expire()).toBe(0);
  });
});

describe("connectivity", () => {
  beforeEach(() => resetConnectivity());

  it("reports the backend as unreachable after repeated network failures", () => {
    expect(connectivity()).toBe("online");
    reportNetworkFailure();
    expect(connectivity()).toBe("online");
    reportNetworkFailure();
    expect(connectivity()).toBe("backend-unreachable");
    reportReachable();
    expect(connectivity()).toBe("online");
  });
});

describe("retry policy", () => {
  it("retries only idempotent-safe failures", () => {
    expect(isRetryable(new ApiClientError("network", "x"))).toBe(true);
    expect(isRetryable(new ApiClientError("timeout", "x"))).toBe(true);
    expect(isRetryable(new ApiClientError("generic", "x", 503))).toBe(true);
    expect(isRetryable(new ApiClientError("generic", "x", 429))).toBe(true);
    expect(isRetryable(new ApiClientError("validation", "x", 400))).toBe(false);
    expect(isRetryable(new ApiClientError("unauthorized", "x", 401))).toBe(false);
    expect(isRetryable(new Error("plain"))).toBe(false);
  });

  it("backs off exponentially with jitter, capped at 4 s", () => {
    expect(backoffDelayMs(1, () => 0.5)).toBe(250);
    expect(backoffDelayMs(2, () => 0.5)).toBeGreaterThan(backoffDelayMs(1, () => 0.5));
    expect(backoffDelayMs(10, () => 1)).toBeLessThanOrEqual(4_000 * 1.2);
    expect(backoffDelayMs(1, () => 0)).toBeLessThan(backoffDelayMs(1, () => 1));
  });

  it("produces a correlation id and surfaces it on errors", () => {
    const id = newCorrelationId();
    expect(id.length).toBeGreaterThan(8);
    expect(newCorrelationId()).not.toBe(id);
    const err = new ApiClientError("llm", "boom", 502, "llm_unavailable", "corr-1");
    expect(correlationIdOf(err)).toBe("corr-1");
    expect(err.i18nKey).toBe("errors.llm");
    expect(correlationIdOf(new Error("x"))).toBeUndefined();
  });

  it("maps an SSO failure to an sso error with its office code", () => {
    const err = ApiClientError.fromAuthFailure(Object.assign(new Error("nope"), { officeErrorCode: 13005 }), "corr-2");
    expect(err.kind).toBe("sso");
    expect(err.i18nKey).toBe("errors.sso.13005");
    expect(err.correlationId).toBe("corr-2");
  });

  it("formats an error report without any mail content", () => {
    const report = formatErrorReport({ feature: "chat", message: "boom", correlationId: "corr-3", version: "1.0.0", commit: "abc", at: "2025-05-26T00:00:00Z" });
    expect(report).toContain("corr-3");
    expect(report).toContain("feature:       chat");
    expect(report.split("\n")).toHaveLength(6);
  });
});

describe("telemetry", () => {
  const sent: TelemetryEvent[] = [];
  const sink = { name: "test", send: (events: TelemetryEvent[]) => void sent.push(...events) };

  beforeEach(() => {
    sent.length = 0;
    initTelemetry({ enabled: true, sink, context: { version: "1.0.0" } });
  });
  afterEach(() => vi.useRealTimers());

  it("never forwards email content: unknown keys, long strings and addresses are dropped", () => {
    const cleaned = scrub({
      source: "precomputed",
      ms: 12.3456,
      subject: "Re: Project Horizon",
      from: "sarah.johnson@abccapital.example",
      reason: "x".repeat(200),
      count: 3,
      cacheHit: true,
    });
    expect(cleaned).toEqual({ source: "precomputed", ms: 12.346, count: 3, cacheHit: true });
    expect(Object.keys(cleaned)).not.toContain("subject");
    expect(Object.keys(cleaned)).not.toContain("from");
  });

  it("respects the opt-out immediately", () => {
    track("a.b");
    flushTelemetry();
    expect(sent).toHaveLength(1);
    initTelemetry({ enabled: false, sink });
    track("a.c");
    flushTelemetry();
    expect(sent).toHaveLength(1);
  });

  it("parses an Application Insights connection string", () => {
    const parsed = appInsightsEndpoint("InstrumentationKey=abc-123;IngestionEndpoint=https://westeurope.in.example.com/");
    expect(parsed).toEqual({ url: "https://westeurope.in.example.com/v2/track", instrumentationKey: "abc-123" });
    expect(appInsightsEndpoint("")).toBeNull();
    expect(appInsightsEndpoint("Nope=1")).toBeNull();
  });
});

describe("header-only CSP directives", () => {
  it("keeps frame-ancestors out of the meta tag and exposes it for the HTTP header", () => {
    expect(buildCsp({})).not.toContain("frame-ancestors");
    const header = frameAncestors();
    expect(header).toMatch(/^frame-ancestors 'self'/);
    expect(header).toContain("https://outlook.office.com");
    expect(HEADER_ONLY_DIRECTIVES).toContain("frame-ancestors");
  });
});
