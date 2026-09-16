/**
 * Browser-side Policy Center helpers: regex validation and the **preview**
 * evaluator behind the "Rule test panel".
 *
 * This is deliberately a preview, not the Compliance Guardian: it reuses the
 * same pattern list the operator is editing, but the authoritative verdict is
 * always produced server-side by the orchestrator. Pure functions, no I/O, so
 * the same code is unit-tested and runs in the browser.
 */
import { emailDomain, isInternalAddress, type Policy, type RiskLevel } from "@oao/shared";

export interface CompiledPattern {
  regex: RegExp;
  /** True when a leading inline flag group such as `(?i)` had to be translated. */
  translatedInlineFlags: boolean;
}

export interface RegexValidation {
  valid: boolean;
  error?: string;
  /** Set when the pattern only compiles after translating inline flags. */
  note?: "inline-flags";
}

const INLINE_FLAGS = /^\(\?([a-z]+)\)/;
const SUPPORTED_INLINE_FLAGS = new Set(["i", "m", "s"]);

/**
 * Compiles a policy pattern the way the preview evaluates it.
 *
 * Server-side engines commonly accept a leading inline flag group (`(?i)`),
 * which `RegExp` rejects; we translate it into real flags instead of declaring
 * the pattern broken.
 */
export function compilePattern(pattern: string, extraFlags = "g"): CompiledPattern {
  const match = INLINE_FLAGS.exec(pattern);
  if (match) {
    const flags = [...new Set([...(match[1] ?? ""), ...extraFlags])].filter((f) =>
      SUPPORTED_INLINE_FLAGS.has(f) || f === "g",
    );
    return {
      regex: new RegExp(pattern.slice(match[0].length), flags.join("")),
      translatedInlineFlags: true,
    };
  }
  return { regex: new RegExp(pattern, extraFlags), translatedInlineFlags: false };
}

/** Inline validation shown under each pattern row of the Policy Center. */
export function validateRegex(pattern: string): RegexValidation {
  if (pattern.trim().length === 0) return { valid: false, error: "empty pattern" };
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (error) {
    try {
      const compiled = compilePattern(pattern);
      if (compiled.translatedInlineFlags) return { valid: true, note: "inline-flags" };
    } catch {
      /* fall through to the original error */
    }
    return { valid: false, error: error instanceof Error ? error.message : "invalid pattern" };
  }
}

export type FindingKind = "sensitive" | "confidential" | "external" | "large_distribution";

export interface PolicyFinding {
  kind: FindingKind;
  /** Name of the rule that fired (pattern name, or the recipient/threshold rule). */
  rule: string;
  severity: RiskLevel;
  /** Up to 5 excerpts / addresses, for display. */
  samples: string[];
  count: number;
}

export interface PolicyPreviewInput {
  text: string;
  recipients: string[];
}

/** Splits a free-text recipient list (newlines, commas or semicolons). */
export function parseRecipients(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MAX_SAMPLES = 5;

function findMatches(text: string, pattern: string): string[] {
  const { regex } = compilePattern(pattern, "gi");
  const out: string[] = [];
  for (const m of text.matchAll(regex)) {
    if (typeof m[0] === "string" && m[0].length > 0) out.push(m[0]);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Evaluates the current draft policy against a sample: which sensitive-data
 * patterns match, which confidential markers appear, which recipients are
 * external and whether the large-distribution threshold is crossed.
 */
export function evaluatePolicyPreview(
  policy: Policy,
  input: PolicyPreviewInput,
): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const text = input.text ?? "";

  for (const pattern of policy.sensitiveDataPatterns) {
    if (!validateRegex(pattern.pattern).valid) continue;
    const matches = findMatches(text, pattern.pattern);
    if (matches.length === 0) continue;
    findings.push({
      kind: "sensitive",
      rule: pattern.name || pattern.pattern,
      severity: pattern.severity,
      samples: matches.slice(0, MAX_SAMPLES),
      count: matches.length,
    });
  }

  for (const marker of policy.confidentialPatterns) {
    if (marker.trim().length === 0) continue;
    const matches = validateRegex(marker).valid
      ? findMatches(text, marker)
      : text.toLowerCase().includes(marker.toLowerCase())
        ? [marker]
        : [];
    if (matches.length === 0) continue;
    findings.push({
      kind: "confidential",
      rule: marker,
      severity: "medium",
      samples: matches.slice(0, MAX_SAMPLES),
      count: matches.length,
    });
  }

  const recipients = input.recipients.filter((r) => r.includes("@"));
  const external = recipients.filter((r) => !isInternalAddress(r, policy.internalDomains));
  if (external.length > 0) {
    findings.push({
      kind: "external",
      rule: [...new Set(external.map((r) => emailDomain(r)))].join(", "),
      severity: "high",
      samples: external.slice(0, MAX_SAMPLES),
      count: external.length,
    });
  }
  if (external.length > policy.largeDistributionThreshold) {
    findings.push({
      kind: "large_distribution",
      rule: `> ${policy.largeDistributionThreshold}`,
      severity: "medium",
      samples: [],
      count: external.length,
    });
  }

  const order: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
