import type { EmailContext } from "@oao/shared";
import { emailDomain, isInternalAddress } from "@oao/shared";
import { sha256 } from "../../util/hash.js";
import { truncate } from "../../util/text.js";
import { extractSignals } from "../heuristics/email.js";
import { cleanBody } from "../prompts/clean.js";
import type { TriageKind } from "../triage.js";
import type { EmailLanguage } from "./routing.js";

/**
 * The *state* sent to the decision engine: a small, explicit object built
 * field by field — never the Graph / Office.js object, never an id, a web
 * link, a recipient address, a token or an attachment's content.
 *
 * Order matters. Laya serialises the state to JSON and, past the checkpoint's
 * window, cuts from the **end**. Metadata therefore comes first, the body
 * after it (the long field), and the optional thread excerpts last (the most
 * expendable). The body itself goes through the same slimming as the LLM
 * prompts (`cleanBody`: quoted history, signatures, disclaimers and tracking
 * URLs removed, then head + tail kept, because the actual ask is often at the
 * end) and is capped so the whole state fits the window of the checkpoint that
 * will read it — otherwise the engine's own truncation would silently drop the
 * tail we deliberately kept.
 *
 * The email text is untrusted *data*: it only ever lands in `subject`,
 * `body`, attachment names and thread excerpts. Questions, criteria, model
 * names and the taxonomy are built elsewhere from server-side constants.
 */

/**
 * Approximate state window per checkpoint, in characters of serialised state.
 * Laya 0.3.x: `english` reads 512 tokens of which ~192 go to the question and
 * options (~320 left for the state); `multilingual` / `typed-decisions` read
 * 1024 with ~256 for the question (~768 left). At ~3.5 characters per token of
 * FR/EN mixed with JSON syntax that is ≈ 1100 and ≈ 2600 characters.
 * `LAYA_INPUT_MAX_CHARS` stays the upper bound; unknown checkpoints (auto
 * routing, custom names) use it alone.
 */
export const CHECKPOINT_STATE_CHAR_BUDGET: Readonly<Record<string, number>> = {
  english: 1_100,
  multilingual: 2_600,
  "typed-decisions": 2_600,
};

/** Smallest body kept even when metadata eats the budget. */
const MIN_BODY_CHARS = 200;
const MAX_ATTACHMENTS = 10;
const MAX_CATEGORIES = 5;
const MAX_PREVIOUS_MESSAGES = 2;
const PREVIOUS_EXCERPT_CHARS = 200;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Strip zero-width / bidi controls (they hide text from a human reviewer) and stray control characters. */
export const sanitizeText = (s: string): string => s.replace(INVISIBLE, "").replace(CONTROL, " ");

export interface DecisionStateInput {
  email: EmailContext;
  /** Detected language of the email (not of the reader). */
  language: EmailLanguage;
  internalDomains: string[];
  /** Already computed by the triage step. */
  triageKind?: TriageKind;
  /** Already computed by the phishing screen. */
  phishingVerdict?: "clean" | "suspicious" | "likely_phishing";
  /** Conversation messages (Graph), when the caller fetched them. */
  thread?: EmailContext[];
  now?: Date;
}

export interface DecisionStateOptions {
  /** `LAYA_INPUT_MAX_CHARS`. */
  maxChars: number;
  /** Checkpoint that will read the state (for its window), when known. */
  model?: string;
}

export interface DecisionStateStats {
  rawBodyChars: number;
  bodyChars: number;
  truncated: boolean;
  /** Character budget applied to the whole state. */
  budgetChars: number;
  /** Serialised size actually sent. */
  stateChars: number;
}

export interface BuiltDecisionState {
  state: Record<string, unknown>;
  /** SHA-256 of the serialised state: correlates audits without storing the content. */
  hash: string;
  stats: DecisionStateStats;
}

const extension = (name: string): string | undefined => {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : undefined;
};

const senderTypeOf = (address: string | undefined, internalDomains: string[]): "internal" | "external" | "unknown" =>
  !address ? "unknown" : isInternalAddress(address, internalDomains) ? "internal" : "external";

export function buildDecisionState(input: DecisionStateInput, opts: DecisionStateOptions): BuiltDecisionState {
  const { email, internalDomains } = input;
  const now = input.now ?? new Date();

  const senderAddress = email.from?.address;
  const senderType = senderTypeOf(senderAddress, internalDomains);
  const senderDomain = senderType === "external" && senderAddress ? emailDomain(senderAddress) : "";
  const recipients = [...email.to, ...email.cc];
  const receivedIso = email.receivedAt ?? email.sentAt;
  const receivedMs = receivedIso ? Date.parse(receivedIso) : Number.NaN;
  const attachments = email.attachments
    .filter((a) => !a.isInline)
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => {
      const ext = extension(a.name ?? "");
      return { name: truncate(sanitizeText(a.name ?? ""), 80), ...(ext ? { extension: ext } : {}) };
    });
  const categories = email.categories.slice(0, MAX_CATEGORIES).map((c) => truncate(sanitizeText(c), 40));
  const s = extractSignals({ subject: email.subject ?? "", body: email.body ?? "", attachments: email.attachments });

  const meta: Record<string, unknown> = {
    language: input.language,
    subject: truncate(sanitizeText(email.subject ?? ""), 300),
    senderType,
    ...(senderDomain ? { senderDomain } : {}),
    recipientCount: recipients.length,
    externalRecipients: recipients.some((r) => !isInternalAddress(r.address, internalDomains)),
    ...(email.importance ? { importance: email.importance } : {}),
    ...(Number.isFinite(receivedMs) ? { receivedAt: new Date(receivedMs).toISOString(), ageHours: Math.max(0, Math.round((now.getTime() - receivedMs) / 360_000) / 10) } : {}),
    hasAttachments: attachments.length > 0,
    ...(attachments.length ? { attachments } : {}),
    ...(categories.length ? { categories } : {}),
    // Deterministic signals the orchestrator already computed (triage, phishing screen, keyword heuristics).
    signals: {
      triage: input.triageKind ?? "conversation",
      phishing: input.phishingVerdict ?? "clean",
      urgencyMarkers: s.urgent,
      deadlineMentioned: s.deadline,
      requestMarkers: s.request,
      questionAsked: s.question,
      missingDocument: s.missingDocument,
      confidentialMarkers: s.confidential,
    },
  };

  const previousMessages = previousExcerpts(input.thread, email, internalDomains);
  const budgetChars = Math.min(opts.maxChars, (opts.model && CHECKPOINT_STATE_CHAR_BUDGET[opts.model]) || opts.maxChars);
  const skeleton = JSON.stringify({ ...meta, body: "", ...(previousMessages.length ? { previousMessages } : {}) }).length;
  const bodyBudget = Math.max(MIN_BODY_CHARS, budgetChars - skeleton);

  const rawBody = email.body ?? "";
  const cleaned = cleanBody(sanitizeText(rawBody), { maxChars: bodyBudget });
  const state: Record<string, unknown> = { ...meta, body: cleaned.text, ...(previousMessages.length ? { previousMessages } : {}) };
  const json = JSON.stringify(state);
  return {
    state,
    hash: sha256(json),
    stats: { rawBodyChars: rawBody.length, bodyChars: cleaned.chars, truncated: cleaned.removed.truncated, budgetChars, stateChars: json.length },
  };
}

/** The last messages of the conversation other than the one decided on, as short excerpts. */
function previousExcerpts(thread: EmailContext[] | undefined, current: EmailContext, internalDomains: string[]): Array<{ senderType: string; excerpt: string }> {
  if (!thread || thread.length < 2) return [];
  return thread
    .filter((m) => m.id !== current.id)
    .sort((a, b) => (a.receivedAt ?? a.sentAt ?? "").localeCompare(b.receivedAt ?? b.sentAt ?? ""))
    .slice(-MAX_PREVIOUS_MESSAGES)
    .map((m) => ({
      senderType: senderTypeOf(m.from?.address, internalDomains),
      excerpt: cleanBody(sanitizeText(m.body ?? ""), { maxChars: PREVIOUS_EXCERPT_CHARS }).text,
    }))
    .filter((m) => m.excerpt.length > 0);
}
