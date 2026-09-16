import type { UserIdentity } from "@oao/shared";

export type Role = UserIdentity["roles"][number];

export interface AuthenticatedUser extends UserIdentity {
  /** Raw bearer token when present (used for Graph OBO). */
  token?: string;
  /** How the identity was established. */
  via: "dev-headers" | "admin-token" | "aad-jwt";
}

export const hasRole = (user: Pick<UserIdentity, "roles">, role: Role): boolean => user.roles.includes(role) || (role !== "admin" && user.roles.includes("admin"));

export function rolesFor(email: string, adminEmails: string[], complianceEmails: string[], extra: Role[] = []): Role[] {
  const e = email.toLowerCase();
  const roles = new Set<Role>(["user", ...extra]);
  if (adminEmails.map((x) => x.toLowerCase()).includes(e)) roles.add("admin");
  if (complianceEmails.map((x) => x.toLowerCase()).includes(e)) roles.add("compliance");
  return Array.from(roles);
}
