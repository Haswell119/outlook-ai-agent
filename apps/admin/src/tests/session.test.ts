import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/env";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetEnvCache();
});

describe("token-mode session", () => {
  it("maps ADMIN_DEV_ROLES onto the dashboard roles", async () => {
    vi.stubEnv("ADMIN_AUTH_MODE", "token");
    vi.stubEnv("ADMIN_DEV_ROLES", "compliance");
    vi.stubEnv("ADMIN_DEV_EMAIL", "officer@northbridge.example");
    vi.stubEnv("ADMIN_API_TOKEN", "dev-token");
    resetEnvCache();

    const { devSession } = await import("@/lib/session");
    const session = devSession();
    expect(session.roles).toEqual(["compliance", "user"]);
    expect(session.mode).toBe("token");
    expect(session.bearer).toBe("dev-token");
    expect(session.expired).toBe(false);
  });

  it("defaults to an administrator and honours ADMIN_EMAILS", async () => {
    vi.stubEnv("ADMIN_AUTH_MODE", "token");
    vi.stubEnv("ADMIN_DEV_ROLES", "user");
    vi.stubEnv("ADMIN_DEV_EMAIL", "boss@northbridge.example");
    vi.stubEnv("ADMIN_EMAILS", "boss@northbridge.example");
    resetEnvCache();

    const { devSession } = await import("@/lib/session");
    expect(devSession().roles).toEqual(["admin", "user"]);

    vi.stubEnv("ADMIN_DEV_ROLES", "admin");
    vi.stubEnv("ADMIN_EMAILS", "");
    vi.stubEnv("ADMIN_DEV_EMAIL", "admin@northbridge.example");
    resetEnvCache();
    vi.resetModules();
    const again = await import("@/lib/session");
    expect(again.devSession().roles).toEqual(["admin", "user"]);
  });

  it("requireRoles rejects a role that is not allowed", async () => {
    vi.stubEnv("ADMIN_AUTH_MODE", "token");
    vi.stubEnv("ADMIN_DEV_ROLES", "compliance");
    resetEnvCache();

    const { requireRoles, ForbiddenError } = await import("@/lib/session");
    await expect(requireRoles("admin")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireRoles("admin", "compliance")).resolves.toMatchObject({
      mode: "token",
    });
    // No role listed = "any authenticated operator".
    await expect(requireRoles()).resolves.toBeTruthy();
  });
});
