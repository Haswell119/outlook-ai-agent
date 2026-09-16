/**
 * Microsoft Entra ID token plumbing, free of any `next-auth` / `next` import so
 * it can be unit-tested and reused from the edge runtime.
 *
 * `src/auth.ts` wires these helpers into the Auth.js `jwt` callback.
 */
import { env } from "@/env";
import { rolesFromClaims, type AdminRole } from "./rbac";

/** Skew applied before an access token is considered stale (ms). */
export const REFRESH_SKEW_MS = 60_000;

/** Decodes the payload of a JWS without verifying it (the IdP just issued it). */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const json =
      typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** `https://login.microsoftonline.com/<tid>/v2.0` → `…/<tid>/oauth2/v2.0/token`. */
export function tokenEndpointFromIssuer(issuer: string): string {
  const base = issuer.replace(/\/+$/, "").replace(/\/v2\.0$/, "");
  return `${base}/oauth2/v2.0/token`;
}

/**
 * Scopes requested at sign-in and on every refresh. `offline_access` is what
 * makes the refresh token available; the `api://…/access_as_user` scope is what
 * makes the resulting access token usable against the orchestrator.
 */
export function requestedScopes(): string {
  const e = env();
  return ["openid", "profile", "email", "offline_access", e.apiScope].filter(Boolean).join(" ");
}

/** Roles carried by an access token, with the email-list fallback. */
export function rolesFromAccessToken(
  accessToken: string | undefined,
  email: string | null | undefined,
): AdminRole[] {
  const e = env();
  return rolesFromClaims({
    roles: decodeJwtPayload(accessToken).roles,
    email,
    adminEmails: e.ADMIN_EMAILS,
    complianceEmails: e.COMPLIANCE_EMAILS,
  });
}

/**
 * Exchanges the stored refresh token for a new access token.
 *
 * Rotation: Entra ID returns a fresh refresh token, which replaces the previous
 * one. A failure marks the token `RefreshAccessTokenError` instead of throwing,
 * so the session survives long enough to tell the operator to sign in again.
 */
export async function refreshAccessToken<T extends Record<string, unknown>>(token: T): Promise<T> {
  const e = env();
  const issuer = e.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  const refreshToken = token.refreshToken as string | undefined;
  if (!issuer || !refreshToken || !e.AUTH_MICROSOFT_ENTRA_ID_ID) {
    return { ...token, error: "RefreshAccessTokenError" };
  }
  try {
    const res = await fetch(tokenEndpointFromIssuer(issuer), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: e.AUTH_MICROSOFT_ENTRA_ID_ID,
        client_secret: e.AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: requestedScopes(),
      }),
    });
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token) throw new Error(body.error ?? `HTTP ${res.status}`);
    const next: Record<string, unknown> = {
      ...token,
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (body.expires_in ?? 3_300) * 1000,
      roles: rolesFromAccessToken(body.access_token, token.email as string | undefined),
    };
    delete next.error;
    return next as T;
  } catch (error) {
    console.error("[@oao/admin] refresh_token grant failed", error);
    return { ...token, error: "RefreshAccessTokenError" };
  }
}
