/**
 * A minimal in-memory IndexedDB double.
 *
 * Node has no IndexedDB, so the browser store cannot be exercised for real in
 * vitest. This implements exactly the subset `IndexedDbKeyValueStore` uses —
 * `open` (with `onupgradeneeded`), `createObjectStore`, `transaction`,
 * `objectStore`, `put`/`get`/`delete`/`getAllKeys`/`clear` — with asynchronous
 * request callbacks, so the production code path is genuinely under test rather
 * than being swapped for the memory store.
 *
 * It is a test double, so it is cast to `IDBFactory` at the boundary.
 */

type RequestCallback = (() => void) | null;

export class FakeRequest<T> {
  result: T;
  error: Error | null = null;
  onsuccess: RequestCallback = null;
  onerror: RequestCallback = null;
  onblocked: RequestCallback = null;
  onupgradeneeded: RequestCallback = null;

  constructor(result: T) {
    this.result = result;
  }
}

class FakeObjectStore {
  readonly data = new Map<string, unknown>();

  put(value: unknown, key: string): FakeRequest<string> {
    this.data.set(key, value);
    return this.succeed(key);
  }

  get(key: string): FakeRequest<unknown> {
    return this.succeed(this.data.get(key));
  }

  delete(key: string): FakeRequest<undefined> {
    this.data.delete(key);
    return this.succeed(undefined);
  }

  getAllKeys(): FakeRequest<string[]> {
    return this.succeed([...this.data.keys()]);
  }

  clear(): FakeRequest<undefined> {
    this.data.clear();
    return this.succeed(undefined);
  }

  private succeed<T>(result: T): FakeRequest<T> {
    const request = new FakeRequest<T>(result);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: RequestCallback = null;
  onabort: RequestCallback = null;

  constructor(private readonly database: FakeDatabase) {
    queueMicrotask(() => this.oncomplete?.());
  }

  objectStore(name: string): FakeObjectStore {
    return this.database.store(name);
  }
}

class FakeObjectStoreNames {
  constructor(private readonly names: Set<string>) {}

  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeObjectStore>();
  private readonly storeNames = new Set<string>();
  readonly objectStoreNames = new FakeObjectStoreNames(this.storeNames);

  constructor(readonly name: string) {}

  createObjectStore(name: string): FakeObjectStore {
    const store = new FakeObjectStore();
    this.stores.set(name, store);
    this.storeNames.add(name);
    return store;
  }

  store(name: string): FakeObjectStore {
    const store = this.stores.get(name);
    if (!store) throw new Error(`no such object store: ${name}`);
    return store;
  }

  transaction(_names: string | string[], _mode?: string): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void {
    // no-op
  }
}

export interface FakeIndexedDb {
  factory: IDBFactory;
  /** Drop all databases, so each test starts clean. */
  reset(): void;
  /** Make every subsequent `open()` fail, to test the fallback path. */
  failNextOpen(): void;
}

export function createFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, FakeDatabase>();
  let failNext = false;

  const factory = {
    open(name: string, _version?: number) {
      const request = new FakeRequest<FakeDatabase | undefined>(undefined);
      queueMicrotask(() => {
        if (failNext) {
          failNext = false;
          request.error = new Error("simulated IndexedDB failure");
          request.onerror?.();
          return;
        }
        let database = databases.get(name);
        const isNew = database === undefined;
        if (!database) {
          database = new FakeDatabase(name);
          databases.set(name, database);
        }
        if (isNew) {
          request.result = database;
          request.onupgradeneeded?.();
        }
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name: string) {
      const request = new FakeRequest<undefined>(undefined);
      databases.delete(name);
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };

  return {
    // Documented cast: the double implements the subset the store uses.
    factory: factory as unknown as IDBFactory,
    reset: () => databases.clear(),
    failNextOpen: () => {
      failNext = true;
    },
  };
}
