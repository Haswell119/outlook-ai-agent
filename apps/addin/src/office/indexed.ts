/**
 * Which cached emails this browser already sent to `POST /index/emails`.
 *
 * Without Microsoft Graph the orchestrator only knows the emails it was given:
 * the ones analysed in the pane (indexed server-side, `INDEX_ON_ANALYZE`) and
 * the ones the add-in indexes itself (multi-select, "All emails" questions).
 * This set keeps the add-in from re-sending the same messages on every
 * question. Scoped to the mailbox like the conversation cache, stored in
 * localStorage (memory fallback), bounded.
 */
import { mailboxScope } from "./env";

const KEY_PREFIX = "oao.addin.indexedIds.v1";
const MAX_IDS = 1000;

let memory: { scope: string; ids: string[] } | null = null;

const storageKey = () => `${KEY_PREFIX}.${mailboxScope()}`;

function load(): string[] {
  const scope = storageKey();
  if (memory && memory.scope === scope) return memory.ids;
  let ids: string[] = [];
  try {
    const raw = localStorage.getItem(scope);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    ids = [];
  }
  memory = { scope, ids };
  return ids;
}

function persist(ids: string[]): void {
  const scope = storageKey();
  memory = { scope, ids };
  try {
    localStorage.setItem(scope, JSON.stringify(ids));
  } catch {
    /* storage unavailable: memory only */
  }
}

export function isIndexed(emailId: string): boolean {
  return load().includes(emailId);
}

/** Remember that these emails are in the orchestrator's index (most recent first, bounded). */
export function markIndexed(emailIds: string[]): void {
  if (!emailIds.length) return;
  const fresh = new Set(emailIds);
  persist([...emailIds, ...load().filter((id) => !fresh.has(id))].slice(0, MAX_IDS));
}

/** The subset of `emails` this browser has not sent for indexing yet. */
export function notYetIndexed<T extends { id: string }>(emails: T[]): T[] {
  const known = new Set(load());
  return emails.filter((e) => e.id && !known.has(e.id));
}

export function clearIndexed(): void {
  persist([]);
}
