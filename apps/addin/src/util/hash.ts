/**
 * Tiny, dependency-free content hashing used as a cache key.
 *
 * We do not need cryptographic strength: the hash only has to change when the
 * content the model would see changes, so that a cached analysis is never shown
 * for an email whose body / recipients / attachments changed. FNV-1a 32 bit is
 * combined with a second (djb2) pass and the input length, which keeps the
 * collision probability negligible for the few hundred entries we cache.
 *
 * Deliberately synchronous (no SubtleCrypto): it runs on the UI thread for
 * every item switch and must never add a microtask.
 */
import type { ComposeContext, EmailContext } from "@oao/shared";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Separator that cannot occur in mail content (unit separator). */
const SEP = String.fromCharCode(31);

/** Stable hex hash of a string (16 hex chars + base36 length suffix). */
export function hashString(input: string): string {
  let fnv = FNV_OFFSET;
  let djb = 5381;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    fnv = Math.imul(fnv ^ c, FNV_PRIME) >>> 0;
    djb = ((djb << 5) + djb + c) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, "0")}${djb.toString(16).padStart(8, "0")}${input.length.toString(36)}`;
}

/** Join heterogeneous parts with a separator that cannot appear in the values. */
export function hashParts(parts: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return hashString(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join(SEP));
}

function addresses(list: ReadonlyArray<{ address: string }> | undefined): string {
  return (list ?? [])
    .map((a) => a.address.toLowerCase())
    .sort()
    .join(",");
}

function attachments(list: EmailContext["attachments"] | undefined): string {
  return (list ?? [])
    .map((a) => `${a.name}:${a.size ?? ""}`)
    .sort()
    .join(",");
}

/**
 * Hash of everything the orchestrator would send to the model for a read item.
 * Changing the subject, body, recipients, attachments or categories invalidates
 * the cached analysis; opening the same unchanged email does not.
 */
export function emailContentHash(email: EmailContext): string {
  return hashParts([
    email.subject,
    email.from?.address?.toLowerCase(),
    addresses(email.to),
    addresses(email.cc),
    attachments(email.attachments),
    email.categories.join(","),
    email.importance,
    email.body,
  ]);
}

/**
 * Hash of a draft: recipients + subject + body + attachments (+ label).
 * Used to skip the compliance check when nothing changed.
 */
export function composeContentHash(draft: ComposeContext): string {
  return hashParts([
    addresses(draft.to),
    addresses(draft.cc),
    addresses(draft.bcc),
    draft.subject,
    draft.body,
    attachments(draft.attachments),
    draft.sensitivityLabel,
  ]);
}

/** Hash of a thread: every message id + its own content hash. */
export function threadContentHash(messages: ReadonlyArray<EmailContext>): string {
  return hashParts(messages.map((m) => `${m.id}:${emailContentHash(m)}`).sort());
}
