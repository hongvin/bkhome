import { afterEach, describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, type TransitGraph } from "@/lib/contracts/network";
import {
  GraphCache,
  GraphFetchError,
  OfflineNoCacheError,
  defaultGraphFetcher,
  loadGraph,
} from "@/lib/offline/graph-cache";
import { MemoryKeyValueStore } from "@/lib/offline/store";
import { makeGraph } from "./fixtures";

const NOW = new Date("2025-01-02T00:42:00.000Z");

function stubFetch(impl: (url: string) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    return impl(url);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("GraphCache round trip", () => {
  it("serialises, stores, loads and deep-equals the transit graph", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new GraphCache(store);
    const graph = makeGraph();

    expect(await cache.load()).toBeNull();

    const envelope = await cache.save(graph, "2025-01-02T00:35:00.000Z");
    expect(envelope.contractsVersion).toBe(CONTRACTS_VERSION);
    expect(envelope.builtAt).toBe(graph.builtAt);
    expect(envelope.byteSize).toBe(JSON.stringify(graph).length);

    const loaded = await cache.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.graph).toEqual(graph);
    expect(loaded?.graph.stats.connectionCount).toBe(graph.connections.length);
    expect(loaded?.cachedAt).toBe("2025-01-02T00:35:00.000Z");
  });

  it("keeps the graph intact across a structured-clone boundary", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new GraphCache(store);
    const graph = makeGraph();
    await cache.save(graph, "2025-01-02T00:35:00.000Z");

    graph.stations[0].name = "MUTATED AFTER SAVE";
    const loaded = await cache.load();
    expect(loaded?.graph.stations[0].name).toBe("KLCC");
  });

  it("refuses to serve a graph built for a different contracts version", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new GraphCache(store);
    await cache.save(makeGraph({ contractsVersion: "0.9.0" as typeof CONTRACTS_VERSION }), "2025-01-02T00:35:00.000Z");

    expect(await cache.load()).toBeNull();
    const inspection = await cache.inspect();
    expect(inspection.present).toBe(true);
    expect(inspection.compatible).toBe(false);
    expect(inspection.reason).toContain("contracts");
  });

  it("reports freshness against an injected clock", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new GraphCache(store);
    await cache.save(makeGraph(), "2025-01-02T00:35:00.000Z");
    expect(await cache.isFreshWithin(10, NOW)).toBe(true);
    expect(await cache.isFreshWithin(2, NOW)).toBe(false);
  });
});

describe("loadGraph: cache first, network is an optimisation", () => {
  it("cold start: fetches once, persists, and reports it is not from cache", async () => {
    const store = new MemoryKeyValueStore();
    const graph = makeGraph();
    let calls = 0;

    const result = await loadGraph({
      store,
      fetcher: async () => {
        calls += 1;
        return graph;
      },
      isOnline: () => true,
      now: () => NOW,
    });

    expect(calls).toBe(1);
    expect(result.fromCache).toBe(false);
    expect(result.graph).toEqual(graph);
    expect(result.label).toBeNull();
    expect(result.refresh).toBeNull();

    // The graph is now on the device.
    expect(await new GraphCache(store).load()).not.toBeNull();
  });

  it("warm cache + offline: performs NO network call at all", async () => {
    const store = new MemoryKeyValueStore();
    const graph = makeGraph();
    await new GraphCache(store).save(graph, "2025-01-02T00:35:00.000Z");

    const stub = stubFetch(async () => {
      throw new Error("fetch must not be called while offline");
    });
    restoreFetch = stub.restore;

    // No `fetcher` is passed, so the module's real HTTP fetcher is what would run.
    const result = await loadGraph({ store, isOnline: () => false, now: () => NOW });

    expect(stub.calls).toEqual([]);
    expect(result.fromCache).toBe(true);
    expect(result.graph).toEqual(graph);
    expect(result.cachedAt).toBe("2025-01-02T00:35:00.000Z");
    expect(result.label).toBe("as of 08:35, 7 min ago");
    expect(result.staleness?.minutes).toBe(7);
    expect(result.refresh).toBeNull();
  });

  it("cold cache + offline: throws OFFLINE_NO_CACHE without touching the network", async () => {
    const store = new MemoryKeyValueStore();
    const stub = stubFetch(async () => {
      throw new Error("fetch must not be called while offline");
    });
    restoreFetch = stub.restore;

    await expect(loadGraph({ store, isOnline: () => false, now: () => NOW })).rejects.toThrow(
      OfflineNoCacheError,
    );
    await expect(loadGraph({ store, isOnline: () => false, now: () => NOW })).rejects.toMatchObject({
      code: "OFFLINE_NO_CACHE",
    });
    expect(stub.calls).toEqual([]);
  });

  it("warm cache + online: serves the cache immediately and refreshes behind it", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new GraphCache(store);
    await cache.save(makeGraph({ warnings: ["old"] }), "2025-01-02T00:35:00.000Z");

    const fresh = makeGraph({ warnings: ["fresh"], builtAt: "2025-01-02T00:41:00.000Z" });
    let calls = 0;

    const result = await loadGraph({
      store,
      fetcher: async () => {
        calls += 1;
        return fresh;
      },
      isOnline: () => true,
      now: () => NOW,
    });

    expect(result.fromCache).toBe(true);
    expect(result.graph.warnings).toEqual(["old"]);
    expect(result.label).toBe("as of 08:35, 7 min ago");
    expect(result.refresh).not.toBeNull();

    const outcome = await result.refresh;
    expect(outcome.status).toBe("refreshed");
    expect(calls).toBe(1);
    expect((await cache.load())?.graph.warnings).toEqual(["fresh"]);
  });

  it("a failed background refresh leaves the cached graph in place", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new GraphCache(store);
    await cache.save(makeGraph({ warnings: ["old"] }), "2025-01-02T00:35:00.000Z");

    const result = await loadGraph({
      store,
      fetcher: async () => {
        throw new GraphFetchError("/graph/transit-graph.json", 503, "upstream down");
      },
      isOnline: () => true,
      now: () => NOW,
    });

    const outcome = await result.refresh;
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("upstream down");
    expect((await cache.load())?.graph.warnings).toEqual(["old"]);
  });

  it("can be told not to refresh in the background", async () => {
    const store = new MemoryKeyValueStore();
    await new GraphCache(store).save(makeGraph(), "2025-01-02T00:35:00.000Z");
    let calls = 0;
    const result = await loadGraph({
      store,
      fetcher: async () => {
        calls += 1;
        return makeGraph();
      },
      isOnline: () => true,
      refreshInBackground: false,
      now: () => NOW,
    });
    expect(result.fromCache).toBe(true);
    expect(result.refresh).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("defaultGraphFetcher", () => {
  it("parses a valid graph payload", async () => {
    const graph = makeGraph();
    const stub = stubFetch(
      async () => new Response(JSON.stringify(graph), { status: 200 }),
    );
    restoreFetch = stub.restore;

    const loaded: TransitGraph = await defaultGraphFetcher();
    expect(loaded).toEqual(graph);
    expect(stub.calls).toEqual(["/graph/transit-graph.json"]);
  });

  it("fails loudly on a non-OK response", async () => {
    const stub = stubFetch(async () => new Response("nope", { status: 502 }));
    restoreFetch = stub.restore;
    await expect(defaultGraphFetcher()).rejects.toBeInstanceOf(GraphFetchError);
  });

  it("fails loudly on a payload that is not a TransitGraph", async () => {
    const stub = stubFetch(
      async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    restoreFetch = stub.restore;
    await expect(defaultGraphFetcher()).rejects.toBeInstanceOf(GraphFetchError);
  });
});
