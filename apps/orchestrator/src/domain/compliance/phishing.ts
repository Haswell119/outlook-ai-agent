import { emailDomain } from "@oao/shared";
import type { EmailContext } from "@oao/shared";
import { extractUrls } from "../../util/text.js";
import { isLookalikeDomain } from "./lookalike.js";

/**
 * Inbound anti-phishing heuristics (Compliance Guardian). Pure, weighted indicators.
 */
export interface PhishingIndicator {
  code: string;
  description: string;
  weight: number;
}

export interface PhishingAssessment {
  score: number;
  verdict: "clean" | "suspicious" | "likely_phishing";
  indicators: PhishingIndicator[];
}

const URGENT_WORDS = [
  "urgent", "immediately", "immédiatement", "asap", "right away", "within 24 hours", "sous 24h", "dans les 24 heures", "action required",
  "action requise", "your account will be", "votre compte sera", "suspended", "suspendu", "final notice", "dernier rappel", "verify your",
  "vérifiez votre", "confirm your identity", "confirmez votre identité", "expire", "expir", "last chance", "dernière chance",
];
const CREDENTIAL_WORDS = ["password", "mot de passe", "credentials", "identifiants", "login", "log in", "sign in", "connectez-vous", "verify your account", "mettre à jour vos informations", "update your details", "code de sécurité", "security code", "one-time code"];
const PAYMENT_WORDS = ["wire transfer", "virement", "bank details", "coordonnées bancaires", "iban", "payment", "paiement", "invoice", "facture", "gift card", "carte cadeau", "bitcoin", "crypto", "change of bank", "changement de compte", "new account number", "nouveau numéro de compte"];
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rb.gy", "tiny.cc"];
const DANGEROUS_EXT = [".exe", ".scr", ".bat", ".cmd", ".js", ".vbs", ".jar", ".ps1", ".docm", ".xlsm", ".pptm", ".hta", ".iso", ".lnk", ".msi"];

export interface PhishingOptions {
  internalDomains: string[];
  /** Senders already seen (address list) — unknown senders with dangerous attachments weigh more. */
  knownSenders?: string[];
}

export function assessPhishing(email: EmailContext, opts: PhishingOptions): PhishingAssessment {
  const indicators: PhishingIndicator[] = [];
  const fromAddress = (email.from?.address ?? "").toLowerCase();
  const fromName = email.from?.name ?? "";
  const fromDomain = emailDomain(fromAddress);
  const text = `${email.subject}\n${email.body}`;
  const lower = text.toLowerCase();

  // 1. Display name vs address mismatch: name contains an email/domain that differs.
  const nameEmail = /[\w.+-]+@([\w-]+\.[\w.-]+)/.exec(fromName);
  if (nameEmail && emailDomain(nameEmail[0]) !== fromDomain) {
    indicators.push({ code: "display_name_mismatch", description: `Display name shows "${nameEmail[0]}" but the sender address is ${fromAddress}.`, weight: 0.35 });
  } else if (fromName && fromDomain) {
    // Display name claims an internal identity but the address is external.
    const claimsInternal = opts.internalDomains.some((d) => fromName.toLowerCase().includes(d.split(".")[0] ?? ""));
    const isInternal = opts.internalDomains.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`));
    if (claimsInternal && !isInternal) {
      indicators.push({ code: "display_name_mismatch", description: `Display name "${fromName}" suggests an internal sender but the address is ${fromAddress}.`, weight: 0.3 });
    }
  }

  // 2. Lookalike sender domain.
  if (fromDomain && isLookalikeDomain(fromDomain, opts.internalDomains)) {
    indicators.push({ code: "lookalike_sender_domain", description: `Sender domain ${fromDomain} imitates an internal domain.`, weight: 0.4 });
  }

  // 3. Reply-to differs (heuristic: "reply-to:" line in body headers or a different address requested).
  const replyTo = /reply-to\s*:\s*([\w.+-]+@[\w.-]+)/i.exec(text);
  if (replyTo && replyTo[1] && emailDomain(replyTo[1]) !== fromDomain) {
    indicators.push({ code: "reply_to_mismatch", description: `Reply-To ${replyTo[1]} differs from the sender domain.`, weight: 0.25 });
  }

  // 4. Urgent language.
  const urgentHits = URGENT_WORDS.filter((w) => lower.includes(w));
  if (urgentHits.length) {
    indicators.push({ code: "urgent_language", description: `Urgency cues: ${urgentHits.slice(0, 3).join(", ")}.`, weight: Math.min(0.1 + urgentHits.length * 0.07, 0.3) });
  }

  // 5. Suspicious links.
  const urls = extractUrls(email.body);
  for (const url of urls) {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) indicators.push({ code: "raw_ip_link", description: `Link to a raw IP address: ${host}.`, weight: 0.3 });
    else if (host.includes("xn--")) indicators.push({ code: "punycode_link", description: `Punycode domain in link: ${host}.`, weight: 0.3 });
    else if (SHORTENERS.some((s) => host === s || host.endsWith(`.${s}`))) indicators.push({ code: "url_shortener", description: `URL shortener used: ${host}.`, weight: 0.2 });
    else if (isLookalikeDomain(host, opts.internalDomains)) indicators.push({ code: "lookalike_link", description: `Link domain ${host} imitates an internal domain.`, weight: 0.3 });
  }
  // Anchor text domain ≠ href domain: "[text](href)" markdown-ish or "http://a.com <http://b.com>" or html anchors.
  const anchorRe = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/a>|\[(https?:\/\/[^\]]+)\]\((https?:\/\/[^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(email.body))) {
    const href = m[1] ?? m[4] ?? "";
    const shown = m[2] ?? m[3] ?? "";
    try {
      if (new URL(href).hostname !== new URL(shown).hostname) {
        indicators.push({ code: "anchor_href_mismatch", description: `Link text shows ${new URL(shown).hostname} but points to ${new URL(href).hostname}.`, weight: 0.35 });
      }
    } catch {
      /* ignore */
    }
  }

  // 6. Credential / payment requests.
  const credHits = CREDENTIAL_WORDS.filter((w) => lower.includes(w));
  if (credHits.length) indicators.push({ code: "credential_request", description: `Asks for credentials (${credHits.slice(0, 2).join(", ")}).`, weight: 0.3 });
  const payHits = PAYMENT_WORDS.filter((w) => lower.includes(w));
  const paymentChange = /(change|changement|new|nouveau|nouvelles?|updated?|mise à jour).{0,40}(bank|banc|iban|account|compte)/i.test(text);
  if (paymentChange) indicators.push({ code: "payment_change_request", description: "Requests a change of bank details / account number.", weight: 0.4 });
  else if (payHits.length >= 2 && urgentHits.length) indicators.push({ code: "payment_request", description: `Payment-related request with urgency (${payHits.slice(0, 2).join(", ")}).`, weight: 0.2 });

  // 7. Unknown sender + dangerous attachment.
  const dangerous = email.attachments.filter((a) => DANGEROUS_EXT.some((ext) => a.name.toLowerCase().endsWith(ext)));
  if (dangerous.length) {
    const known = (opts.knownSenders ?? []).map((s) => s.toLowerCase()).includes(fromAddress);
    const internal = opts.internalDomains.some((d) => fromDomain === d || fromDomain.endsWith(`.${d}`));
    indicators.push({
      code: "dangerous_attachment",
      description: `Executable/macro attachment ${dangerous.map((a) => a.name).join(", ")}${known || internal ? "" : " from an unknown sender"}.`,
      weight: known || internal ? 0.25 : 0.45,
    });
  }

  const dedup = new Map<string, PhishingIndicator>();
  for (const ind of indicators) {
    const prev = dedup.get(ind.code);
    if (!prev || prev.weight < ind.weight) dedup.set(ind.code, ind);
  }
  const list = Array.from(dedup.values());
  const score = Math.min(1, Number(list.reduce((acc, i) => acc + i.weight, 0).toFixed(2)));
  const verdict: PhishingAssessment["verdict"] = score >= 0.6 ? "likely_phishing" : score >= 0.3 ? "suspicious" : "clean";
  return { score, verdict, indicators: list };
}
