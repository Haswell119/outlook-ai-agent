import type { AuthenticatedUser, Role } from "./identity.js";
import { rolesFor } from "./identity.js";

export interface DevAuthOptions {
  adminEmails: string[];
  complianceEmails: string[];
}

export const DEV_DEFAULT_EMAIL = "dev.user@longbow.ch";

/** Dev identity from `x-user-email` / `x-user-name` (+ optional `x-user-roles`). Never used in production. */
export function devIdentity(headers: Record<string, string | string[] | undefined>, opts: DevAuthOptions): AuthenticatedUser {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const email = (one(headers["x-user-email"]) ?? DEV_DEFAULT_EMAIL).trim().toLowerCase();
  const name = one(headers["x-user-name"])?.trim();
  const extra = (one(headers["x-user-roles"]) ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is Role => r === "user" || r === "compliance" || r === "admin");
  const auth = one(headers.authorization);
  return {
    id: email,
    email,
    displayName: name || email.split("@")[0]?.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    roles: rolesFor(email, opts.adminEmails, opts.complianceEmails, extra),
    token: auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined,
    via: "dev-headers",
  };
}

export function adminTokenIdentity(adminEmails: string[]): AuthenticatedUser {
  const email = adminEmails[0] ?? "admin@longbow.ch";
  return { id: "admin-dashboard", email, displayName: "Admin dashboard", roles: ["user", "compliance", "admin"], via: "admin-token" };
}
