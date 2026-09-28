/**
 * Connection Scan Algorithm.
 *
 * Classic CSA: scan the connection list once, in ascending departure order,
 * keeping the earliest arrival per station. Two additions this feed requires:
 *
 *  1. FOOTPATHS. Interchanges are separate stop_ids (`KJ13` / `AG7` / `SP7` are
 *     all Masjid Jamek), so a label may move between stations at a walking cost.
 *     Relaxing footpaths inside the same forward scan stays correct: an
 *     improvement produced at connection `i` is always later than the departure
 *     of every connection already scanned, so no already-passed connection
 *     becomes catchable.
 *
 *  2. RISK AS TIME. S4's `RiskPenalty` is folded into the traversal cost:
 *         effectiveArrival = departure + round(ride * multiplier) + penaltySeconds
 *     CSA then minimises effective arrival, which is an exact CSA over the
 *     transformed cost and biases the search away from degraded segments. With
 *     no risk supplied the transform is the identity, i.e. plain earliest
 *     arrival.
 *
 * Transfers: a change of `tripId` at the same station costs
 * `MIN_TRANSFER_BUFFER_SECONDS`; a change of station costs the footpath walk
 * time (which already includes the paid-area overhead). Continuing on the same
 * concrete departure is free and uses the scheduled arrival, not the
 * risk-inflated one.
 */

import type { Connection, SegmentId, StationId } from "@/lib/contracts";
import type { RoutingContext } from "./context";
import type { RiskPricing } from "./risk-pricing";

export const MIN_TRANSFER_BUFFER_SECONDS = 60;
export const EPSILON = 1e-6;

export interface CsaHopConnection {
  kind: "CONNECTION";
  connection: Connection;
}

export interface CsaHopFootpath {
  kind: "FOOTPATH";
  fromStationId: StationId;
  toStationId: StationId;
  walkSeconds: number;
}

export type CsaHop = CsaHopConnection | CsaHopFootpath;

export interface CsaRunOptions {
  context: RoutingContext;
  originIndex: number;
  destinationIndex: number;
  departAfterSeconds: number;
  maxInitialWaitSeconds: number;
  maxTransfers: number;
  bannedSegments: ReadonlySet<SegmentId>;
  /** false = pure schedule times ("fastest"); true = risk-adjusted arrival. */
  applyRisk: boolean;
  pricing: RiskPricing;
}

export interface CsaResult {
  hops: CsaHop[];
  /** Risk-adjusted arrival used as the optimisation objective. */
  effectiveArrivalSeconds: number;
  /** Real scheduled arrival at the destination. */
  scheduledArrivalSeconds: number;
  transferCount: number;
  boardings: number;
}

const NO_BANS: ReadonlySet<SegmentId> = new Set<SegmentId>();

export function emptyBanSet(): ReadonlySet<SegmentId> {
  return NO_BANS;
}

export function runCsa(options: CsaRunOptions): CsaResult | null {
  const { context, originIndex, destinationIndex } = options;
  if (originIndex === destinationIndex) return null;

  const stationCount = context.stations.length;
  const best = new Float64Array(stationCount).fill(Number.POSITIVE_INFINITY);
  const actual = new Float64Array(stationCount).fill(Number.POSITIVE_INFINITY);
  const predConnection = new Int32Array(stationCount).fill(-1);
  const predStation = new Int32Array(stationCount).fill(-1);
  const predKind = new Int8Array(stationCount); // 0 = origin, 1 = connection, 2 = footpath
  const transfers = new Int32Array(stationCount);
  const boardings = new Int32Array(stationCount);
  const tripOf: Array<string | null> = new Array<string | null>(stationCount).fill(null);

  best[originIndex] = options.departAfterSeconds;
  actual[originIndex] = options.departAfterSeconds;

  const relaxFootpaths = (station: number): void => {
    const links = context.footpaths[station];
    if (links.length === 0) return;
    const base = best[station];
    if (!Number.isFinite(base)) return;
    for (const link of links) {
      const candidate = base + link.walkSeconds;
      if (candidate >= best[link.to] - EPSILON) continue;
      best[link.to] = candidate;
      actual[link.to] = actual[station] + link.walkSeconds;
      predKind[link.to] = 2;
      predConnection[link.to] = -1;
      predStation[link.to] = station;
      transfers[link.to] = transfers[station];
      boardings[link.to] = boardings[station];
      tripOf[link.to] = tripOf[station];
      relaxFootpaths(link.to);
    }
  };

  relaxFootpaths(originIndex);

  const connections = context.connections;
  const { stationIndex } = context;
  const { bannedSegments, departAfterSeconds, maxInitialWaitSeconds, maxTransfers } = options;

  for (let ci = 0; ci < connections.length; ci += 1) {
    const c = connections[ci];
    if (bannedSegments.has(c.segmentId)) continue;

    const from = stationIndex.get(c.fromStationId);
    if (from === undefined) continue;
    const to = stationIndex.get(c.toStationId);
    if (to === undefined) continue;

    const bestFrom = best[from];
    if (!Number.isFinite(bestFrom)) continue;

    const onboard = boardings[from] > 0 && tripOf[from] === c.tripId;
    let ready: number;
    let carryIn = 0;
    if (onboard) {
      // The rider is already on this vehicle, so the boarding test uses the
      // scheduled arrival — a delay priced on the PREVIOUS segment must not
      // throw them off the train. The accrued delay is carried forward instead,
      // which is what keeps `best` strictly increasing along a predecessor
      // chain (and therefore keeps that chain acyclic).
      ready = actual[from];
      carryIn = Math.max(0, bestFrom - actual[from]);
    } else if (boardings[from] > 0) {
      ready = bestFrom + MIN_TRANSFER_BUFFER_SECONDS;
    } else {
      ready = bestFrom;
    }

    if (c.departureTime < ready) continue;
    if (
      boardings[from] === 0 &&
      c.departureTime - departAfterSeconds > maxInitialWaitSeconds
    ) {
      continue;
    }

    let newTransfers = transfers[from];
    if (!onboard && boardings[from] > 0) newTransfers += 1;
    if (newTransfers > maxTransfers) continue;

    // Strictly greater than best[from]: departureTime >= ready >= best[from] for
    // a fresh boarding, and departureTime + carryIn >= best[from] while onboard.
    // The ride itself is always at least 1 second, so `best` strictly increases
    // along every predecessor edge.
    const rideSeconds = Math.max(1, c.arrivalTime - c.departureTime);
    let effectiveArrival = c.departureTime + carryIn + rideSeconds;
    if (options.applyRisk) {
      const penalty = options.pricing.penaltyFor(c.segmentId, c.departureTime);
      if (penalty) {
        effectiveArrival =
          c.departureTime +
          carryIn +
          Math.round(rideSeconds * Math.max(1, penalty.multiplier)) +
          Math.max(0, penalty.penaltySeconds);
      }
    }

    if (effectiveArrival >= best[to] - EPSILON) continue;

    best[to] = effectiveArrival;
    actual[to] = c.arrivalTime;
    predKind[to] = 1;
    predConnection[to] = ci;
    predStation[to] = from;
    transfers[to] = newTransfers;
    boardings[to] = boardings[from] + 1;
    tripOf[to] = c.tripId;
    relaxFootpaths(to);
  }

  if (!Number.isFinite(best[destinationIndex])) return null;

  const hops: CsaHop[] = [];
  let node = destinationIndex;
  // Belt-and-braces: the predecessor chain provably walks strictly increasing
  // `best` values, so it cannot cycle. The bound turns any future regression
  // into a null result instead of an unbounded allocation.
  while (node !== originIndex) {
    if (hops.length > connections.length + 1) return null;
    const kind = predKind[node];
    if (kind === 1) {
      hops.push({ kind: "CONNECTION", connection: connections[predConnection[node]] });
      node = predStation[node];
    } else if (kind === 2) {
      const from = predStation[node];
      hops.push({
        kind: "FOOTPATH",
        fromStationId: context.stations[from].id,
        toStationId: context.stations[node].id,
        walkSeconds: Math.round(actual[node] - actual[from]),
      });
      node = from;
    } else {
      return null;
    }
  }
  hops.reverse();

  return {
    hops,
    effectiveArrivalSeconds: best[destinationIndex],
    scheduledArrivalSeconds: actual[destinationIndex],
    transferCount: transfers[destinationIndex],
    boardings: boardings[destinationIndex],
  };
}
