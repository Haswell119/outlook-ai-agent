/**
 * Bounded, persistent outbox for fire-and-forget telemetry-like POSTs —
 * today only Automation Coach `observe` events.
 *
 * Rules (deliberately conservative for a regulated environment):
 *  - at most MAX_ITEMS events are kept; the oldest are dropped first,
 *  - an event older than MAX_AGE_MS (24 h) is dropped, never sent: a stale
 *    "user opened this email" observation has no value and would pollute
 *    routine detection,
 *  - the queue is persisted in localStorage so a pane reload does not lose it,
 *    and silently degrades to memory when storage is unavailable,
 *  - flushing is serial and stops at the first failure so we never hammer a
 *    backend that is down; the caller retries on the next flush trigger
 *    (connectivity change, pane open, successful request).
 */
import type { UserActionEvent } from "@oao/shared";

const KEY = "oao.addin.outbox.v1";
export const MAX_ITEMS = 100;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface OutboxItem {
  /** Local id, only used for de-duplication inside the queue. */
  id: string;
  queuedAt: number;
  event: UserActionEvent;
}

let memory: OutboxItem[] | null = null;
let seq = 0;

function read(): OutboxItem[] {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    memory = Array.isArray(parsed) ? parsed.filter((i) => i && i.event && typeof i.queuedAt === "number") : [];
  } catch {
    memory = [];
  }
  return memory;
}

function write(items: OutboxItem[]): void {
  memory = items;
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* memory only */
  }
}

/** Drop everything older than 24 h. Returns the number of dropped events. */
export function expire(now = Date.now()): number {
  const items = read();
  const kept = items.filter((i) => now - i.queuedAt <= MAX_AGE_MS);
  if (kept.length !== items.length) write(kept);
  return items.length - kept.length;
}

export function enqueue(event: UserActionEvent, now = Date.now()): void {
  expire(now);
  const items = read();
  items.push({ id: `${now.toString(36)}-${(seq++).toString(36)}`, queuedAt: now, event });
  // Drop the oldest when over the cap.
  write(items.slice(Math.max(0, items.length - MAX_ITEMS)));
}

export function size(): number {
  return read().length;
}

export function peek(): OutboxItem[] {
  return [...read()];
}

export function clearOutbox(): void {
  write([]);
}

/**
 * Send queued events with `send`. Stops at the first rejection (the remaining
 * events stay queued). Returns how many were sent and how many were dropped
 * because they had expired.
 */
export async function flush(
  send: (event: UserActionEvent) => Promise<void>,
  now = Date.now(),
): Promise<{ sent: number; dropped: number; remaining: number }> {
  const dropped = expire(now);
  let sent = 0;
  // Re-read on every iteration: `enqueue` may run while we await.
  for (;;) {
    const items = read();
    const next = items[0];
    if (!next) break;
    try {
      await send(next.event);
    } catch {
      break;
    }
    write(read().filter((i) => i.id !== next.id));
    sent++;
  }
  return { sent, dropped, remaining: size() };
}
