/**
 * Auth headers for the orchestrator.
 *
 *  - `VITE_AUTH_MODE=dev`  → `x-user-email` / `x-user-name` from
 *    `Office.context.mailbox.userProfile` (dev / demo only; the orchestrator
 *    rejects these headers when it runs with AUTH_MODE=aad).
 *  - `VITE_AUTH_MODE=aad`  → Office SSO bearer token from
 *    `OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: true,
 *    allowConsentPrompt: true, forMSGraphAccess: false })`.
 *
 * Production hardening implemented here:
 *  - the token is cached **in memory only** (never localStorage: a bearer token
 *    for the mailbox must not survive the pane or be readable by another add-in)
 *  - the real expiry is parsed from the JWT `exp` claim and refreshed 5 minutes
 *    early; when `exp` is unreadable we fall back to a conservative 30 minutes
 *  - concurrent callers share one in-flight `getAccessToken` promise, so opening
 *    the pane (which fires several requests at once) never triggers several
 *    sign-in prompts
 *  - a proactive refresh timer is *not* used (a background prompt would steal
 *    focus); the token is refreshed lazily on the next call
 *  - every documented Office error code (13001–13013) is mapped to an
 *    actionable message and a retry decision; the dialog/MSAL fallback is out of
 *    scope, so codes that require it point at the runbook instead
 *
 * See the SSO troubleshooting table in README.md.
 */
import { currentUser, isOfficeAvailable, isSetSupported } from "./env";
import { track } from "@/telemetry";

export type AuthMode = "dev" | "aad";

export function authMode(): AuthMode {
  return import.meta.env.VITE_AUTH_MODE === "aad" ? "aad" : "dev";
}

/** Refresh this long before the real expiry. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Used when the JWT has no readable `exp`. */
const FALLBACK_TTL_MS = 30 * 60 * 1000;

export interface SsoDiagnosis {
  code: number;
  /** i18n key under `errors.sso.*`. */
  i18nKey: string;
  /** Retrying the same call may succeed (transient / prompt-related). */
  retryable: boolean;
  /** The admin has to act (consent, app registration, tenant policy). */
  needsAdmin: boolean;
  /** The documented fallback is an MSAL dialog, which this add-in does not ship. */
  needsDialogFallback: boolean;
}

/**
 * The documented `OfficeRuntime.auth.getAccessToken` error codes.
 * https://learn.microsoft.com/office/dev/add-ins/develop/troubleshoot-sso-in-office-add-ins
 */
export const SSO_ERRORS: Record<number, SsoDiagnosis> = {
  13000: { code: 13000, i18nKey: "errors.sso.13000", retryable: false, needsAdmin: true, needsDialogFallback: true },
  13001: { code: 13001, i18nKey: "errors.sso.13001", retryable: true, needsAdmin: false, needsDialogFallback: false },
  13002: { code: 13002, i18nKey: "errors.sso.13002", retryable: true, needsAdmin: false, needsDialogFallback: false },
  13003: { code: 13003, i18nKey: "errors.sso.13003", retryable: false, needsAdmin: true, needsDialogFallback: true },
  13004: { code: 13004, i18nKey: "errors.sso.13004", retryable: false, needsAdmin: true, needsDialogFallback: false },
  13005: { code: 13005, i18nKey: "errors.sso.13005", retryable: false, needsAdmin: true, needsDialogFallback: true },
  13006: { code: 13006, i18nKey: "errors.sso.13006", retryable: true, needsAdmin: false, needsDialogFallback: false },
  13007: { code: 13007, i18nKey: "errors.sso.13007", retryable: true, needsAdmin: false, needsDialogFallback: true },
  13008: { code: 13008, i18nKey: "errors.sso.13008", retryable: true, needsAdmin: false, needsDialogFallback: false },
  13009: { code: 13009, i18nKey: "errors.sso.13009", retryable: false, needsAdmin: false, needsDialogFallback: true },
  13010: { code: 13010, i18nKey: "errors.sso.13010", retryable: false, needsAdmin: true, needsDialogFallback: true },
  13012: { code: 13012, i18nKey: "errors.sso.13012", retryable: false, needsAdmin: false, needsDialogFallback: true },
  13013: { code: 13013, i18nKey: "errors.sso.13013", retryable: true, needsAdmin: false, needsDialogFallback: false },
};

export function diagnoseSso(code: number | undefined): SsoDiagnosis | null {
  if (typeof code !== "number") return null;
  return SSO_ERRORS[code] ?? { code, i18nKey: "errors.sso.generic", retryable: false, needsAdmin: false, needsDialogFallback: true };
}

/** Error carrying the Office SSO error code so the UI can explain it. */
export class SsoError extends Error {
  constructor(
    message: string,
    public readonly officeErrorCode?: number,
    public readonly diagnosis: SsoDiagnosis | null = diagnoseSso(officeErrorCode),
  ) {
    super(message);
    this.name = "SsoError";
  }
}

/**
 * Read `exp` out of a JWT without verifying it (the orchestrator verifies the
 * signature; we only need to know when to ask for a new one). Returns epoch ms
 * or null when the token is opaque / malformed.
 */
export function parseJwtExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = JSON.parse(typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("utf8")) as { exp?: unknown };
    const exp = typeof json.exp === "number" ? json.exp : Number.NaN;
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

interface CachedToken {
  value: string;
  /** Epoch ms after which we must not use it any more. */
  usableUntil: number;
}

let cachedToken: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

function devHeaders(): Record<string, string> {
  const user = currentUser();
  return { "x-user-email": user.email, "x-user-name": user.name };
}

function officeRuntime(): typeof OfficeRuntime | undefined {
  return (globalThis as { OfficeRuntime?: typeof OfficeRuntime }).OfficeRuntime;
}

/** True when the host exposes the Identity API (requirement set 1.3). */
export function ssoSupported(): boolean {
  const runtime = officeRuntime();
  if (!runtime?.auth?.getAccessToken) return false;
  // isSetSupported("IdentityAPI", "1.3") is authoritative when available.
  return isSetSupported("IdentityAPI", "1.3") || isSetSupported("Mailbox", "1.5");
}

async function fetchToken(): Promise<string> {
  const runtime = officeRuntime();
  if (!runtime?.auth?.getAccessToken) throw new SsoError("OfficeRuntime.auth is unavailable in this Outlook client");
  let token: string;
  try {
    token = await runtime.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true, forMSGraphAccess: false });
  } catch (err) {
    const code = (err as { code?: unknown; errorCode?: unknown }).code ?? (err as { errorCode?: unknown }).errorCode;
    const numeric = typeof code === "number" ? code : Number.parseInt(String(code ?? ""), 10);
    const diagnosis = diagnoseSso(Number.isFinite(numeric) ? numeric : undefined);
    track("sso.failed", { code: diagnosis ? String(diagnosis.code) : "unknown" }, { severity: "warning" });
    throw new SsoError(err instanceof Error ? err.message : "getAccessToken failed", Number.isFinite(numeric) ? numeric : undefined, diagnosis);
  }
  if (!token) throw new SsoError("getAccessToken returned an empty token");
  const exp = parseJwtExpiry(token);
  const usableUntil = exp ? exp - REFRESH_SKEW_MS : Date.now() + FALLBACK_TTL_MS;
  cachedToken = { value: token, usableUntil };
  track("sso.token", { ms: Math.max(0, usableUntil - Date.now()) });
  return token;
}

/** Cached SSO token; concurrent callers share a single request. */
export async function getSsoToken(): Promise<string> {
  if (cachedToken && cachedToken.usableUntil > Date.now()) return cachedToken.value;
  if (inFlight) return inFlight;
  inFlight = fetchToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function invalidateToken(): void {
  cachedToken = null;
}

/** Diagnostics for the settings sheet (never the token itself). */
export function tokenStatus(): { cached: boolean; expiresInMs: number | null } {
  if (!cachedToken) return { cached: false, expiresInMs: null };
  return { cached: true, expiresInMs: Math.max(0, cachedToken.usableUntil - Date.now()) };
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (authMode() === "dev" || !isOfficeAvailable()) return devHeaders();
  try {
    const token = await getSsoToken();
    return { Authorization: `Bearer ${token}` };
  } catch (err) {
    // A retryable failure (user cancelled the prompt, transient) is worth one
    // immediate second attempt: Office frequently succeeds on the retry.
    const diagnosis = err instanceof SsoError ? err.diagnosis : null;
    if (diagnosis?.retryable) {
      invalidateToken();
      try {
        return { Authorization: `Bearer ${await getSsoToken()}` };
      } catch (retryErr) {
        if (import.meta.env.DEV) {
          console.warn("[oao] SSO failed twice, falling back to dev headers", retryErr);
          return devHeaders();
        }
        throw retryErr;
      }
    }
    if (import.meta.env.DEV) {
      console.warn("[oao] SSO failed, falling back to dev headers", err);
      return devHeaders();
    }
    throw err;
  }
}
