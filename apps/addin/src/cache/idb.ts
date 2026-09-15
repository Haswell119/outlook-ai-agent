/**
 * ~100-line IndexedDB key/value wrapper with an automatic in-memory fallback.
 *
 * Why not localStorage: analyses are 2–10 kB of JSON each and we keep a day of
 * them; localStorage is synchronous (janks the pane on every write) and capped
 * at ~5 MB per origin. IndexedDB is asynchronous and available in every Outlook
 * webview (Edge WebView2, Safari/WKWebView on Mac, OWA).
 *
 * Everything degrades silently: in private windows, when site data is blocked
 * or when the add-in runs in an iframe with third-party storage partitioning
 * disabled, `open()` throws or never fires and we transparently use a Map that
 * lives for the session. The caller never has to care.
 */

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
  /** "idb" when IndexedDB is really used, "memory" when we fell back. */
  readonly backend: () => "idb" | "memory";
}

const OPEN_TIMEOUT_MS = 2_000;

function memoryStore(): KvStore {
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

/**
 * Create a store backed by `dbName`/`storeName`. The IndexedDB handle is opened
 * lazily on first use and, if that fails or takes longer than 2 s, the store
 * permanently degrades to memory for this session.
 */
export function createStore(dbName: string, storeName: string): KvStore {
  const fallback = memoryStore();
  let degraded = false;
  let dbPromise: Promise<IDBDatabase | null> | null = null;

  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      const done = (db: IDBDatabase | null) => {
        if (settled) return;
        settled = true;
        if (!db) degraded = true;
        resolve(db);
      };
      const timer = setTimeout(() => done(null), OPEN_TIMEOUT_MS);
      try {
        const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
        if (!idb) {
          clearTimeout(timer);
          done(null);
          return;
        }
        const req = idb.open(dbName, 1);
        req.onupgradeneeded = () => {
          try {
            if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
          } catch {
            /* handled by onerror */
          }
        };
        req.onsuccess = () => {
          clearTimeout(timer);
          done(req.result);
        };
        req.onerror = req.onblocked = () => {
          clearTimeout(timer);
          done(null);
        };
      } catch {
        clearTimeout(timer);
        done(null);
      }
    });
    return dbPromise;
  }

  function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
    return openDb().then(
      (db) =>
        new Promise<T | undefined>((resolve) => {
          if (!db) {
            resolve(undefined);
            return;
          }
          try {
            const t = db.transaction(storeName, mode);
            const req = run(t.objectStore(storeName));
            req.onsuccess = () => resolve(req.result as T);
            req.onerror = () => resolve(undefined);
            t.onabort = t.onerror = () => resolve(undefined);
          } catch {
            degraded = true;
            resolve(undefined);
          }
        }),
    );
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      if (degraded) return fallback.get<T>(key);
      const v = await tx<T>("readonly", (s) => s.get(key));
      return degraded ? fallback.get<T>(key) : v;
    },
    async set<T>(key: string, value: T): Promise<void> {
      if (degraded) return fallback.set(key, value);
      await tx<void>("readwrite", (s) => s.put(value as unknown as never, key));
      if (degraded) await fallback.set(key, value);
    },
    async delete(key: string): Promise<void> {
      if (degraded) return fallback.delete(key);
      await tx<void>("readwrite", (s) => s.delete(key));
    },
    async keys(): Promise<string[]> {
      if (degraded) return fallback.keys();
      const k = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
      return degraded ? fallback.keys() : (k ?? []).map(String);
    },
    async clear(): Promise<void> {
      await fallback.clear();
      if (degraded) return;
      await tx<void>("readwrite", (s) => s.clear());
    },
    backend: () => (degraded ? "memory" : "idb"),
  };
}
