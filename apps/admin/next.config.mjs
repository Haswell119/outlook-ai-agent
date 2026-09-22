/**
 * @oao/admin — Next.js configuration.
 *
 * Security headers are declared here (`headers()`), with one deliberate
 * exception: the `Content-Security-Policy` is emitted by `src/middleware.ts`,
 * because a strict `script-src 'self'` needs a **per-request nonce** for the
 * inline bootstrap scripts of the App Router. Next.js picks that nonce up from
 * the CSP header of the incoming request, which only middleware can set.
 * Declaring the CSP twice would send two conflicting policies, so this file
 * owns everything that is static and the middleware owns the CSP.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * npm workspaces: this app owns its own `next` (and therefore React 19) under
 * `apps/admin/node_modules`, while the platform-specific `@next/swc-*` binaries
 * are hoisted to the repository-root `node_modules` — see the `overrides` block
 * in the root package.json. Next's "repair the lockfile" helper looks for those
 * binaries next to its own entry in `package-lock.json`, does not find them and
 * tries to shell out to a package manager it guesses from this directory (which
 * holds no lockfile). The lockfile is correct, so skip the repair.
 */
process.env.NEXT_IGNORE_INCORRECT_LOCKFILE ??= "1";

/**
 * Single root `.env`: Next.js only loads `apps/admin/.env*` (already done by
 * the time this file runs), so keys from the repository-root `.env` are merged
 * here for anything still unset. Shell/container variables always win.
 */
(() => {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
  if (!existsSync(file) || process.env.NODE_ENV === "test") return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (!m || raw.trim().startsWith("#")) continue;
    let v = m[2] ?? "";
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s#.*$/, "").trim();
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = v;
  }
})();

/** Headers applied to every response. */
export const STATIC_SECURITY_HEADERS = [
  // HSTS: 2 years, subdomains included, preload-ready.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Belt and braces next to the CSP's `frame-ancestors 'none'`.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "encrypted-media=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "usb=()",
      "xr-spatial-tracking=()",
    ].join(", "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // The dashboard shows audit data: never let an intermediary cache a page.
  { key: "Cache-Control", value: "no-store, max-age=0" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  reactStrictMode: true,
  transpilePackages: ["@oao/shared"],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }];
  },
};

/**
 * `ANALYZE=true npm run build -w @oao/admin` writes the treemaps to
 * `.next/analyze/`. The dependency is optional at runtime, so a missing
 * package never breaks a normal build.
 */
let config = nextConfig;
if (process.env.ANALYZE === "true") {
  try {
    const { default: withBundleAnalyzer } = await import("@next/bundle-analyzer");
    config = withBundleAnalyzer({ enabled: true, openAnalyzer: false })(nextConfig);
  } catch (error) {
    console.warn("[@oao/admin] @next/bundle-analyzer is not installed — skipping", error);
  }
}

export default config;
