/**
 * Resolves "who is looking at this page", for both authentication modes.
 *
 *  - `ADMIN_AUTH_MODE=aad`   → the Auth.js session (Entra ID), whose roles come
 *    from the `roles` claim and whose access token is forwarded to the
 *    orchestrator.
 *  - `ADMIN_AUTH_MODE=token` → the legacy development identity: the shared
 *    `ADMIN_API_TOKEN` plus `x-user-email`, with roles from `ADMIN_DEV_ROLES`.
 *    Used for local work, the e2e suite and demos.
 */
import "server-only";
import { env } from "@/env";
import { rolesFromClaims, type AdminRole } from "./rbac";

export interface AdminSession {
  email: string;
  name: string;
  roles: AdminRole[];
  /** Bearer forwarded to the orchestrator (user access token, or the dev token). */
  bearer?: string;
  mode: "aad" | "token";
  /** Set when the refresh-token rotation failed: the operator must sign in again. */
  expired: boolean;
}

export function devSession(): AdminSession {
  const e = env();
  return {
    email: e.ADMIN_DEV_EMAIL,
    name: e.ADMIN_DEV_NAME,
    roles: rolesFromClaims({
      roles: e.ADMIN_DEV_ROLES,
      email: e.ADMIN_DEV_EMAIL,
      adminEmails: e.ADMIN_EMAILS,
      complianceEmails: e.COMPLIANCE_EMAILS,
    }),
    bearer: e.ADMIN_API_TOKEN,
    mode: "token",
    expired: false,
  };
}

/** `null` when nobody is signed in (aad mode without a valid session). */
export async function getAdminSession(): Promise<AdminSession | null> {
  const e = env();
  if (e.ADMIN_AUTH_MODE === "token") {
    // Never hand out the unauthenticated development identity in production:
    // `requireRoles` then throws 401 for every server action and route handler.
    // See `AdminEnv.insecureAuthMode`.
    if (e.insecureAuthMode) return null;
    return devSession();
  }

  // Imported lazily so `token` mode never loads the Auth.js provider chain.
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user) return null;
  const email = session.user.email ?? "";
  return {
    email,
    name: session.user.name ?? email,
    roles: session.roles ?? ["user"],
    bearer: session.accessToken,
    mode: "aad",
    expired: session.error === "RefreshAccessTokenError",
  };
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Re-check used by every server action and route handler — the middleware is a
 * first line of defence, never the only one.
 */
export async function requireRoles(...allowed: AdminRole[]): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) throw new UnauthorizedError();
  if (allowed.length > 0 && !session.roles.some((r) => allowed.includes(r))) {
    throw new ForbiddenError(`requires one of: ${allowed.join(", ")}`);
  }
  return session;
}
