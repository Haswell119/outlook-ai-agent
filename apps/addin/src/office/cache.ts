/**
 * Per-session cache of the items the user opened, keyed by conversationId.
 * Used for (a) thread synthesis when Graph is not enabled and (b) "Index recent emails".
 * Stored in localStorage (falls back to memory when storage is unavailable).
 */
import type { EmailContext } from "@oao/shared";

const KEY = "oao.addin.conversationCache.v1";
const MAX_ITEMS = 200;

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

let memory: CachedItem[] | null = null;

function load(): CachedItem[] {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    memory = raw ? (JSON.parse(raw) as CachedItem[]) : [];
  } catch {
    memory = [];
  }
  return memory;
}

function persist(items: CachedItem[]): void {
  memory = items;
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
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
