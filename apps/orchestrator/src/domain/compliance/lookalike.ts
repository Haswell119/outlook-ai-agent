import { levenshtein } from "../../util/text.js";

export const FREE_MAIL_DOMAINS = ["gmail.com", "yahoo.com", "yahoo.fr", "hotmail.com", "hotmail.fr", "outlook.com", "protonmail.com", "proton.me", "gmx.ch", "gmx.com", "bluewin.ch", "icloud.com"];

/** Registrable part of a domain without its TLD (northbridge.example → northbridge). */
export function domainLabel(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return parts[parts.length - 2] ?? "";
}

/**
 * True when `domain` looks like one of the internal domains but is not one:
 * Levenshtein ≤ 2 on the full domain or on the label, or label contained with extra
 * characters (northbridge-capital.com, northbridge.example.evil.io …).
 */
export function isLookalikeDomain(domain: string, internalDomains: string[]): boolean {
  const d = domain.toLowerCase();
  if (!d) return false;
  for (const internal of internalDomains) {
    const i = internal.toLowerCase();
    if (d === i || d.endsWith(`.${i}`)) return false;
  }
  for (const internal of internalDomains) {
    const i = internal.toLowerCase();
    const il = domainLabel(i);
    const dl = domainLabel(d);
    if (levenshtein(d, i) <= 2) return true;
    if (il.length >= 4 && levenshtein(dl, il) <= 2 && dl !== il) return true;
    if (il.length >= 4 && dl.split(/[-_]/).some((part) => part.length >= 4 && part !== il && levenshtein(part, il) <= 2)) return true;
    if (il.length >= 4 && dl !== il && dl.includes(il)) return true;
    if (il.length >= 4 && d.includes(`${i}.`)) return true; // northbridge.example.attacker.com
    if (d.includes("xn--") && levenshtein(dl.replace(/^xn--/, ""), il) <= 3) return true;
  }
  return false;
}

export const isFreeMailDomain = (domain: string): boolean => FREE_MAIL_DOMAINS.includes(domain.toLowerCase());
