/**
 * Last-known disruption state, persisted on the device.
 *
 * The signal set and the risk overlay are written to IndexedDB on every
 * successful sync, together with the server's `asOf` and a reconcile cursor.
 * Reading it back always yields an honest staleness value, so the UI can render
 * "as of HH:MM, N min ago" instead of pretending a tunnel is a live connection.
 */

import { CONTRACTS_VERSION } from "@/lib/contracts";
import type { DisruptionSignal } from "@/lib/contracts/signal";
import type { RiskOverlay } from "@/lib/contracts/risk";
import type { KeyValueStore } from "./store";
import {
  StalenessFormatter,
  type Staleness,
  type StalenessLocale,
} from "./staleness";
import { offlineReason } from "./degrade";

export const SIGNAL_STATE_CACHE_KEY = "signal-state:v1";

export interface CachedSignalState {
  cacheKey: string;
  contractsVersion: string;
  /** When this device wrote the record. */
  cachedAt: string;
  /** The instant the server said the payload was true as of. */
  asOf: string;
  /** Cursor for the next reconnect: the server time of the last successful sync. */
  lastSyncAt: string;
  signals: DisruptionSignal[];
  overlay: RiskOverlay | null;
}

export interface BuildSignalStateInput {
  signals: readonly DisruptionSignal[];
  overlay?: RiskOverlay | null;
  /** Server-reported freshness of the payload. */
  asOf: string;
  /** Server time of this sync; becomes the next reconcile cursor. */
  serverTime: string;
  /** Device time when the record was written. */
  cachedAt: string;
  cacheKey?: string;
}

export function buildSignalState(input: BuildSignalStateInput): CachedSignalState {
  return {
    cacheKey: input.cacheKey ?? SIGNAL_STATE_CACHE_KEY,
    contractsVersion: CONTRACTS_VERSION,
    cachedAt: input.cachedAt,
    asOf: input.asOf,
    lastSyncAt: input.serverTime,
    signals: [...input.signals],
    overlay: input.overlay ?? null,
  };
}

function isCachedSignalState(value: unknown): value is CachedSignalState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CachedSignalState>;
  return (
    typeof candidate.asOf === "string" &&
    typeof candidate.cachedAt === "string" &&
    typeof candidate.lastSyncAt === "string" &&
    typeof candidate.contractsVersion === "string" &&
    Array.isArray(candidate.signals)
  );
}

export class SignalStateCache {
  private readonly store: KeyValueStore;
  private readonly cacheKey: string;

  constructor(store: KeyValueStore, options: { cacheKey?: string } = {}) {
    this.store = store;
    this.cacheKey = options.cacheKey ?? SIGNAL_STATE_CACHE_KEY;
  }

  async loadRaw(): Promise<CachedSignalState | null> {
    const value = await this.store.get<unknown>(this.cacheKey);
    return isCachedSignalState(value) ? value : null;
  }

  /** Compatibility-checked read: a contracts mismatch is treated as no cache. */
  async load(): Promise<CachedSignalState | null> {
    const state = await this.loadRaw();
    if (!state) return null;
    return state.contractsVersion === CONTRACTS_VERSION ? state : null;
  }

  async save(state: CachedSignalState): Promise<CachedSignalState> {
    await this.store.set(this.cacheKey, state);
    return state;
  }

  /** The cursor to send on reconnect: the server time of the last good sync. */
  async cursor(): Promise<string | null> {
    const state = await this.load();
    return state ? state.lastSyncAt : null;
  }

  async clear(): Promise<void> {
    await this.store.delete(this.cacheKey);
  }
}

export interface DescribeSignalStateOptions {
  /** Injected clock — required, so the label is deterministic. */
  now: Date;
  /** True when the device currently has no connectivity. */
  offline: boolean;
  locale?: StalenessLocale;
  staleAfterMinutes?: number;
}

export interface SignalStateView {
  state: CachedSignalState;
  staleness: Staleness;
  /** `"as of HH:MM, N min ago"`. */
  label: string;
  isStale: boolean;
  offline: boolean;
  /** Full sentence for the UI banner. */
  reason: string;
  /** True when confidence values in this view must be shown as reduced. */
  confidenceDegraded: boolean;
}

/**
 * Turn a cached state into everything the UI needs to be honest about it.
 * `isStale` is true when the data is old, when the device is offline, or both.
 */
export function describeSignalState(
  state: CachedSignalState,
  options: DescribeSignalStateOptions,
): SignalStateView {
  const locale = options.locale ?? "en";
  const formatter = new StalenessFormatter({
    locale,
    staleAfterMinutes: options.staleAfterMinutes,
  });
  const staleness = formatter.describe(state.asOf, options.now);
  const label = formatter.format(state.asOf, options.now);
  const reason = options.offline
    ? offlineReason(state.asOf, options.now, {
        locale,
        staleAfterMinutes: options.staleAfterMinutes,
      })
    : locale === "ms"
      ? `Data disimpan (${label}).`
      : `Cached data (${label}).`;
  return {
    state,
    staleness,
    label,
    isStale: staleness.isStale || options.offline,
    offline: options.offline,
    reason,
    confidenceDegraded: options.offline,
  };
}

/**
 * Convenience: read the persisted state and describe it in one call. Returns
 * null when the device has never synced.
 */
export async function loadSignalStateView(
  store: KeyValueStore,
  options: DescribeSignalStateOptions & { cacheKey?: string },
): Promise<SignalStateView | null> {
  const cache = new SignalStateCache(store, { cacheKey: options.cacheKey });
  const state = await cache.load();
  if (!state) return null;
  return describeSignalState(state, options);
}
