/**
 * Content-Security-Policy for the task pane.
 *
 * The policy is built here (and unit-tested) rather than hand-written in the
 * HTML, because `connect-src` must be narrowed to the *configured* backend
 * origin at build time — a pane that can only talk to its own orchestrator
 * cannot exfiltrate mail content even if a dependency is compromised.
 *
 * Origins that must stay allowed:
 *  - `https://appsforoffice.microsoft.com` — office.js itself
 *  - `https://*.office.net`, `https://*.officeapps.live.com` — the Office CDN
 *    and the host webview shims that office.js loads at runtime
 *  - `https://res.cdn.office.net` — Office UI assets used by some hosts
 *
 * `style-src` needs `'unsafe-inline'`: Fluent UI v9 (Griffel) injects its
 * atomic CSS into a stylesheet at runtime. `unsafe-eval` is *not* granted and
 * Griffel does not need it.
 */

/**
 * Directives that a browser **ignores** in a `<meta>` tag and only honours as a
 * real HTTP header. They are exported separately so the static host (nginx, see
 * `infra/`) can send them, and are deliberately left out of the meta tag — a
 * meta-only `frame-ancestors` logs a console warning on every page load and
 * protects nothing.
 */
export const HEADER_ONLY_DIRECTIVES = ["frame-ancestors", "report-to", "sandbox"] as const;

export interface CspOptions {
  /** Backend origin, e.g. `https://api.example.com`. `''` → only 'self'. */
  apiOrigin?: string;
  /** Dev build: allow the Vite HMR websocket and the local dev origin. */
  dev?: boolean;
  /** Extra connect-src origins (telemetry / Application Insights). */
  extraConnect?: string[];
  /** Report-only endpoint, when the deployment collects violations. */
  reportUri?: string;
}

const OFFICE_SCRIPT = ["https://appsforoffice.microsoft.com", "https://*.office.net", "https://*.officeapps.live.com"];
const OFFICE_IMG = ["https://res.cdn.office.net", "https://*.office.net"];

/** Normalise a URL or origin to a bare origin, or return null when unusable. */
export function toOrigin(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    /* maybe it is already an origin without a scheme */
  }
  try {
    return new URL(`https://${raw}`).origin;
  } catch {
    return null;
  }
}

function uniq(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/** Build the CSP header/meta value. */
export function buildCsp(options: CspOptions = {}): string {
  const api = toOrigin(options.apiOrigin);
  const extra = uniq((options.extraConnect ?? []).map(toOrigin));
  const connect = uniq([
    "'self'",
    api,
    ...extra,
    ...(options.dev ? ["ws://localhost:*", "wss://localhost:*", "http://localhost:*", "https://localhost:*"] : []),
  ]);

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", uniq(["'self'", ...OFFICE_SCRIPT, ...(options.dev ? ["'unsafe-inline'"] : [])])],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", uniq(["'self'", "data:", ...OFFICE_IMG])],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connect],
    ["frame-src", ["'self'", ...OFFICE_SCRIPT]],
    ["form-action", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["worker-src", ["'self'", "blob:"]],
  ];
  if (options.reportUri) directives.push(["report-uri", [options.reportUri]]);

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

/**
 * `frame-ancestors` for the HTTP header: which hosts may frame the task pane.
 * Outlook always loads an add-in inside its own webview/iframe, so this is the
 * list the static host must allow.
 */
export function frameAncestors(): string {
  return `frame-ancestors ${uniq([
    "'self'",
    ...OFFICE_SCRIPT,
    "https://outlook.office.com",
    "https://outlook.office365.com",
    "https://outlook.live.com",
    "https://*.outlook.com",
  ]).join(" ")}`;
}

/** The `<meta>` tag injected into taskpane.html / commands.html at build time. */
export function cspMetaTag(options: CspOptions = {}): string {
  return `<meta http-equiv="Content-Security-Policy" content="${buildCsp(options).replace(/"/g, "&quot;")}" />`;
}
