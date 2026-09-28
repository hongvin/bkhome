/**
 * Offline / PWA / persistence module (S6).
 *
 * The core network runs underground in tunnels with no signal, so the offline
 * path is a first-class requirement, not a fallback:
 *
 *   - `GraphCache` / `loadGraph`  — the whole transit graph in IndexedDB, cache-first
 *   - `SignalStateCache`          — last-known disruption state with honest staleness
 *   - `StalenessFormatter`        — exactly "as of HH:MM, N min ago" (+ BM variant)
 *   - `degradeOverlayForOfflineCache` — `stale` / `degradedByOfflineCache` + reason
 *   - `reconcile` / `reconcileOnReconnect` — new / cleared / changed on reconnect
 *   - `ServiceWorkerRegistrar`    — mount once in `app/layout.tsx` (S5)
 */

export * from "./store";
export * from "./staleness";
export * from "./graph-cache";
export * from "./signal-cache";
export * from "./degrade";
export * from "./reconcile";
export * from "./reconnect";
export { ServiceWorkerRegistrar, SERVICE_WORKER_PATH } from "./register-sw";
export type { ServiceWorkerRegistrarProps } from "./register-sw";
