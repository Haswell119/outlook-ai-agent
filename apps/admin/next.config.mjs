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
 * `ANALYZE=true pnpm --filter @oao/admin build` writes the treemaps to
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
