/**
 * lib/signals — the reliability signal layer.
 *
 * Owns: the offline network index (stations/lines/segments), station & line
 * entity resolution, dedupe/repost collapsing, incident clustering, the
 * calibration table, signal lifecycle and the in-memory signal store.
 *
 * It deliberately does NOT import lib/gtfs/** or lib/routing/** (owned by S1):
 * the GTFS slice it needs is re-implemented under ./network.
 */

import { buildAliasIndex, type AliasIndex } from "./entity-resolver";
import { type NetworkIndex } from "./network/build";
import { loadBundledNetworkIndex } from "./network/source";

export * from "./types";
export * from "./hash";
export * from "./calibration";
export * from "./dedupe";
export * from "./lifecycle";
export * from "./store";
export * from "./entity-resolver";
export * from "./malay-text";
export * from "./tool";
export { loadBundledNetworkIndex, loadNetworkIndexFromGtfs, parseSnapshot } from "./network/source";
export type { NetworkIndex, NetworkLine, NetworkSegment, NetworkStation, PhysicalPlace } from "./network/build";
export { buildNetworkIndex, buildPlaces, CURATED_PLACE_LINKS } from "./network/build";
export {
  CANONICAL_LINE_IDS,
  isCanonicalLineId,
  toCanonicalLineId,
} from "./network/parse";

let cachedIndex: NetworkIndex | null = null;
let cachedAliasIndex: AliasIndex | null = null;

/** The committed offline network snapshot. Loaded once per process. */
export function networkIndex(): NetworkIndex {
  if (!cachedIndex) cachedIndex = loadBundledNetworkIndex();
  return cachedIndex;
}

/** Alias index over that snapshot, including physical-place collapsing. */
export function aliasIndex(): AliasIndex {
  if (!cachedAliasIndex) cachedAliasIndex = buildAliasIndex(networkIndex());
  return cachedAliasIndex;
}
