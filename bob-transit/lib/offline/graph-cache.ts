/**
 * The offline transit-graph cache.
 *
 * First successful load serialises the whole `TransitGraph` into IndexedDB with a
 * `builtAt` + `cachedAt` stamp. After that the graph is served from the device:
 * routing keeps working with the phone in airplane mode. When the network is
 * available the cache is refreshed in the background and swapped in on the next
 * load — never blocking the first paint.
 */

import { CONTRACTS_VERSION, type TransitGraph } from "@/lib/contracts";
import type { KeyValueStore } from "./store";
import { computeStaleness, StalenessFormatter, type Staleness } from "./staleness";

export const GRAPH_CACHE_KEY = "transit-graph:v1";
/** Where S1's `make graph` writes the serialised graph (see Makefile). */
export const DEFAULT_GRAPH_URL = "/graph/transit-graph.json";

export interface CachedGraph {
  cacheKey: string;
  contractsVersion: string;
  /** ISO timestamp from the graph builder. */
  builtAt: string;
  /** ISO timestamp of when this device stored it. */
  cachedAt: string;
  /** Serialised size in bytes, so the UI can report cache footprint honestly. */
  byteSize: number;
  graph: TransitGraph;
}

export interface GraphCacheInspection {
  present: boolean;
  /** True when the cached graph matches the running contracts version. */
  compatible: boolean;
  contractsVersion: string | null;
  cachedAt: string | null;
  builtAt: string | null;
  byteSize: number | null;
  /** Why the cache cannot be used, when it cannot. */
  reason: string | null;
}

function isCachedGraph(value: unknown): value is CachedGraph {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedGraph>;
  if (typeof candidate.contractsVersion !== "string") return false;
  if (typeof candidate.cachedAt !== "string") return false;
  if (typeof candidate.builtAt !== "string") return false;
  const graph = candidate.graph as TransitGraph | undefined;
  return (
    !!graph &&
    typeof graph === "object" &&
    Array.isArray(graph.stations) &&
    Array.isArray(graph.segments) &&
    Array.isArray(graph.connections)
  );
}

export class GraphCache {
  private readonly store: KeyValueStore;
  private readonly cacheKey: string;

  constructor(store: KeyValueStore, options: { cacheKey?: string } = {}) {
    this.store = store;
    this.cacheKey = options.cacheKey ?? GRAPH_CACHE_KEY;
  }

  /** Read the cached graph without checking contract compatibility. */
  async loadRaw(): Promise<CachedGraph | null> {
    const value = await this.store.get<unknown>(this.cacheKey);
    return isCachedGraph(value) ? value : null;
  }

  /**
   * Read the cached graph, but only when it was written by the same contracts
   * version. A schema mismatch must never be routed on.
   */
  async load(): Promise<CachedGraph | null> {
    const cached = await this.loadRaw();
    if (!cached) return null;
    return cached.contractsVersion === CONTRACTS_VERSION ? cached : null;
  }

  async inspect(): Promise<GraphCacheInspection> {
    const cached = await this.loadRaw();
    if (!cached) {
      return {
        present: false,
        compatible: false,
        contractsVersion: null,
        cachedAt: null,
        builtAt: null,
        byteSize: null,
        reason: "no cached graph on this device",
      };
    }
    const compatible = cached.contractsVersion === CONTRACTS_VERSION;
    return {
      present: true,
      compatible,
      contractsVersion: cached.contractsVersion,
      cachedAt: cached.cachedAt,
      builtAt: cached.builtAt,
      byteSize: cached.byteSize,
      reason: compatible
        ? null
        : `cached graph was built for contracts ${cached.contractsVersion}, running ${CONTRACTS_VERSION}`,
    };
  }

  async save(graph: TransitGraph, cachedAt: string): Promise<CachedGraph> {
    const envelope: CachedGraph = {
      cacheKey: this.cacheKey,
      contractsVersion: graph.contractsVersion ?? CONTRACTS_VERSION,
      builtAt: graph.builtAt,
      cachedAt,
      byteSize: JSON.stringify(graph).length,
      graph,
    };
    await this.store.set(this.cacheKey, envelope);
    return envelope;
  }

  async clear(): Promise<void> {
    await this.store.delete(this.cacheKey);
  }

  /** True when a compatible graph was cached within `minutes` of `now`. */
  async isFreshWithin(minutes: number, now: Date): Promise<boolean> {
    const cached = await this.load();
    if (!cached) return false;
    return computeStaleness(cached.cachedAt, now).minutes <= minutes;
  }
}

/* -------------------------------------------------------------------------- */
/* Load orchestration: cache first, refresh in the background                  */
/* -------------------------------------------------------------------------- */

export type GraphFetcher = (options?: { signal?: AbortSignal }) => Promise<TransitGraph>;

export class GraphFetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  constructor(url: string, status: number | null, message: string) {
    super(message);
    this.name = "GraphFetchError";
    this.url = url;
    this.status = status;
  }
}

export class OfflineNoCacheError extends Error {
  /** Matches `ApiErr.error.code` in the frozen API contract. */
  readonly code = "OFFLINE_NO_CACHE" as const;
  readonly messageKey = "error.offline_no_cache";
  constructor(message = "Device is offline and no cached transit graph is available.") {
    super(message);
    this.name = "OfflineNoCacheError";
  }
}

/** Fetch the graph over HTTP. This is the ONLY network call in this module. */
export function createHttpGraphFetcher(url: string = DEFAULT_GRAPH_URL): GraphFetcher {
  return async (options) => {
    if (typeof fetch !== "function") {
      throw new GraphFetchError(url, null, "fetch is not available in this environment");
    }
    let response: Response;
    try {
      response = await fetch(url, { signal: options?.signal, credentials: "same-origin" });
    } catch (error) {
      throw new GraphFetchError(
        url,
        null,
        `graph request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new GraphFetchError(url, response.status, `graph request returned ${response.status}`);
    }
    const graph = (await response.json()) as TransitGraph;
    if (!graph || !Array.isArray(graph.stations) || !Array.isArray(graph.connections)) {
      throw new GraphFetchError(url, response.status, "graph payload is not a TransitGraph");
    }
    return graph;
  };
}

export const defaultGraphFetcher: GraphFetcher = createHttpGraphFetcher();

function defaultIsOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

export interface GraphRefreshOutcome {
  status: "refreshed" | "failed";
  cachedAt: string | null;
  error: string | null;
}

export interface LoadGraphRequest {
  store: KeyValueStore;
  /** Defaults to an HTTP fetch of `DEFAULT_GRAPH_URL`. */
  fetcher?: GraphFetcher;
  /** Defaults to `navigator.onLine` (true when unknown). */
  isOnline?: () => boolean;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  cacheKey?: string;
  /**
   * When a usable cache exists and the device is online, refresh it in the
   * background and return the cache immediately. Default true.
   */
  refreshInBackground?: boolean;
  staleAfterMinutes?: number;
  locale?: "en" | "ms";
}

export interface LoadGraphResult {
  graph: TransitGraph;
  /** True when the returned graph came from IndexedDB. */
  fromCache: boolean;
  /** When the cached copy was written; null when the graph was just fetched. */
  cachedAt: string | null;
  /** The instant the returned graph is true as of. */
  asOf: string;
  staleness: Staleness | null;
  /** `"as of HH:MM, N min ago"`, or null when the graph is live. */
  label: string | null;
  /**
   * Background refresh, already running. Never rejects: a failed refresh leaves
   * the cached graph in place and resolves to `{ status: "failed" }`.
   */
  refresh: Promise<GraphRefreshOutcome> | null;
}

/**
 * Serve the transit graph with the network treated as an optimisation, never a
 * requirement:
 *
 *  1. warm cache  -> return it immediately (no network call at all when offline)
 *  2. cold cache  -> fetch, persist, return
 *  3. offline + no cache -> throw `OfflineNoCacheError` (API code OFFLINE_NO_CACHE)
 */
export async function loadGraph(request: LoadGraphRequest): Promise<LoadGraphResult> {
  const cache = new GraphCache(request.store, { cacheKey: request.cacheKey });
  const online = (request.isOnline ?? defaultIsOnline)();
  const now = request.now ?? (() => new Date());
  const formatter = new StalenessFormatter({
    locale: request.locale ?? "en",
    staleAfterMinutes: request.staleAfterMinutes,
  });
  const cached = await cache.load();

  if (cached) {
    const staleness = formatter.describe(cached.cachedAt, now());
    let refresh: Promise<GraphRefreshOutcome> | null = null;
    if (online && request.refreshInBackground !== false) {
      refresh = refreshInBackground(cache, request.fetcher ?? defaultGraphFetcher, now);
    }
    return {
      graph: cached.graph,
      fromCache: true,
      cachedAt: cached.cachedAt,
      asOf: cached.cachedAt,
      staleness,
      label: formatter.format(cached.cachedAt, now()),
      refresh,
    };
  }

  if (!online) {
    throw new OfflineNoCacheError();
  }

  const fetcher = request.fetcher ?? defaultGraphFetcher;
  const graph = await fetcher();
  const cachedAt = now().toISOString();
  await cache.save(graph, cachedAt);
  return {
    graph,
    fromCache: false,
    cachedAt: null,
    asOf: cachedAt,
    staleness: null,
    label: null,
    refresh: null,
  };
}

/**
 * Refresh and persist without ever rejecting — a background task that throws an
 * unhandled rejection is worse than a stale cache.
 */
export function refreshInBackground(
  cache: GraphCache,
  fetcher: GraphFetcher,
  now: () => Date,
): Promise<GraphRefreshOutcome> {
  return fetcher()
    .then(async (graph) => {
      const envelope = await cache.save(graph, now().toISOString());
      return { status: "refreshed" as const, cachedAt: envelope.cachedAt, error: null };
    })
    .catch((error: unknown) => ({
      status: "failed" as const,
      cachedAt: null,
      error: error instanceof Error ? error.message : String(error),
    }));
}
