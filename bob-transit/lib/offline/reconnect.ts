/**
 * Reconnect orchestration.
 *
 * This is the one place in the offline module that may touch the network, and it
 * only runs when the device reports connectivity. It reads the cached state,
 * pulls the server's current state, reconciles the two, persists the new state
 * and hands back an honest view (including the "as of HH:MM, N min ago" label).
 *
 * The HTTP fetcher is injectable, so the whole flow is testable with zero network.
 */

import type { ApiResponse, SignalsResponse } from "@/lib/contracts/api";
import type { DisruptionSignal } from "@/lib/contracts/signal";
import type { RiskOverlay } from "@/lib/contracts/risk";
import type { KeyValueStore } from "./store";
import {
  SignalStateCache,
  buildSignalState,
  describeSignalState,
  type CachedSignalState,
  type SignalStateView,
} from "./signal-cache";
import { reconcile, type ReconcileResult } from "./reconcile";
import type { StalenessLocale } from "./staleness";

/** Epoch cursor: a device that has never synced asks for everything. */
export const EPOCH_CURSOR = "1970-01-01T00:00:00.000Z";

export interface ServerSignalState {
  /** The server's complete current signal set. */
  signals: DisruptionSignal[];
  /** The server's freshly computed risk overlay. */
  overlay: RiskOverlay;
  /** Server-reported freshness of the payload (`ApiMeta.asOf`). */
  asOf: string;
  /** Server time of this response (`ApiMeta.generatedAt`); the next cursor. */
  serverTime: string;
}

export type ServerStateFetcher = (
  since: string,
  options?: { signal?: AbortSignal },
) => Promise<ServerSignalState>;

export interface ReconnectOptions {
  store: KeyValueStore;
  fetchServerState: ServerStateFetcher;
  /** Injected clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Defaults to `navigator.onLine` (true when unknown). */
  isOnline?: () => boolean;
  locale?: StalenessLocale;
  staleAfterMinutes?: number;
  cacheKey?: string;
}

export interface ReconnectOutcome {
  /** True when no network call was made. */
  skipped: boolean;
  /** Human-readable explanation of what happened. */
  reason: string;
  /** Honest view of the state now on the device, when there is one. */
  view: SignalStateView | null;
  /** Classification of every difference, when a reconcile ran. */
  result: ReconcileResult | null;
  /** The state persisted on the device. */
  state: CachedSignalState | null;
}

function defaultIsOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/**
 * Reconcile cached state against the server on reconnect.
 *
 * Offline (or with no fetcher) this performs NO network call: it returns the
 * cached view with `skipped: true` and the reason string the UI should show.
 */
export async function reconcileOnReconnect(options: ReconnectOptions): Promise<ReconnectOutcome> {
  const now = options.now ?? (() => new Date());
  const locale = options.locale ?? "en";
  const cache = new SignalStateCache(options.store, { cacheKey: options.cacheKey });
  const cached = await cache.load();
  const online = (options.isOnline ?? defaultIsOnline)();

  if (!online) {
    const view = cached
      ? describeSignalState(cached, {
          now: now(),
          offline: true,
          locale,
          staleAfterMinutes: options.staleAfterMinutes,
        })
      : null;
    return {
      skipped: true,
      reason: cached
        ? `Offline: reusing cached disruption state (${view?.label ?? "unknown age"}).`
        : "Offline: no cached disruption state on this device yet.",
      view,
      result: null,
      state: cached,
    };
  }

  const since = cached?.lastSyncAt ?? EPOCH_CURSOR;
  const server = await options.fetchServerState(since);
  const result = reconcile({
    since,
    cachedSignals: cached?.signals ?? [],
    serverSignals: server.signals,
    overlay: server.overlay,
    serverTime: server.serverTime,
    locale,
  });

  const state = await cache.save(
    buildSignalState({
      signals: result.nextSignals,
      overlay: server.overlay,
      asOf: server.asOf,
      serverTime: server.serverTime,
      cachedAt: now().toISOString(),
      cacheKey: options.cacheKey,
    }),
  );

  return {
    skipped: false,
    reason: result.summary,
    view: describeSignalState(state, {
      now: now(),
      offline: false,
      locale,
      staleAfterMinutes: options.staleAfterMinutes,
    }),
    result,
    state,
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP adapter (the only network path in this module)                         */
/* -------------------------------------------------------------------------- */

export interface HttpServerStateFetcherOptions {
  /** Route returning `ApiResponse<SignalsResponse>`. */
  signalsUrl?: string;
  /** Route returning `ApiResponse<RiskOverlayResponse>`. */
  overlayUrl?: string;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

function isApiOk<T>(value: unknown): value is { ok: true; data: T; meta: { asOf: string; generatedAt: string } } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ok?: unknown; data?: unknown; meta?: unknown };
  return candidate.ok === true && candidate.data !== undefined && typeof candidate.meta === "object";
}

/**
 * Reads the server's signal set and overlay from the frozen API envelope.
 *
 * NOTE FOR THE ORCHESTRATOR: this expects two GET routes — `/api/signals` and
 * `/api/risk/overlay` — each returning `ApiResponse<...>` per `lib/contracts/api.ts`.
 * Route files live under `app/`, which S5 owns.
 */
export function createHttpServerStateFetcher(
  options: HttpServerStateFetcherOptions = {},
): ServerStateFetcher {
  const signalsUrl = options.signalsUrl ?? "/api/signals";
  const overlayUrl = options.overlayUrl ?? "/api/risk/overlay";

  return async (since, init) => {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available in this environment");
    }
    const [signalsResponse, overlayResponse] = await Promise.all([
      fetchImpl(`${signalsUrl}?since=${encodeURIComponent(since)}`, {
        signal: init?.signal,
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
      fetchImpl(overlayUrl, {
        signal: init?.signal,
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }),
    ]);

    if (!signalsResponse.ok) {
      throw new Error(`signals request returned ${signalsResponse.status}`);
    }
    if (!overlayResponse.ok) {
      throw new Error(`overlay request returned ${overlayResponse.status}`);
    }

    const signalsBody: unknown = await signalsResponse.json();
    const overlayBody: unknown = await overlayResponse.json();
    if (!isApiOk<SignalsResponse>(signalsBody)) {
      throw new Error("signals response is not an ApiOk<SignalsResponse>");
    }
    if (!isApiOk<{ overlay: RiskOverlay }>(overlayBody)) {
      throw new Error("overlay response is not an ApiOk<RiskOverlayResponse>");
    }

    return {
      signals: signalsBody.data.signals,
      overlay: overlayBody.data.overlay,
      asOf: signalsBody.meta.asOf,
      serverTime: signalsBody.meta.generatedAt,
    };
  };
}

export type { ApiResponse };
