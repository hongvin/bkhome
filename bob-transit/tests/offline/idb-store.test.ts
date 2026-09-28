import { beforeEach, describe, expect, it } from "vitest";
import {
  IndexedDbKeyValueStore,
  MemoryKeyValueStore,
  isIndexedDbAvailable,
  openOfflineStore,
} from "@/lib/offline/store";
import { createFakeIndexedDb, type FakeIndexedDb } from "./fake-indexeddb";

let fake: FakeIndexedDb;

beforeEach(() => {
  fake = createFakeIndexedDb();
});

describe("IndexedDbKeyValueStore", () => {
  it("round-trips values through a real IndexedDB code path", async () => {
    const store = new IndexedDbKeyValueStore({ factory: fake.factory });
    expect(store.kind).toBe("indexeddb");

    expect(await store.get("missing")).toBeNull();
    await store.set("graph", { builtAt: "2025-01-01T00:00:00.000Z", stations: ["KJ10"] });
    await store.set("cursor", "2025-01-02T00:35:00.000Z");

    expect(await store.get<{ stations: string[] }>("graph")).toEqual({
      builtAt: "2025-01-01T00:00:00.000Z",
      stations: ["KJ10"],
    });
    expect(await store.keys()).toEqual(["cursor", "graph"]);

    await store.delete("graph");
    expect(await store.get("graph")).toBeNull();
    expect(await store.keys()).toEqual(["cursor"]);

    await store.clear();
    expect(await store.keys()).toEqual([]);
  });

  it("structured-clones on write, so later mutation cannot corrupt the cache", async () => {
    const store = new IndexedDbKeyValueStore({ factory: fake.factory });
    const value = { nested: { count: 1 } };
    await store.set("key", value);
    value.nested.count = 99;
    expect(await store.get<{ nested: { count: number } }>("key")).toEqual({ nested: { count: 1 } });
  });

  it("survives a reopen of the same database", async () => {
    const first = new IndexedDbKeyValueStore({ factory: fake.factory });
    await first.set("persisted", { ok: true });
    first.close();

    const second = new IndexedDbKeyValueStore({ factory: fake.factory });
    expect(await second.get<{ ok: boolean }>("persisted")).toEqual({ ok: true });
  });
});

describe("openOfflineStore", () => {
  it("prefers IndexedDB when it is available", async () => {
    const handle = await openOfflineStore({ factory: fake.factory });
    expect(handle.store.kind).toBe("indexeddb");
    expect(handle.fallbackReason).toBeNull();
  });

  it("falls back to memory, with a reason, when IndexedDB refuses to open", async () => {
    fake.failNextOpen();
    const handle = await openOfflineStore({ factory: fake.factory });
    expect(handle.store.kind).toBe("memory");
    expect(handle.fallbackReason).toContain("IndexedDB unavailable");
    await handle.store.set("k", 1);
    expect(await handle.store.get<number>("k")).toBe(1);
  });

  it("honours an explicit request for the memory store", async () => {
    const handle = await openOfflineStore({ forceMemory: true });
    expect(handle.store.kind).toBe("memory");
    expect(handle.fallbackReason).toBe("forced in-memory store");
  });

  it("reports IndexedDB as unavailable in bare Node", () => {
    expect(isIndexedDbAvailable()).toBe(false);
  });
});

describe("MemoryKeyValueStore", () => {
  it("behaves like the IndexedDB store", async () => {
    const store = new MemoryKeyValueStore();
    expect(store.kind).toBe("memory");
    expect(await store.get("missing")).toBeNull();
    await store.set("a", { v: [1, 2, 3] });
    expect(await store.get("a")).toEqual({ v: [1, 2, 3] });
    expect(await store.keys()).toEqual(["a"]);
    await store.delete("a");
    expect(await store.keys()).toEqual([]);
  });
});
