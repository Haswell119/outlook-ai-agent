import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "../errors.js";
import type { AuthenticatedUser, Role } from "./identity.js";
import { rolesFor } from "./identity.js";

export interface AadOptions {
  tenantId: string;
  clientId: string;
  adminEmails: string[];
  complianceEmails: string[];
  /**
   * Extra tenants accepted besides `tenantId` (guest / multi-tenant). Empty =
   * only the home tenant, which is what a single-tenant deployment wants.
   */
  allowedTenants?: string[];
  /**
   * When set (e.g. `access_as_user`), the token must carry it in `scp`
   * (delegated) or in `roles` (application). Without this check, *any* token
   * issued for this audience — including one obtained for a different API
   * surface — would be accepted.
   */
  requiredScope?: string;
  /** Accepted clock skew in seconds (default 60). */
  clockToleranceSeconds?: number;
  /** Test hook: custom verifier. */
  verify?: (token: string) => Promise<JWTPayload>;
}

/**
 * Azure AD v2 token validation.
 *
 * `createRemoteJWKSet` caches the tenant's signing keys and **re-fetches on a
 * `kid` miss** (rate-limited by `cooldownDuration`), which is exactly the
 * behaviour needed when Microsoft rolls a signing key: no restart, no outage,
 * and no unbounded fetching if someone sends garbage `kid`s.
 *
 * Checks, in order: signature → audience → issuer → expiry (with skew) →
 * tenant allow-list → required scope → claim mapping to roles.
 */
export function createAadVerifier(opts: AadOptions): (token: string) => Promise<AuthenticatedUser> {
  const jwks = opts.verify
    ? undefined
    : createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`), {
        // Keys are cached for 10 min; a kid miss triggers a refresh at most every 30 s.
        cacheMaxAge: 600_000,
        cooldownDuration: 30_000,
        timeoutDuration: 5_000,
      });
  const audiences = [opts.clientId, `api://${opts.clientId}`];
  const issuers = [`https://login.microsoftonline.com/${opts.tenantId}/v2.0`, `https://sts.windows.net/${opts.tenantId}/`];
  const clockTolerance = opts.clockToleranceSeconds ?? 60;
  const allowedTenants = new Set([opts.tenantId, ...(opts.allowedTenants ?? [])].map((t) => t.toLowerCase()));

  return async (token: string): Promise<AuthenticatedUser> => {
    let payload: JWTPayload;
    try {
      payload = opts.verify ? await opts.verify(token) : (await jwtVerify(token, jwks!, { audience: audiences, issuer: issuers, clockTolerance })).payload;
    } catch (e) {
      throw AppError.unauthorized(`Invalid token: ${(e as Error).message}`);
    }
    if (opts.verify) {
      // Custom verifier: still enforce audience / issuer / expiry.
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.some((a) => a && audiences.includes(a))) throw AppError.unauthorized("Invalid token audience");
      if (!payload.iss || !issuers.includes(payload.iss)) throw AppError.unauthorized("Invalid token issuer");
      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === "number" && payload.exp + clockTolerance < now) throw AppError.unauthorized("Token expired");
      if (typeof payload.nbf === "number" && payload.nbf - clockTolerance > now) throw AppError.unauthorized("Token not yet valid");
    }

    const tid = (payload.tid as string | undefined)?.toLowerCase();
    if (tid && !allowedTenants.has(tid)) throw AppError.unauthorized("Token issued for another tenant");

    const scopes = String(payload.scp ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const appRoles = ((payload.roles as string[] | undefined) ?? []).map((r) => String(r));
    if (opts.requiredScope) {
      const want = opts.requiredScope.toLowerCase();
      const ok = scopes.some((s) => s.toLowerCase() === want) || appRoles.some((r) => r.toLowerCase() === want);
      if (!ok) throw AppError.unauthorized(`Token is missing the required scope/role "${opts.requiredScope}"`);
    }

    const email = ((payload.preferred_username ?? payload.upn ?? payload.email) as string | undefined)?.toLowerCase();
    if (!email) throw AppError.unauthorized("Token has no user identity claim");
    const oid = (payload.oid as string | undefined) ?? (payload.sub as string | undefined) ?? email;
    const claimRoles = appRoles.map((r) => r.toLowerCase()).filter((r): r is Role => r === "admin" || r === "compliance" || r === "user");
    return {
      id: oid,
      email,
      displayName: (payload.name as string | undefined) ?? email,
      tenantId: tid,
      roles: rolesFor(email, opts.adminEmails, opts.complianceEmails, claimRoles),
      token,
      via: "aad-jwt",
    };
  };
}
