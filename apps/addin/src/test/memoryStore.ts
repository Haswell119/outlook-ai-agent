import type { KvStore } from "@/cache/idb";

/** An in-memory `KvStore` so cache tests never touch a real IndexedDB. */
export function memoryStore(): KvStore {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    set: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    keys: async () => [...map.keys()],
    clear: async () => map.clear(),
    backend: () => "memory",
  };
}
