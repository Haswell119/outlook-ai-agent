/**
 * Regression tests for the findings of the 2026-09 security review.
 * Each `it` pins one fix; the comment says what the bug was.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Routes } from "@oao/shared";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { AuthFailureThrottle } from "../../src/auth/plugin.js";
import { createTestContainer, TEST_ENV, type TestContainer } from "../helpers.js";

const H = { "content-type": "application/json", "accept-language": "en" };

describe("rate limiting cannot be opted out of with a request header", () => {
  let c: TestContainer;
  let app: FastifyInstance;
  beforeAll(async () => {
    c = await createTestContainer({ RATE_LIMIT_PER_MINUTE: "3" });
    app = await buildApp(c, { logger: false });
    await app.ready();
  });
  afterAll(async () => app.close());

  /**
   * The limiter keyed on `x-user-email` whenever `request.user` was unset —
   * which, because the auth plugin was registered *after* the limiter, was
   * always. On a route where that header is not the credential (any route in
   * `AUTH_MODE=aad`, and every unauthenticated public route in both modes),
   * rotating it gave the caller a fresh bucket per request, i.e. no limit at
   * all. The key is now the authenticated identity or the source address, and
   * never a header.
   */
  it("rotating x-user-email no longer creates a fresh bucket on a route that does not authenticate", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "GET", url: Routes.features, headers: { ...H, "x-user-email": `attacker${i}@northbridge.example` } });
      codes.push(r.statusCode);
    }
    expect(codes.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  /** The documented intent: one bucket per *authenticated* identity, so 50 users behind one NAT are not throttled as one. */
  it("keys authenticated traffic on the identity, not the source address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({ method: "GET", url: Routes.me, headers: { ...H, "x-user-email": "steady@northbridge.example" } });
      codes.push(r.statusCode);
    }
    expect(codes).toContain(429);
    // A different signed-in user is not affected by the first one's backlog.
    const other = await app.inject({ method: "GET", url: Routes.me, headers: { ...H, "x-user-email": "colleague@northbridge.example" } });
    expect(other.statusCode).toBe(200);
  });
});

describe("AuthFailureThrottle", () => {
  /** Failed authentications never reached the identity-keyed limiter: ADMIN_API_TOKEN could be brute-forced at line rate. */
  it("blocks a source address after too many failures and resets with the window", () => {
    let now = 1_000;
    const t = new AuthFailureThrottle(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(() => t.check("10.0.0.1")).not.toThrow();
      t.record("10.0.0.1");
    }
    expect(() => t.check("10.0.0.1")).toThrowError(/Too many failed authentication/);
    // A different source is unaffected.
    expect(() => t.check("10.0.0.2")).not.toThrow();
    now += 60_001;
    expect(() => t.check("10.0.0.1")).not.toThrow();
  });
});

describe("configuration guards", () => {
  /** `credentials: true` + a reflected `*` origin = any website can call the API with the user's credentials. */
  it("refuses CORS_ORIGINS=* in production", () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, NODE_ENV: "production", AUTH_MODE: "aad", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", ADMIN_API_TOKEN: "x".repeat(40), CORS_ORIGINS: "*" }),
    ).toThrowError(/CORS_ORIGINS=\* is refused/);
    expect(() =>
      loadConfig({ ...TEST_ENV, NODE_ENV: "production", AUTH_MODE: "aad", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", ADMIN_API_TOKEN: "x".repeat(40), CORS_ORIGINS: "https://addin.northbridge.example" }),
    ).not.toThrow();
  });
});

describe("request validation", () => {
  let c: TestContainer;
  let app: FastifyInstance;
  beforeAll(async () => {
    c = await createTestContainer();
    app = await buildApp(c, { logger: false });
    await app.ready();
  });
  afterAll(async () => app.close());

  /** `date` was an unvalidated string: `new Date(NaN).toISOString()` threw and the caller got a 500. */
  it("rejects a malformed daily-brief date with 400, not 500", async () => {
    const r = await app.inject({ method: "POST", url: Routes.dailyBrief, headers: { ...H, "x-user-email": "u@northbridge.example" }, payload: { date: "not-a-date" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_error");
  });

  /** A `/api/v1/docs` *prefix* match would exempt any future route whose path merely starts with it. */
  it("does not treat a path that merely starts with a public prefix as public", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/docsomething" });
    // 404, not a silently unauthenticated 200/401-free route.
    expect(r.statusCode).toBe(404);
  });
});
