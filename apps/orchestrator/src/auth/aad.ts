import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AppError } from "../errors.js";
import type { AuthenticatedUser, Role } from "./identity.js";
import { rolesFor } from "./identity.js";

export interface AadOptions {
  tenantId: string;
  clientId: string;
  adminEmails: string[];
  complianceEmails: string[];
  /** Test hook: custom verifier. */
  verify?: (token: string) => Promise<JWTPayload>;
}

/**
 * Azure AD v2 token validation: signature via the tenant JWKS, audience
 * (clientId or api://clientId), issuer (v2 or v1 STS), then claim mapping.
 */
export function createAadVerifier(opts: AadOptions): (token: string) => Promise<AuthenticatedUser> {
  const jwks = opts.verify ? undefined : createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${opts.tenantId}/discovery/v2.0/keys`));
  const audiences = [opts.clientId, `api://${opts.clientId}`];
  const issuers = [`https://login.microsoftonline.com/${opts.tenantId}/v2.0`, `https://sts.windows.net/${opts.tenantId}/`];

  return async (token: string): Promise<AuthenticatedUser> => {
    let payload: JWTPayload;
    try {
      payload = opts.verify ? await opts.verify(token) : (await jwtVerify(token, jwks!, { audience: audiences, issuer: issuers })).payload;
    } catch (e) {
      throw AppError.unauthorized(`Invalid token: ${(e as Error).message}`);
    }
    if (opts.verify) {
      // Custom verifier: still enforce audience / issuer / tenant.
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.some((a) => a && audiences.includes(a))) throw AppError.unauthorized("Invalid token audience");
      if (!payload.iss || !issuers.includes(payload.iss)) throw AppError.unauthorized("Invalid token issuer");
    }
    const tid = payload.tid as string | undefined;
    if (tid && tid !== opts.tenantId) throw AppError.unauthorized("Token issued for another tenant");
    const email = ((payload.preferred_username ?? payload.upn ?? payload.email) as string | undefined)?.toLowerCase();
    if (!email) throw AppError.unauthorized("Token has no user identity claim");
    const oid = (payload.oid as string | undefined) ?? (payload.sub as string | undefined) ?? email;
    const claimRoles = ((payload.roles as string[] | undefined) ?? []).map((r) => r.toLowerCase()).filter((r): r is Role => r === "admin" || r === "compliance" || r === "user");
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
