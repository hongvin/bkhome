/**
 * The offline key/value store.
 *
 * The real implementation is IndexedDB — that is what survives a page reload and
 * a device reboot, which is what "works in an MRT tunnel" requires. Node (tests,
 * SSR) has no IndexedDB, so an equivalent in-memory store is used there and
 * `kind` reports which one is live. Every caller sees the same interface, so the
 * cache logic is identical in both.
 */

export type StoreKind = "indexeddb" | "memory";

export interface KeyValueStore {
  readonly kind: StoreKind;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

function clone<T>(value: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** Deterministic, dependency-free store used by tests and by Node fallback. */
export class MemoryKeyValueStore implements KeyValueStore {
  readonly kind = "memory" as const;
  private readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    if (!this.entries.has(key)) return null;
    return clone(this.entries.get(key) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, clone(value));
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()].sort();
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

export const OFFLINE_DB_NAME = "bob-transit-offline";
export const OFFLINE_STORE_NAME = "kv";
const OFFLINE_DB_VERSION = 1;

export interface IndexedDbStoreOptions {
  databaseName?: string;
  storeName?: string;
  /** Injectable for tests; defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
}

export class IndexedDbKeyValueStore implements KeyValueStore {
  readonly kind = "indexeddb" as const;
  private db: IDBDatabase | null = null;
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly factory: IDBFactory;

  constructor(options: IndexedDbStoreOptions = {}) {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error("IndexedDB is not available in this environment");
    }
    this.factory = factory;
    this.databaseName = options.databaseName ?? OFFLINE_DB_NAME;
    this.storeName = options.storeName ?? OFFLINE_STORE_NAME;
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, OFFLINE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error("indexedDB.open failed"));
      request.onblocked = () =>
        reject(new Error("indexedDB.open blocked by another open connection"));
    });
  }

  private async request<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(this.storeName, mode);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const request = run(tx.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.request<T | undefined>("readonly", (store) => store.get(key));
    return value === undefined ? null : value;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.request<IDBValidKey>("readwrite", (store) => store.put(clone(value), key));
  }

  async delete(key: string): Promise<void> {
    await this.request<undefined>("readwrite", (store) => store.delete(key));
  }

  async keys(): Promise<string[]> {
    const keys = await this.request<IDBValidKey[]>("readonly", (store) =>
      store.getAllKeys(),
    );
    return keys.map(String).sort();
  }

  async clear(): Promise<void> {
    await this.request<undefined>("readwrite", (store) => store.clear());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export function isIndexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== "undefined" && globalThis.indexedDB !== null;
}

export interface CreateOfflineStoreOptions extends IndexedDbStoreOptions {
  /** Force the in-memory store (tests, or a privacy mode with no storage). */
  forceMemory?: boolean;
}

export interface OfflineStoreHandle {
  store: KeyValueStore;
  /** Why the in-memory store was used instead of IndexedDB, when it was. */
  fallbackReason: string | null;
}

/**
 * Open the best available store. Never throws: if IndexedDB is missing or
 * refuses to open (private browsing, quota), the caller gets a working
 * in-memory store plus an honest `fallbackReason`.
 */
export async function openOfflineStore(
  options: CreateOfflineStoreOptions = {},
): Promise<OfflineStoreHandle> {
  if (options.forceMemory) {
    return { store: new MemoryKeyValueStore(), fallbackReason: "forced in-memory store" };
  }
  if (!options.factory && !isIndexedDbAvailable()) {
    return {
      store: new MemoryKeyValueStore(),
      fallbackReason: "IndexedDB unavailable in this environment",
    };
  }
  try {
    const store = new IndexedDbKeyValueStore(options);
    // Probe the connection now so a failure surfaces here rather than mid-cache.
    await store.keys();
    return { store, fallbackReason: null };
  } catch (error) {
    return {
      store: new MemoryKeyValueStore(),
      fallbackReason: `IndexedDB unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
