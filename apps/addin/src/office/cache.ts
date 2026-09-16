/**
 * Per-session cache of the items the user opened, keyed by conversationId.
 * Used for (a) thread synthesis when Graph is not enabled and (b) "Index recent emails".
 * Stored in localStorage (falls back to memory when storage is unavailable).
 */
import type { EmailContext } from "@oao/shared";
import { mailboxScope } from "./env";

const KEY_PREFIX = "oao.addin.conversationCache.v1";
const MAX_ITEMS = 200;

/**
 * Scoped to the mailbox: these are message bodies, and they are what the thread
 * synthesis and "Index recent emails" send to the orchestrator. After an account
 * switch in the same browser profile they must not be visible at all.
 */
function storageKey(): string {
  return `${KEY_PREFIX}.${mailboxScope()}`;
}

export interface CachedItem {
  id: string;
  conversationId: string;
  subject: string;
  from?: EmailContext["from"];
  to: EmailContext["to"];
  date?: string;
  body: string;
  attachments: EmailContext["attachments"];
}

/** In-memory mirror, keyed by mailbox so a switch cannot serve the wrong one. */
let memory: { scope: string; items: CachedItem[] } | null = null;

function load(): CachedItem[] {
  const scope = storageKey();
  if (memory && memory.scope === scope) return memory.items;
  let items: CachedItem[] = [];
  try {
    const raw = localStorage.getItem(scope);
    items = raw ? (JSON.parse(raw) as CachedItem[]) : [];
  } catch {
    items = [];
  }
  memory = { scope, items };
  return items;
}

function persist(items: CachedItem[]): void {
  const scope = storageKey();
  memory = { scope, items };
  try {
    localStorage.setItem(scope, JSON.stringify(items));
  } catch {
    /* storage unavailable: memory only */
  }
}

export function cacheItem(email: EmailContext): void {
  if (!email.id) return;
  const items = load().filter((i) => i.id !== email.id);
  items.unshift({
    id: email.id,
    conversationId: email.conversationId ?? email.id,
    subject: email.subject,
    from: email.from,
    to: email.to,
    date: email.receivedAt ?? email.sentAt,
    body: email.body.slice(0, 20_000),
    attachments: email.attachments.map((a) => ({ ...a, textContent: undefined })),
  });
  persist(items.slice(0, MAX_ITEMS));
}

export function loadConversationFromCache(conversationId: string): EmailContext[] {
  return load()
    .filter((i) => i.conversationId === conversationId)
    .map(toEmailContext)
    .sort((a, b) => (a.receivedAt ?? a.sentAt ?? "").localeCompare(b.receivedAt ?? b.sentAt ?? ""));
}

export function loadRecentFromCache(limit = 50): EmailContext[] {
  return load().slice(0, limit).map(toEmailContext);
}

export function clearCache(): void {
  persist([]);
}

function toEmailContext(i: CachedItem): EmailContext {
  return {
    id: i.id,
    conversationId: i.conversationId,
    subject: i.subject,
    from: i.from,
    to: i.to,
    cc: [],
    bcc: [],
    receivedAt: i.date,
    body: i.body,
    attachments: i.attachments,
    categories: [],
  };
}
