import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwtPayload, tokenEndpointFromIssuer, REFRESH_SKEW_MS } from "@/lib/entra";
import { resetEnvCache } from "@/env";

function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${body}.signature`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("access-token helpers", () => {
  it("decodes the roles claim of a base64url access token", () => {
    const payload = decodeJwtPayload(jwt({ roles: ["Admin"], aud: "api://client-id" }));
    expect(payload.roles).toEqual(["Admin"]);
    expect(payload.aud).toBe("api://client-id");
  });

  it("never throws on a malformed or missing token", () => {
    expect(decodeJwtPayload(undefined)).toEqual({});
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
    expect(decodeJwtPayload("a.!!!.c")).toEqual({});
  });

  it("requests the orchestrator API scope alongside offline_access", async () => {
    vi.stubEnv("ADMIN_AUTH_MODE", "aad");
    vi.stubEnv("AUTH_SECRET", "a-very-long-random-secret");
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "client-id");
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_SECRET", "client-secret");
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ISSUER", "https://login.microsoftonline.com/tid/v2.0");
    vi.stubEnv("ORCHESTRATOR_API_CLIENT_ID", "api-client-id");
    resetEnvCache();
    vi.resetModules();

    const { requestedScopes } = await import("@/lib/entra");
    const scopes = requestedScopes().split(" ");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("api://api-client-id/access_as_user");
    // The dashboard never asks for a Microsoft Graph scope.
    expect(requestedScopes()).not.toContain("graph.microsoft.com");
  });

  it("derives the v2 token endpoint from the issuer", () => {
    expect(tokenEndpointFromIssuer("https://login.microsoftonline.com/tid/v2.0")).toBe(
      "https://login.microsoftonline.com/tid/oauth2/v2.0/token",
    );
    expect(tokenEndpointFromIssuer("https://login.microsoftonline.com/tid/v2.0/")).toBe(
      "https://login.microsoftonline.com/tid/oauth2/v2.0/token",
    );
    expect(REFRESH_SKEW_MS).toBeGreaterThan(0);
  });
});

describe("refresh-token rotation", () => {
  const aadEnv = {
    ADMIN_AUTH_MODE: "aad",
    AUTH_SECRET: "a-very-long-random-secret",
    AUTH_MICROSOFT_ENTRA_ID_ID: "client-id",
    AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret",
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: "https://login.microsoftonline.com/tid/v2.0",
    ORCHESTRATOR_API_CLIENT_ID: "api-client-id",
  };

  it("rotates the refresh token and re-reads the roles from the new access token", async () => {
    for (const [k, v] of Object.entries(aadEnv)) vi.stubEnv(k, v);
    resetEnvCache();
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => {
      void init;
      return Promise.resolve(
        Response.json({
          access_token: jwt({ roles: ["Compliance"] }),
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshAccessToken } = await import("@/lib/entra");
    const next: Record<string, unknown> = await refreshAccessToken({
      refreshToken: "old-refresh-token",
      email: "officer@northbridge.example",
    } as Record<string, unknown>);

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh-token");
    expect(decodeURIComponent(body)).toContain("api://api-client-id/access_as_user");
    expect(next.refreshToken).toBe("rotated-refresh-token");
    expect(next.roles).toEqual(["compliance", "user"]);
    expect(next.error).toBeUndefined();
    expect(Number(next.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("marks the session RefreshAccessTokenError when the grant fails", async () => {
    for (const [k, v] of Object.entries(aadEnv)) vi.stubEnv(k, v);
    resetEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    const { refreshAccessToken } = await import("@/lib/entra");
    const next: Record<string, unknown> = await refreshAccessToken({
      refreshToken: "expired",
    } as Record<string, unknown>);
    expect(next.error).toBe("RefreshAccessTokenError");
  });

  it("does not even try without a refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { refreshAccessToken } = await import("@/lib/entra");
    const next: Record<string, unknown> = await refreshAccessToken(
      {} as Record<string, unknown>,
    );
    expect(next.error).toBe("RefreshAccessTokenError");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
