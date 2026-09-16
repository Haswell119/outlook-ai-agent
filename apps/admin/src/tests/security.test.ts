import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, createNonce } from "@/lib/security";
import nextConfig, { STATIC_SECURITY_HEADERS } from "../../next.config.mjs";

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split("; ").map((d) => {
      const [name, ...values] = d.split(" ");
      return [name as string, values];
    }),
  ) as Record<string, string[]>;

describe("content security policy", () => {
  const csp = buildContentSecurityPolicy({ nonce: "NONCE" });
  const d = directives(csp);

  it("keeps scripts on 'self' + nonce, with no 'unsafe-inline'", () => {
    expect(d["script-src"]).toContain("'self'");
    expect(d["script-src"]).toContain("'nonce-NONCE'");
    expect(d["script-src"]).not.toContain("'unsafe-inline'");
    expect(d["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("allows 'unsafe-inline' for styles only", () => {
    expect(d["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("restricts connections to the same origin and forbids framing", () => {
    expect(d["connect-src"]).toEqual(["'self'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("only relaxes eval and websockets in development", () => {
    const dev = directives(buildContentSecurityPolicy({ nonce: "N", dev: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toContain("ws:");
    expect(buildContentSecurityPolicy({ nonce: "N", dev: true })).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("generates a distinct base64 nonce per response", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});

describe("static security headers from next.config.mjs", () => {
  it("hides the runtime and keeps the standalone output", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.typescript?.ignoreBuildErrors).toBe(false);
  });

  it("applies HSTS, frame, referrer and permissions policies to every route", async () => {
    const headers = await nextConfig.headers?.();
    expect(headers?.[0]?.source).toBe("/:path*");
    const byKey = new Map(STATIC_SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(byKey.get("Strict-Transport-Security")).toContain("max-age=63072000");
    expect(byKey.get("X-Frame-Options")).toBe("DENY");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("Permissions-Policy")).toContain("camera=()");
    expect(byKey.get("Cache-Control")).toContain("no-store");
  });
});
