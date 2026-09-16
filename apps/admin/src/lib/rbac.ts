/**
 * Role mapping and route authorisation — the single source of truth shared by
 * the middleware, the layout (navigation), the pages and the route handlers.
 *
 * Pure functions only: no `next/*`, no `server-only`, no environment access, so
 * the same code runs on the edge runtime, in React Server Components and in the
 * unit tests.
 */

export const ADMIN_ROLES = ["admin", "compliance", "user"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Roles that may open the dashboard at all. */
export const DASHBOARD_ROLES: AdminRole[] = ["admin", "compliance"];

/**
 * Normalises one role value as it can appear in an Entra ID `roles` claim.
 * Accepted spellings: `Admin`, `admin`, `ADMIN`, `Oao.Admin`, `oao:compliance`,
 * `Compliance.Officer` → `compliance`.
 */
export function normalizeRole(raw: unknown): AdminRole | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.trim().toLowerCase();
  if (cleaned.length === 0) return undefined;
  const parts = cleaned.split(/[.:/\s_-]+/).filter(Boolean);
  const candidates = [cleaned, ...parts];
  if (candidates.some((c) => c === "admin" || c === "administrator")) return "admin";
  if (candidates.some((c) => c === "compliance" || c === "complianceofficer")) return "compliance";
  if (candidates.some((c) => c === "user" || c === "member")) return "user";
  return undefined;
}

export interface RoleClaimInput {
  /** `roles` claim of the access token (array, or a space/comma separated string). */
  roles?: unknown;
  email?: string | null | undefined;
  /** `ADMIN_EMAILS` fallback (used when the token carries no app role). */
  adminEmails?: readonly string[];
  /** `COMPLIANCE_EMAILS` fallback. */
  complianceEmails?: readonly string[];
}

const byPrecedence = (a: AdminRole, b: AdminRole) => ADMIN_ROLES.indexOf(a) - ADMIN_ROLES.indexOf(b);

/**
 * Resolves the effective roles of a signed-in operator.
 *
 * App roles from the token win; `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` are the
 * documented fallback for tenants that have not assigned app roles yet. Anyone
 * who authenticated is at least a `user`.
 */
export function rolesFromClaims(input: RoleClaimInput): AdminRole[] {
  const raw: unknown[] = Array.isArray(input.roles)
    ? input.roles
    : typeof input.roles === "string"
      ? input.roles.split(/[,\s]+/)
      : [];

  const found = new Set<AdminRole>();
  for (const candidate of raw) {
    const role = normalizeRole(candidate);
    if (role) found.add(role);
  }

  const email = input.email?.trim().toLowerCase();
  if (email) {
    if (input.adminEmails?.some((e) => e.toLowerCase() === email)) found.add("admin");
    if (input.complianceEmails?.some((e) => e.toLowerCase() === email)) found.add("compliance");
  }

  found.add("user");
  return [...found].sort(byPrecedence);
}

export function hasRole(roles: readonly AdminRole[] | undefined, role: AdminRole): boolean {
  return (roles ?? []).includes(role);
}

/** Highest-privilege role, used for the badge in the top bar. */
export function primaryRole(roles: readonly AdminRole[] | undefined): AdminRole {
  if (hasRole(roles, "admin")) return "admin";
  if (hasRole(roles, "compliance")) return "compliance";
  return "user";
}

/* --------------------------------------------------------------------------- */
/*  Route authorisation                                                        */
/* --------------------------------------------------------------------------- */

/** Pages reachable without a session (or without a dashboard role). */
export const PUBLIC_PATHS = ["/signin", "/no-access", "/auth-error"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Longest-prefix wins, so `/audit/[id]` inherits `/audit`. `admin` sees
 * everything; `compliance` is limited to approvals, alerts and the audit trail
 * (including its CSV export and event details).
 */
const ROUTE_RULES: ReadonlyArray<{ prefix: string; roles: readonly AdminRole[] }> = [
  { prefix: "/approvals", roles: ["admin", "compliance"] },
  { prefix: "/alerts", roles: ["admin", "compliance"] },
  { prefix: "/audit", roles: ["admin", "compliance"] },
  { prefix: "/api/audit", roles: ["admin", "compliance"] },
  { prefix: "/api/escalations", roles: ["admin", "compliance"] },
  { prefix: "/api/approvals", roles: ["admin", "compliance"] },
  { prefix: "/", roles: ["admin"] },
];

/** Roles allowed on `pathname`. */
export function routeRoles(pathname: string): readonly AdminRole[] {
  const path = normalizePath(pathname);
  let best: { prefix: string; roles: readonly AdminRole[] } | undefined;
  for (const rule of ROUTE_RULES) {
    const matches =
      rule.prefix === "/" ? true : path === rule.prefix || path.startsWith(`${rule.prefix}/`);
    if (matches && (!best || rule.prefix.length > best.prefix.length)) best = rule;
  }
  return best?.roles ?? ["admin"];
}

function normalizePath(pathname: string): string {
  if (!pathname.startsWith("/")) return `/${pathname}`;
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** True when at least one of `roles` is allowed on `pathname`. */
export function canAccess(pathname: string, roles: readonly AdminRole[] | undefined): boolean {
  if (isPublicPath(pathname)) return true;
  const allowed = routeRoles(pathname);
  return (roles ?? []).some((r) => allowed.includes(r));
}

/** Where to send an operator who just signed in (or hit a forbidden page). */
export function landingPath(roles: readonly AdminRole[] | undefined): string {
  if (hasRole(roles, "admin")) return "/";
  if (hasRole(roles, "compliance")) return "/approvals";
  return "/no-access";
}
