import { createHash, timingSafeEqual } from "node:crypto";

export const sha256 = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Length-independent string comparison, used for the shared secrets that are
 * compared against an attacker-supplied value (`ADMIN_API_TOKEN`,
 * `METRICS_TOKEN`). `===` short-circuits on the first differing byte, which
 * leaks the common prefix length through response timing.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  // Comparing SHA-256 digests makes the work independent of both the content
  // and the length of `a`, which a plain byte loop over two different-length
  // strings cannot be. Equal digests imply equal inputs.
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
