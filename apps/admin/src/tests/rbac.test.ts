import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLES,
  canAccess,
  isPublicPath,
  landingPath,
  normalizeRole,
  primaryRole,
  rolesFromClaims,
  routeRoles,
} from "@/lib/rbac";
import { visibleNavGroups } from "@/components/layout/nav";
import { config as middlewareConfig } from "@/middleware";

describe("role mapping from the Entra ID token", () => {
  it("normalises the spellings an app role can take", () => {
    expect(normalizeRole("Admin")).toBe("admin");
    expect(normalizeRole("ADMIN")).toBe("admin");
    expect(normalizeRole("Oao.Admin")).toBe("admin");
    expect(normalizeRole("oao:compliance")).toBe("compliance");
    expect(normalizeRole("Compliance.Officer")).toBe("compliance");
    expect(normalizeRole("Member")).toBe("user");
    expect(normalizeRole("Something.Else")).toBeUndefined();
    expect(normalizeRole(42)).toBeUndefined();
    expect(normalizeRole("")).toBeUndefined();
  });

  it("reads the `roles` claim as an array or a delimited string", () => {
    expect(rolesFromClaims({ roles: ["Admin"] })).toEqual(["admin", "user"]);
    expect(rolesFromClaims({ roles: "Compliance User" })).toEqual(["compliance", "user"]);
    expect(rolesFromClaims({ roles: "admin,compliance" })).toEqual(ADMIN_ROLES.slice());
    expect(rolesFromClaims({})).toEqual(["user"]);
  });

  it("falls back to ADMIN_EMAILS / COMPLIANCE_EMAILS when no app role is assigned", () => {
    expect(
      rolesFromClaims({
        email: "Admin@Northbridge.example",
        adminEmails: ["admin@northbridge.example"],
      }),
    ).toEqual(["admin", "user"]);
    expect(
      rolesFromClaims({
        email: "officer@northbridge.example",
        complianceEmails: ["officer@northbridge.example"],
      }),
    ).toEqual(["compliance", "user"]);
    expect(
      rolesFromClaims({ email: "someone@northbridge.example", adminEmails: ["other@x.example"] }),
    ).toEqual(["user"]);
  });

  it("exposes the highest-privilege role", () => {
    expect(primaryRole(["user", "compliance", "admin"])).toBe("admin");
    expect(primaryRole(["user", "compliance"])).toBe("compliance");
    expect(primaryRole(["user"])).toBe("user");
    expect(primaryRole(undefined)).toBe("user");
  });
});

describe("route authorisation", () => {
  it("limits compliance officers to approvals, alerts and the audit trail", () => {
    for (const path of ["/approvals", "/alerts", "/audit", "/audit/aud-00001", "/api/audit/export"]) {
      expect(canAccess(path, ["compliance", "user"])).toBe(true);
    }
    for (const path of ["/", "/system", "/policy", "/users", "/analytics", "/settings"]) {
      expect(canAccess(path, ["compliance", "user"])).toBe(false);
      expect(canAccess(path, ["admin", "user"])).toBe(true);
    }
  });

  it("locks a plain user out of everything but the public pages", () => {
    expect(canAccess("/", ["user"])).toBe(false);
    expect(canAccess("/approvals", ["user"])).toBe(false);
    expect(isPublicPath("/signin")).toBe(true);
    expect(isPublicPath("/no-access")).toBe(true);
    expect(canAccess("/no-access", ["user"])).toBe(true);
    expect(isPublicPath("/audit")).toBe(false);
  });

  it("resolves the longest matching prefix and tolerates trailing slashes", () => {
    expect(routeRoles("/audit/aud-1")).toEqual(["admin", "compliance"]);
    expect(routeRoles("/auditor")).toEqual(["admin"]);
    expect(routeRoles("/approvals/")).toEqual(["admin", "compliance"]);
    expect(routeRoles("/unknown/page")).toEqual(["admin"]);
  });

  it("sends each role to a landing page it is allowed to open", () => {
    expect(landingPath(["admin", "user"])).toBe("/");
    expect(landingPath(["compliance", "user"])).toBe("/approvals");
    expect(landingPath(["user"])).toBe("/no-access");
    expect(canAccess(landingPath(["compliance", "user"]), ["compliance", "user"])).toBe(true);
  });
});

describe("navigation", () => {
  it("only lists links the role may open", () => {
    const complianceLinks = visibleNavGroups(["compliance", "user"])
      .flatMap((g) => g.items)
      .map((i) => i.href);
    expect(complianceLinks).toEqual(["/audit", "/approvals", "/alerts"]);

    const adminLinks = visibleNavGroups(["admin", "user"])
      .flatMap((g) => g.items)
      .map((i) => i.href);
    expect(adminLinks).toContain("/");
    expect(adminLinks).toContain("/system");
    expect(adminLinks).toContain("/policy");
    expect(visibleNavGroups(["user"])).toEqual([]);
  });
});

describe("middleware matcher", () => {
  const matcher = middlewareConfig.matcher[0] as string;
  const matches = (pathname: string) => new RegExp(`^${matcher}$`).test(pathname);

  it("covers every page and API route", () => {
    expect(matches("/")).toBe(true);
    expect(matches("/approvals")).toBe(true);
    expect(matches("/audit/aud-00001")).toBe(true);
    expect(matches("/api/policy")).toBe(true);
  });

  it("skips Auth.js endpoints and static assets", () => {
    expect(matches("/api/auth/callback/microsoft-entra-id")).toBe(false);
    expect(matches("/_next/static/chunks/main.js")).toBe(false);
    expect(matches("/_next/image")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/icon.svg")).toBe(false);
  });
});

describe("audit query resolution", () => {
  it("carries the AI source and model filters, rejecting unknown sources", async () => {
    const { resolveQuery } = await import("@/lib/query");
    const q = resolveQuery({ source: "cache", model: "qwen3-30b-a3b", page: "2" });
    expect(q.source).toBe("cache");
    expect(q.model).toBe("qwen3-30b-a3b");
    expect(q.page).toBe(2);
    expect(resolveQuery({ source: "made-up" }).source).toBeUndefined();
  });

  it("filters the mock dataset on details.source and model", async () => {
    const { filterEvents, mockAuditPage } = await import("@/lib/mock-data");
    const cached = filterEvents({ source: "cache" });
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.every((e) => e.details.source === "cache")).toBe(true);

    const page = mockAuditPage({ source: "llm", model: "qwen3-30b-a3b", pageSize: 10 });
    expect(page.items.length).toBeLessThanOrEqual(10);
    expect(page.items.every((e) => e.model === "qwen3-30b-a3b")).toBe(true);
    expect(page.total).toBeLessThan(filterEvents({}).length);
  });
});
