/**
 * Local cache of model output (analyses, thread syntheses, daily brief).
 *
 * Purpose: never ask the backend — and therefore never ask the model — twice for
 * the same content. Switching back to an email you already opened is instant and
 * costs nothing.
 *
 * Key      `<kind>:<id>:<contentHash>`  (content hash from util/hash)
 * TTL      24 h (entries are also pruned lazily on read and on startup)
 * Storage  IndexedDB, falling back to memory (see cache/idb.ts)
 *
 * Cache-Control-like semantics:
 *   - default          → `readCached` returns a fresh entry when one exists
 *   - "no-cache"       → the Refresh button passes `bypass: true`: the entry is
 *                        ignored *and* deleted, so the next request re-fetches
 *   - stale entries    → deleted on read, never served
 */
import { hashParts } from "@/util/hash";
import { createStore, type KvStore } from "./idb";

export type CacheKind = "analysis" | "thread" | "brief";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap so a busy mailbox cannot grow the store without bound. */
export const CACHE_MAX_ENTRIES = 300;

export interface CacheEntry<T> {
  /** Cached payload. */
  value: T;
  /** Epoch ms when it was stored. */
  storedAt: number;
  /** Content hash it was computed for. */
  hash: string;
  kind: CacheKind;
  id: string;
}

export interface CacheHit<T> {
  value: T;
  storedAt: number;
  ageMs: number;
}

/**
 * The IndexedDB handle inside `createStore` is opened lazily on first use, so
 * building the store at module scope costs nothing and never throws.
 */
let store: KvStore = createStore("oao-addin", "analyses");

/** Test seam: replace the backing store (also used to reset between tests). */
export function setCacheStore(next: KvStore): void {
  store = next;
}

export function cacheBackend(): "idb" | "memory" {
  return store.backend();
}

export function cacheKey(kind: CacheKind, id: string, hash: string): string {
  // `id` can contain ':' (REST ids are base64url, EWS ids are long) → hash it.
  return `${kind}:${hashParts([id])}:${hash}`;
}

/**
 * Read a non-expired entry. Returns `null` on a miss, on an expired entry
 * (which is deleted) or when `bypass` is set (the entry is deleted too, so a
 * Refresh really refreshes).
 */
export async function readCached<T>(
  kind: CacheKind,
  id: string,
  hash: string,
  opts: { bypass?: boolean; now?: number } = {},
): Promise<CacheHit<T> | null> {
  const key = cacheKey(kind, id, hash);
  if (opts.bypass) {
    await store.delete(key).catch(() => undefined);
    return null;
  }
  const entry = await store.get<CacheEntry<T>>(key).catch(() => undefined);
  if (!entry || typeof entry.storedAt !== "number") return null;
  const now = opts.now ?? Date.now();
  const ageMs = now - entry.storedAt;
  if (ageMs > CACHE_TTL_MS || ageMs < -60_000) {
    await store.delete(key).catch(() => undefined);
    return null;
  }
  return { value: entry.value, storedAt: entry.storedAt, ageMs };
}

export async function writeCached<T>(kind: CacheKind, id: string, hash: string, value: T, now = Date.now()): Promise<void> {
  const entry: CacheEntry<T> = { value, storedAt: now, hash, kind, id };
  await store.set(cacheKey(kind, id, hash), entry).catch(() => undefined);
  void prune(now);
}

/** Drop expired entries and, if still over the cap, the oldest ones. */
export async function prune(now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    const keys = await store.keys();
    if (keys.length <= CACHE_MAX_ENTRIES / 2) {
      // Cheap path: only look for expired entries once the store grows.
      if (keys.length < CACHE_MAX_ENTRIES / 4) return 0;
    }
    const entries: Array<{ key: string; storedAt: number }> = [];
    for (const key of keys) {
      const e = await store.get<CacheEntry<unknown>>(key);
      const storedAt = e && typeof e.storedAt === "number" ? e.storedAt : 0;
      if (!e || now - storedAt > CACHE_TTL_MS) {
        await store.delete(key);
        removed++;
      } else {
        entries.push({ key, storedAt });
      }
    }
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => a.storedAt - b.storedAt);
      for (const e of entries.slice(0, entries.length - CACHE_MAX_ENTRIES)) {
        await store.delete(e.key);
        removed++;
      }
    }
  } catch {
    /* pruning is best-effort */
  }
  return removed;
}

/** "Clear local cache" in the settings sheet. */
export async function clearCache(): Promise<void> {
  await store.clear().catch(() => undefined);
}

/** Rough size report for the settings sheet. */
export async function cacheStats(): Promise<{ entries: number; backend: "idb" | "memory" }> {
  try {
    return { entries: (await store.keys()).length, backend: store.backend() };
  } catch {
    return { entries: 0, backend: store.backend() };
  }
}
