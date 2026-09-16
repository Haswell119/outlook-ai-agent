/**
 * Content-Security-Policy for the dashboard.
 *
 * Emitted per request by `src/middleware.ts` with a fresh nonce, which the App
 * Router then applies to its inline bootstrap scripts — that is what lets
 * `script-src` stay at `'self'` with no `'unsafe-inline'`. Styles do need
 * `'unsafe-inline'`: Tailwind's runtime-injected styles and the inline
 * `style` attributes produced by Recharts have no nonce.
 *
 * The remaining security headers are static and live in `next.config.mjs`.
 */

export interface CspOptions {
  /** Base64 nonce for this response. */
  nonce: string;
  /** `next dev` needs `'unsafe-eval'` for React Refresh. */
  dev?: boolean;
}

export function buildContentSecurityPolicy({ nonce, dev = false }: CspOptions): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (dev) scriptSrc.push("'unsafe-eval'");

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["script-src", scriptSrc],
    // Only styles are allowed inline (Tailwind / Recharts), never scripts.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'", "data:"]],
    // Same-origin XHR only: the orchestrator is called server-side.
    ["connect-src", dev ? ["'self'", "ws:"] : ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
  ];
  if (!dev) directives.push(["upgrade-insecure-requests", []]);

  return directives
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

/** Cryptographically random, base64-encoded nonce (edge-safe). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}
