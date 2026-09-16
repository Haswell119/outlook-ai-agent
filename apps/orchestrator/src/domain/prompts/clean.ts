import type { EmailContext } from "@oao/shared";
import { normalizeWhitespace } from "../../util/text.js";

/**
 * Prompt slimming — the second line of AI-load minimisation.
 *
 * Everything here is pure. The goal is to send the model the *smallest text
 * that still answers the question*: a 40-message reply chain with a 900-word
 * legal disclaimer on every message routinely shrinks by 85–95 %, which is a
 * direct, linear saving on prompt-token time on the GPU.
 *
 * Pipeline (`cleanBody`):
 *   1. normalise newlines / collapse runs of spaces and blank lines,
 *   2. cut at the first quoted-history marker (`On … wrote:`, `Le … a écrit :`,
 *      `-----Original Message-----`, a `De :` / `From:` header block, `>` runs),
 *   3. cut at the first signature marker (`--`, `Sent from my…`, sign-off + name),
 *   4. drop legal disclaimers / confidentiality footers,
 *   5. shorten tracking URLs to their origin + path,
 *   6. cap the result keeping the head **and** the tail (the ask is often last).
 */

/** chars/4 — the usual rule of thumb for European text on BPE tokenisers. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Start of a quoted previous message. Anchored at line start, FR + EN + Outlook. */
const QUOTE_MARKERS: RegExp[] = [
  /^-{2,}\s*(original message|message d'origine|message original|forwarded message|message transféré|message transfere)\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^On\s.{3,120}\swrote\s*:\s*$/im,
  /^On\s.{3,120},\s*.{3,80}\s*<[^>]+>\s*wrote\s*:\s*$/im,
  /^Le\s.{3,120}\sa\s*(?:é|e)crit\s*:\s*$/im,
  /^Le\s.{3,120},\s*.{3,80}\s*<[^>]+>\s*a\s*(?:é|e)crit\s*:\s*$/im,
  /^(?:From|De)\s*:\s*.{0,200}$\n^(?:Sent|Envoy(?:é|e)|Date)\s*:\s*.{0,200}$/im,
  /^(?:From|De)\s*:\s*.{2,200}<[^>]+>\s*$/im,
  /^\s*>{1,}\s?.*(?:\n\s*>{1,}\s?.*){2,}/m,
  /^(?:Begin forwarded message|D(?:é|e)but du message transf(?:é|e)r(?:é|e))\s*:\s*$/im,
];

/**
 * Start of a signature block. A closing formula on its own line counts: what
 * follows it ("Ana Ruiz | Client Advisor | +41 …") is contact data the model
 * never needs, and the closing itself carries no information either.
 */
const SIGNATURE_MARKERS: RegExp[] = [
  /^(best regards|kind regards|warm regards|regards|sincerely|yours sincerely|yours faithfully|many thanks|thanks in advance|cordialement|bien cordialement|meilleures salutations|salutations distingu(?:é|e)es|sinc(?:è|e)res salutations|bien (?:à|a) vous|merci d'avance|cheers)\s*[,.!]?\s*$/im,
  /^--\s*$/m,
  /^-{2,}\s*$/m,
  /^__+\s*$/m,
  /^(?:Sent from my (?:iPhone|iPad|Android|Samsung|mobile|Galaxy).*|Envoy(?:é|e) de mon (?:iPhone|iPad|Android|mobile).*|Obtenez Outlook pour .*|Get Outlook for .*)$/im,
  /^\s*(?:Tel|Tél|T|Phone|Mobile|M|Direct|Fax)\s*[.:]?\s*\+?[\d ()./-]{7,}\s*$/im,
];

/** Legal / confidentiality footers — removed wherever they appear. */
const DISCLAIMER_MARKERS: RegExp[] = [
  /this (?:e-?mail|message) (?:and any attachments? )?(?:is|are|may be) (?:confidential|intended|privileged)/i,
  /the information (?:contained )?in this (?:e-?mail|message) is confidential/i,
  /if you (?:are not the intended recipient|have received this (?:e-?mail|message) in error)/i,
  /ce (?:message|courriel|e-?mail) (?:et (?:ses|les) pi(?:è|e)ces jointes )?(?:est|sont) (?:confidentiel|(?:é|e)tabli)/i,
  /ce message (?:et ses pi(?:è|e)ces jointes )?(?:peut|peuvent) contenir des informations confidentielles/i,
  /si vous n'(?:ê|e)tes pas le destinataire/i,
  /toute (?:diffusion|publication|utilisation) (?:ou reproduction )?(?:non autoris(?:é|e)e|est interdite)/i,
  /any unauthoris?ed (?:use|disclosure|copying|distribution)/i,
  /please consider the environment before printing/i,
  /pensez (?:à|a) l'environnement avant d'imprimer/i,
  /p\.?\s?s\.?\s?:?\s?save (?:paper|trees)/i,
];

/** Tracking / campaign query parameters worth dropping from a URL. */
const TRACKING_PARAMS = /^(utm_|mc_|mkt_|_hs|hsa_|pk_|piwik_|matomo_|gclid|fbclid|msclkid|igshid|vero_|trk|trkCampaign|elqTrack|ck_subscriber_id|ml_subscriber)/i;

/** Offset of the earliest match among `patterns`, or -1. */
function earliest(text: string, patterns: RegExp[]): number {
  let at = -1;
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m.index >= 0 && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

/** Markers that introduce a *forwarded* message (its content is the point of the email). */
const FORWARD_MARKERS: RegExp[] = [
  /^-{2,}\s*(original message|message d'origine|message original|forwarded message|message transféré|message transfere)\s*-{2,}\s*$/im,
  /^(?:From|De)\s*:\s*.{0,200}$\n^(?:Sent|Envoy(?:é|e)|Date)\s*:\s*.{0,200}$/im,
  /^(?:Begin forwarded message|D(?:é|e)but du message transf(?:é|e)r(?:é|e))\s*:\s*$/im,
];

/**
 * Cut the text at the first quoted-history marker. `kind` tells whether the
 * quote looks like a forwarded message (header block) or a reply chain.
 */
export function stripQuotedHistory(body: string): { text: string; quoted: string; kind: "reply" | "forward" | "none" } {
  const at = earliest(body, QUOTE_MARKERS);
  if (at < 0) return { text: body, quoted: "", kind: "none" };
  const quoted = body.slice(at);
  const kind = FORWARD_MARKERS.some((re) => re.test(quoted.slice(0, 400))) ? "forward" : "reply";
  return { text: body.slice(0, at).trimEnd(), quoted, kind };
}

/**
 * Cut the text at the first signature marker, but only in the last third of the
 * message — a `--` in the second line is a separator, not a signature.
 */
export function stripSignature(body: string): string {
  const at = earliest(body, SIGNATURE_MARKERS);
  if (at < 0) return body;
  if (at < Math.min(120, body.length * 0.25)) return body;
  return body.slice(0, at).trimEnd();
}

/** Remove legal disclaimer paragraphs wherever they appear. */
export function stripDisclaimers(body: string): string {
  const paragraphs = body.split(/\n{2,}/);
  const kept = paragraphs.filter((p) => !DISCLAIMER_MARKERS.some((re) => re.test(p)));
  // Never return an empty body just because the whole message looked like a disclaimer.
  return (kept.length ? kept : paragraphs).join("\n\n");
}

/** Shorten URLs: drop tracking parameters, then cap the remainder. */
export function stripTrackingUrls(body: string, maxUrlChars = 120): string {
  return body.replace(/\bhttps?:\/\/[^\s<>"')\]]+/gi, (url) => {
    let cleaned = url;
    const q = url.indexOf("?");
    if (q >= 0) {
      const base = url.slice(0, q);
      const kept = url
        .slice(q + 1)
        .split("&")
        .filter((kv) => {
          const key = kv.split("=")[0] ?? "";
          return key !== "" && !TRACKING_PARAMS.test(key);
        });
      cleaned = kept.length ? `${base}?${kept.join("&")}` : base;
    }
    if (cleaned.length <= maxUrlChars) return cleaned;
    try {
      const u = new URL(cleaned);
      return `${u.origin}${u.pathname.slice(0, 40)}…`;
    } catch {
      return `${cleaned.slice(0, maxUrlChars)}…`;
    }
  });
}

/** Collapse runs of whitespace, blank lines and repeated separator lines. */
export function collapseWhitespace(body: string): string {
  return normalizeWhitespace(body)
    .replace(/^[ \t]*[-=_*·•]{3,}[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Keep the head and the tail of an over-long text (the actual ask is often last). */
export function capHeadTail(text: string, maxChars: number, marker = "\n[…]\n"): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length + 2) return text.slice(0, Math.max(0, maxChars));
  const budget = maxChars - marker.length;
  const head = Math.ceil(budget * 0.7);
  const tail = budget - head;
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(text.length - tail).trimStart()}`;
}

export interface CleanOptions {
  /** Hard cap on the produced text (LLM_INPUT_MAX_CHARS). */
  maxChars?: number;
  /** Keep the quoted history (used when a single message *is* the whole context). */
  keepQuoted?: boolean;
}

export interface CleanResult {
  text: string;
  originalChars: number;
  chars: number;
  /** Rough prompt-token estimate of the cleaned text. */
  tokens: number;
  /** Fraction of characters removed, 0..1. */
  savedRatio: number;
  removed: { quoted: boolean; signature: boolean; disclaimer: boolean; truncated: boolean };
}

/** Full slimming pipeline for one email body. */
export function cleanBody(body: string, opts: CleanOptions = {}): CleanResult {
  const maxChars = opts.maxChars ?? 12000;
  const originalChars = body.length;
  const normalised = collapseWhitespace(body);

  const { text: withoutQuote, quoted, kind } = opts.keepQuoted ? { text: normalised, quoted: "", kind: "none" as const } : stripQuotedHistory(normalised);
  const afterSig = stripSignature(withoutQuote);
  const afterDisclaimer = stripDisclaimers(afterSig);
  const afterUrls = stripTrackingUrls(afterDisclaimer);
  let text = collapseWhitespace(afterUrls);

  // The quoted part is kept when it *is* the content: a message made only of
  // history, or a forward ("FYI, see below" + the forwarded email). A genuine
  // reply keeps only the author's text — its history is already known.
  const FORWARD_MIN_OWN_CHARS = 200;
  if (quoted && (!text || (kind === "forward" && text.length < FORWARD_MIN_OWN_CHARS))) {
    const quoteText = collapseWhitespace(stripTrackingUrls(stripDisclaimers(quoted)));
    text = text ? `${text}\n\n${quoteText}` : quoteText;
  }

  const truncated = text.length > maxChars;
  if (truncated) text = capHeadTail(text, maxChars);

  return {
    text,
    originalChars,
    chars: text.length,
    tokens: estimateTokens(text),
    savedRatio: originalChars ? Number(Math.max(0, 1 - text.length / originalChars).toFixed(3)) : 0,
    removed: { quoted: quoted.length > 0, signature: afterSig.length < withoutQuote.length, disclaimer: afterDisclaimer.length < afterSig.length, truncated },
  };
}

/** Clean an email in place (body only; metadata untouched). */
export function cleanEmail(email: EmailContext, opts: CleanOptions = {}): { email: EmailContext; clean: CleanResult } {
  const clean = cleanBody(email.body ?? "", opts);
  return { email: { ...email, body: clean.text }, clean };
}

/* ------------------------------------------------------------------------- */
/*  Threads                                                                  */
/* ------------------------------------------------------------------------- */

export interface SlimThreadOptions {
  /** Most recent messages kept verbatim (THREAD_MAX_MESSAGES). */
  maxMessages?: number;
  /** Budget for the whole thread (LLM_INPUT_MAX_CHARS). */
  maxChars?: number;
}

export interface SlimThreadResult {
  /** Most recent messages, cleaned and deduplicated, oldest first. */
  messages: EmailContext[];
  /** One-line-per-message digest of the messages that did not fit. */
  digest: string;
  originalChars: number;
  chars: number;
  tokens: number;
  savedRatio: number;
  droppedMessages: number;
}

/** Signature of a text line used to detect it was already quoted elsewhere. */
const lineKey = (line: string): string => line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Slim a whole conversation:
 *  - clean every message body,
 *  - remove lines that already appeared in a *more recent* message (quoted text
 *    is duplicated across a reply chain — sending it N times is pure waste),
 *  - keep the `maxMessages` most recent verbatim, digest the older ones,
 *  - keep the total under `maxChars`, dropping from the oldest end.
 */
export function slimThread(messages: EmailContext[], opts: SlimThreadOptions = {}): SlimThreadResult {
  const maxMessages = Math.max(1, opts.maxMessages ?? 12);
  const maxChars = opts.maxChars ?? 12000;
  const sorted = [...messages].sort((a, b) => (a.receivedAt ?? a.sentAt ?? "").localeCompare(b.receivedAt ?? b.sentAt ?? ""));
  const originalChars = sorted.reduce((n, m) => n + (m.body?.length ?? 0), 0);

  // Newest → oldest so that the *first* occurrence of a line (the most recent) wins.
  const seen = new Set<string>();
  const cleanedDesc: EmailContext[] = [];
  for (const m of [...sorted].reverse()) {
    const cleaned = cleanBody(m.body ?? "", { maxChars });
    const kept: string[] = [];
    for (const line of cleaned.text.split("\n")) {
      const key = lineKey(line);
      if (key.length < 12) {
        kept.push(line); // short lines (dates, names, "OK") are not worth deduplicating
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(line);
    }
    cleanedDesc.push({ ...m, body: collapseWhitespace(kept.join("\n")) });
  }
  const cleaned = cleanedDesc.reverse();

  const recent = cleaned.slice(-maxMessages);
  const older = cleaned.slice(0, Math.max(0, cleaned.length - maxMessages));

  // Budget: the digest first (it is tiny), then the recent messages from the newest back.
  const digest = buildDigest(older);
  let budget = Math.max(0, maxChars - digest.length);
  const keptReversed: EmailContext[] = [];
  for (const m of [...recent].reverse()) {
    const len = (m.body?.length ?? 0) + (m.subject?.length ?? 0) + 120;
    if (keptReversed.length && len > budget) continue;
    budget -= len;
    keptReversed.push(budget < 0 ? { ...m, body: capHeadTail(m.body ?? "", Math.max(200, (m.body?.length ?? 0) + budget)) } : m);
  }
  const keptMessages = keptReversed.reverse();
  const chars = keptMessages.reduce((n, m) => n + (m.body?.length ?? 0), 0) + digest.length;

  return {
    messages: keptMessages,
    digest,
    originalChars,
    chars,
    tokens: estimateTokens(`${digest}${keptMessages.map((m) => m.body).join("")}`),
    savedRatio: originalChars ? Number(Math.max(0, 1 - chars / originalChars).toFixed(3)) : 0,
    droppedMessages: cleaned.length - keptMessages.length,
  };
}

/** One compact line per older message: date · sender · subject · first sentence. */
export function buildDigest(messages: EmailContext[], maxCharsPerLine = 180): string {
  if (!messages.length) return "";
  const lines = messages.map((m) => {
    const date = (m.receivedAt ?? m.sentAt ?? "").slice(0, 10) || "?";
    const who = m.from?.name || m.from?.address || "?";
    const first = collapseWhitespace(m.body ?? "")
      .split(/(?<=[.!?])\s+|\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 15) ?? "";
    const line = `- ${date} · ${who} · ${m.subject || "(no subject)"}${first ? ` — ${first}` : ""}`;
    return line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 1)}…` : line;
  });
  return `### EARLIER MESSAGES (digest, ${messages.length} message${messages.length > 1 ? "s" : ""}, oldest first)\n${lines.join("\n")}\n### END DIGEST`;
}
