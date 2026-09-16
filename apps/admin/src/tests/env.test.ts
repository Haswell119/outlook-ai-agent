import { describe, expect, it } from "vitest";
import { TOKEN_MODE_SECRET_PLACEHOLDER, parseEnv } from "@/env";

const aad = {
  ADMIN_AUTH_MODE: "aad",
  AUTH_SECRET: "a-very-long-random-secret",
  AUTH_MICROSOFT_ENTRA_ID_ID: "11111111-1111-1111-1111-111111111111",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret",
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: "https://login.microsoftonline.com/tenant-id/v2.0",
  ORCHESTRATOR_API_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
};

describe("environment schema", () => {
  it("applies the documented defaults", () => {
    const env = parseEnv({});
    expect(env.ORCHESTRATOR_URL).toBe("http://localhost:8080");
    expect(env.ADMIN_AUTH_MODE).toBe("token");
    expect(env.ADMIN_TENANT_NAME).toBe("Northbridge Capital");
    expect(env.ADMIN_TZ).toBe("Europe/Zurich");
    expect(env.ADMIN_DEFAULT_LANGUAGE).toBe("en");
    expect(env.ADMIN_MOCK).toBe(false);
    expect(env.ADMIN_SESSION_MAX_AGE).toBe(3600);
    expect(env.apiScope).toBeUndefined();
  });

  it("normalises booleans, email lists and the orchestrator URL", () => {
    const env = parseEnv({
      ADMIN_MOCK: "true",
      ORCHESTRATOR_URL: "https://orchestrator.internal.example///",
      ADMIN_EMAILS: "Admin@northbridge.example, boss@northbridge.example;not-an-email",
      COMPLIANCE_EMAILS: "officer@northbridge.example",
    });
    expect(env.ADMIN_MOCK).toBe(true);
    expect(env.ORCHESTRATOR_URL).toBe("https://orchestrator.internal.example");
    expect(env.ADMIN_EMAILS).toEqual(["admin@northbridge.example", "boss@northbridge.example"]);
    expect(env.COMPLIANCE_EMAILS).toEqual(["officer@northbridge.example"]);
  });

  it("builds the orchestrator API scope from the API client id", () => {
    const env = parseEnv(aad);
    expect(env.apiScope).toBe(
      "api://22222222-2222-2222-2222-222222222222/access_as_user",
    );
    expect(parseEnv({ ...aad, ORCHESTRATOR_API_SCOPE: "api://custom/scope" }).apiScope).toBe(
      "api://custom/scope",
    );
  });

  it("fails fast when AAD mode is incomplete", () => {
    expect(() => parseEnv({ ADMIN_AUTH_MODE: "aad" })).toThrow(/AUTH_SECRET is required/);
    expect(() => parseEnv({ ...aad, AUTH_MICROSOFT_ENTRA_ID_ISSUER: undefined })).toThrow(
      /AUTH_MICROSOFT_ENTRA_ID_ISSUER/,
    );
    expect(() => parseEnv({ ...aad, ORCHESTRATOR_API_CLIENT_ID: undefined })).toThrow(
      /ORCHESTRATOR_API_CLIENT_ID/,
    );
    expect(() =>
      parseEnv({ ...aad, AUTH_SECRET: TOKEN_MODE_SECRET_PLACEHOLDER }),
    ).toThrow(/must be a real secret/);
  });

  it("rejects a malformed orchestrator URL and an unknown auth mode", () => {
    expect(() => parseEnv({ ORCHESTRATOR_URL: "ftp://nope" })).toThrow(/http\(s\) URL/);
    expect(() => parseEnv({ ADMIN_AUTH_MODE: "saml" })).toThrow(/ADMIN_AUTH_MODE/);
    expect(() => parseEnv({ ADMIN_SESSION_MAX_AGE: "10" })).toThrow(/ADMIN_SESSION_MAX_AGE/);
  });
});
