import { beforeEach, describe, expect, it, vi } from "vitest";
import { CACHE_TTL_MS, cacheKey, clearCache, prune, readCached, setCacheStore, writeCached } from "@/cache/analysisCache";
import { createStore } from "@/cache/idb";
import { memoryStore } from "./memoryStore";
import { composeContentHash, emailContentHash, hashParts, hashString, threadContentHash } from "@/util/hash";
import { sampleCompose, sampleEmail, sampleThread } from "@/office/sample";

describe("content hashing", () => {
  it("is stable, and different for different content", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("hellp"));
    expect(hashParts(["a", 1, null])).toBe(hashParts(["a", 1, undefined]));
  });

  it("changes when the body, a recipient or an attachment changes", () => {
    const base = emailContentHash(sampleEmail);
    expect(emailContentHash({ ...sampleEmail })).toBe(base);
    expect(emailContentHash({ ...sampleEmail, body: `${sampleEmail.body} PS: one more thing` })).not.toBe(base);
    expect(emailContentHash({ ...sampleEmail, to: [{ address: "someone.else@northbridge.example" }] })).not.toBe(base);
    expect(emailContentHash({ ...sampleEmail, attachments: [] })).not.toBe(base);
  });

  it("ignores recipient order and address case", () => {
    const a = { ...sampleEmail, to: [{ address: "a@x.example" }, { address: "b@x.example" }] };
    const b = { ...sampleEmail, to: [{ address: "B@X.example" }, { address: "A@x.example" }] };
    expect(emailContentHash(a)).toBe(emailContentHash(b));
  });

  it("hashes a draft and a thread", () => {
    expect(composeContentHash(sampleCompose)).toBe(composeContentHash({ ...sampleCompose }));
    expect(composeContentHash({ ...sampleCompose, subject: "Other" })).not.toBe(composeContentHash(sampleCompose));
    expect(threadContentHash(sampleThread.messages)).toBe(threadContentHash([...sampleThread.messages].reverse()));
  });
});

describe("analysis cache", () => {
  beforeEach(async () => {
    setCacheStore(memoryStore());
    await clearCache();
  });

  it("returns a stored entry and its age", async () => {
    const now = Date.now();
    await writeCached("analysis", "msg-1", "h1", { summary: "hi" }, now - 60_000);
    const hit = await readCached<{ summary: string }>("analysis", "msg-1", "h1", { now });
    expect(hit?.value.summary).toBe("hi");
    expect(hit?.ageMs).toBeGreaterThanOrEqual(59_000);
  });

  it("misses when the content hash changed", async () => {
    await writeCached("analysis", "msg-1", "h1", { summary: "hi" });
    expect(await readCached("analysis", "msg-1", "h2")).toBeNull();
  });

  it("drops an entry older than the 24 h TTL", async () => {
    const now = Date.now();
    await writeCached("analysis", "msg-1", "h1", { summary: "old" }, now - CACHE_TTL_MS - 1_000);
    expect(await readCached("analysis", "msg-1", "h1", { now })).toBeNull();
    // and it is really gone, not just hidden
    expect(await readCached("analysis", "msg-1", "h1", { now: now - CACHE_TTL_MS })).toBeNull();
  });

  it("bypass deletes the entry so a refresh really refreshes", async () => {
    await writeCached("analysis", "msg-1", "h1", { summary: "stale" });
    expect(await readCached("analysis", "msg-1", "h1", { bypass: true })).toBeNull();
    expect(await readCached("analysis", "msg-1", "h1")).toBeNull();
  });

  it("namespaces kinds and ids", () => {
    expect(cacheKey("analysis", "a", "h")).not.toBe(cacheKey("thread", "a", "h"));
    expect(cacheKey("analysis", "a", "h")).not.toBe(cacheKey("analysis", "b", "h"));
    // Ids containing the separator cannot collide with another id.
    expect(cacheKey("analysis", "a:b", "h")).not.toBe(cacheKey("analysis", "a", "b:h"));
  });

  it("prune removes expired entries", async () => {
    const now = Date.now();
    for (let i = 0; i < 80; i++) await writeCached("analysis", `old-${i}`, "h", { i }, now - CACHE_TTL_MS - 1);
    await writeCached("analysis", "fresh", "h", { ok: true }, now);
    const removed = await prune(now);
    expect(removed).toBeGreaterThanOrEqual(80);
    expect(await readCached("analysis", "fresh", "h", { now })).not.toBeNull();
  });

  it("degrades to memory when IndexedDB is unavailable", async () => {
    const original = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    // jsdom without fake-indexeddb has no indexedDB at all.
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true, writable: true });
    const store = createStore("oao-test", "kv");
    await store.set("k", { v: 1 });
    expect(await store.get<{ v: number }>("k")).toEqual({ v: 1 });
    expect(store.backend()).toBe("memory");
    Object.defineProperty(globalThis, "indexedDB", { value: original, configurable: true, writable: true });
  });

  it("never throws when the store rejects", async () => {
    setCacheStore({
      get: vi.fn().mockRejectedValue(new Error("blocked")),
      set: vi.fn().mockRejectedValue(new Error("blocked")),
      delete: vi.fn().mockRejectedValue(new Error("blocked")),
      keys: vi.fn().mockRejectedValue(new Error("blocked")),
      clear: vi.fn().mockRejectedValue(new Error("blocked")),
      backend: () => "memory",
    });
    await expect(writeCached("analysis", "x", "h", { a: 1 })).resolves.toBeUndefined();
    await expect(readCached("analysis", "x", "h")).resolves.toBeNull();
    await expect(clearCache()).resolves.toBeUndefined();
  });
});
