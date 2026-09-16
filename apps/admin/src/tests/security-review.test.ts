/**
 * Regression tests for the findings of the 2026-09 security review.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv, resetEnvCache } from "@/env";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  resetEnvCache();
});

/**
 * `ADMIN_AUTH_MODE` defaults to `token`, which hands `ADMIN_DEV_ROLES`
 * (default: `admin`) to whoever opens the page — no sign-in, no credential.
 * Nothing refused that in production, so a deployment that forgot to set
 * `ADMIN_AUTH_MODE=aad` published the audit trail of all 50 mailboxes and the
 * Policy Center to anyone who could reach the URL. The orchestrator has always
 * refused the analogous `AUTH_MODE=dev`; the dashboard now does too.
 */
describe("unauthenticated token mode is refused in production", () => {
  const base = { ORCHESTRATOR_URL: "https://api.northbridge.example", AUTH_SECRET: "x" };

  it("flags production + token mode as insecure", () => {
    expect(parseEnv({ ...base, NODE_ENV: "production", ADMIN_AUTH_MODE: "token" }).insecureAuthMode).toBe(true);
  });

  it("leaves development, the demo dataset and aad mode alone", () => {
    expect(parseEnv({ ...base, NODE_ENV: "development", ADMIN_AUTH_MODE: "token" }).insecureAuthMode).toBe(false);
    // ADMIN_MOCK never reaches the orchestrator, so the demo build stays usable.
    expect(parseEnv({ ...base, NODE_ENV: "production", ADMIN_AUTH_MODE: "token", ADMIN_MOCK: "true" }).insecureAuthMode).toBe(false);
    expect(
      parseEnv({
        ...base,
        NODE_ENV: "production",
        ADMIN_AUTH_MODE: "aad",
        AUTH_MICROSOFT_ENTRA_ID_ID: "id",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "secret",
        AUTH_MICROSOFT_ENTRA_ID_ISSUER: "https://login.microsoftonline.com/t/v2.0",
        ORCHESTRATOR_API_CLIENT_ID: "api",
      }).insecureAuthMode,
    ).toBe(false);
  });

  it("getAdminSession returns nobody rather than a free admin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_AUTH_MODE", "token");
    vi.stubEnv("ADMIN_MOCK", "");
    resetEnvCache();
    const { getAdminSession, requireRoles, UnauthorizedError } = await import("@/lib/session");
    expect(await getAdminSession()).toBeNull();
    await expect(requireRoles("admin")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("still signs in the development operator outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_AUTH_MODE", "token");
    resetEnvCache();
    const { getAdminSession } = await import("@/lib/session");
    expect((await getAdminSession())?.roles).toContain("admin");
  });
});
