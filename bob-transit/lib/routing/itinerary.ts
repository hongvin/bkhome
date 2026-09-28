/**
 * Turn a CSA hop sequence into a frozen `Itinerary`.
 *
 * Leg model:
 *   WAIT      rider is at a station, a train is not there yet (platform wait)
 *   RIDE      one continuous run on one concrete departure
 *   TRANSFER  walking between two stop_ids of the same interchange
 *
 * The initial wait at the origin is emitted as a WAIT leg so the legs add up to
 * `totalDurationSeconds` and the UI can render "next train in N min".
 */

import type {
  Itinerary,
  ItineraryLeg,
  Line,
  LineId,
  RouteQuery,
  SegmentId,
  SegmentRisk,
  SegmentRiskLookup,
  StationId,
} from "@/lib/contracts";
import { MATERIAL_RISK_CONFIDENCE_THRESHOLD } from "@/lib/contracts";
import type { CsaResult } from "./csa";
import type { RoutingContext } from "./context";
import type { RiskPricing } from "./risk-pricing";
import {
  badgeForScore,
  computeArrivalWindow,
  computeReliabilityScore,
} from "./reliability";

export type ItineraryCore = Omit<Itinerary, "rank" | "whyThisRank">;

export interface ItineraryDraft {
  /** Ride-leg path identity, used for de-duplication. */
  signature: string;
  itinerary: ItineraryCore;
  lineIds: LineId[];
  lineLabels: string[];
  segmentIds: SegmentId[];
  riskySegmentIds: SegmentId[];
  riskExposure: number;
}

/** FNV-1a, 32-bit. Deterministic ids with no randomness and no wall clock. */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Compact, human-readable line label: "LRT Kelana Jaya Line" -> "Kelana Jaya Line". */
export function lineLabel(line: Line | undefined, lineId: LineId): string {
  if (!line) return lineId;
  const long = line.longName.replace(/^(LRT|MRT|KL|BRT|KTM)\s+/i, "").trim();
  return long === "" ? lineId : long;
}

interface MutableRideLeg {
  leg: ItineraryLeg;
  tripId: string;
}

export interface BuildItineraryInput {
  result: CsaResult;
  context: RoutingContext;
  query: RouteQuery;
  pricing: RiskPricing;
  riskLookup?: SegmentRiskLookup;
}

export function buildItineraryDraft(input: BuildItineraryInput): ItineraryDraft {
  const { result, context, query, pricing, riskLookup } = input;
  const legs: ItineraryLeg[] = [];
  const lineById = new Map(context.graph.lines.map((l) => [l.id, l] as const));

  let cursorStationId: StationId = query.originStationId;
  let cursorTime = query.departAfterSeconds;
  let openRide: MutableRideLeg | null = null;

  const closeRide = (): void => {
    if (!openRide) return;
    openRide.leg.scheduledSeconds = openRide.leg.arrivalTime - openRide.leg.departureTime;
    legs.push(openRide.leg);
    openRide = null;
  };

  for (const hop of result.hops) {
    if (hop.kind === "FOOTPATH") {
      closeRide();
      const departure = cursorTime;
      const arrival = departure + hop.walkSeconds;
      legs.push({
        kind: "TRANSFER",
        lineId: null,
        fromStationId: hop.fromStationId,
        toStationId: hop.toStationId,
        departureTime: departure,
        arrivalTime: arrival,
        segmentIds: [],
        scheduledSeconds: arrival - departure,
        penalties: [],
        addedDelaySeconds: 0,
      });
      cursorTime = arrival;
      cursorStationId = hop.toStationId;
      continue;
    }

    const connection = hop.connection;

    if (openRide && openRide.tripId === connection.tripId) {
      const leg = openRide.leg;
      leg.toStationId = connection.toStationId;
      leg.arrivalTime = connection.arrivalTime;
      leg.segmentIds.push(connection.segmentId);
      const penalty = pricing.penaltyFor(connection.segmentId, connection.departureTime);
      if (penalty) {
        leg.penalties.push(penalty);
        leg.addedDelaySeconds += Math.max(0, penalty.penaltySeconds);
      }
      cursorStationId = connection.toStationId;
      cursorTime = connection.arrivalTime;
      continue;
    }

    closeRide();

    // CSA only boards where the label already sits; this guards the invariant.
    if (connection.fromStationId !== cursorStationId) {
      throw new Error(
        `CSA produced a disconnected path: at ${cursorStationId} but boarding at ${connection.fromStationId}`,
      );
    }

    if (connection.departureTime > cursorTime) {
      legs.push({
        kind: "WAIT",
        lineId: null,
        fromStationId: cursorStationId,
        toStationId: cursorStationId,
        departureTime: cursorTime,
        arrivalTime: connection.departureTime,
        segmentIds: [],
        scheduledSeconds: connection.departureTime - cursorTime,
        penalties: [],
        addedDelaySeconds: 0,
      });
      cursorTime = connection.departureTime;
    }

    const penalty = pricing.penaltyFor(connection.segmentId, connection.departureTime);
    const rideLeg: ItineraryLeg = {
      kind: "RIDE",
      lineId: connection.lineId,
      fromStationId: connection.fromStationId,
      toStationId: connection.toStationId,
      departureTime: connection.departureTime,
      arrivalTime: connection.arrivalTime,
      segmentIds: [connection.segmentId],
      scheduledSeconds: connection.arrivalTime - connection.departureTime,
      penalties: penalty ? [penalty] : [],
      addedDelaySeconds: penalty ? Math.max(0, penalty.penaltySeconds) : 0,
    };
    openRide = { leg: rideLeg, tripId: connection.tripId };
    cursorStationId = connection.toStationId;
    cursorTime = connection.arrivalTime;
  }
  closeRide();

  /* ------------------------- derived itinerary facts ------------------------ */

  const rideLegs = legs.filter((l) => l.kind === "RIDE");
  const segmentIds: SegmentId[] = [];
  const riskySegmentIds: SegmentId[] = [];
  const lineIds: LineId[] = [];
  const seenSegments = new Set<SegmentId>();
  let maxDegradationProbability = 0;
  let riskExposure = 0;
  let expectedDelaySeconds = 0;

  for (const leg of legs) {
    expectedDelaySeconds += leg.addedDelaySeconds;
    if (leg.lineId && !lineIds.includes(leg.lineId)) lineIds.push(leg.lineId);
  }

  for (const leg of rideLegs) {
    for (const segmentId of leg.segmentIds) {
      if (!seenSegments.has(segmentId)) {
        seenSegments.add(segmentId);
        segmentIds.push(segmentId);
        const risk: SegmentRisk | undefined = riskLookup ? riskLookup(segmentId) : undefined;
        if (risk) {
          maxDegradationProbability = Math.max(maxDegradationProbability, risk.degradationProbability);
          riskExposure = Math.max(riskExposure, risk.degradationProbability * risk.confidence);
          if (risk.degradationProbability >= MATERIAL_RISK_CONFIDENCE_THRESHOLD) {
            riskySegmentIds.push(segmentId);
          }
        }
      }
    }
  }

  const scheduledArrivalSeconds = legs.length > 0 ? legs[legs.length - 1].arrivalTime : query.departAfterSeconds;
  const departureTime = legs.length > 0 ? legs[0].departureTime : query.departAfterSeconds;

  const arrival = computeArrivalWindow({
    scheduledArrivalSeconds,
    expectedDelaySeconds,
    segmentCount: segmentIds.length,
  });

  const totalDurationSeconds = arrival.meanSeconds - departureTime;
  const transferCount = Math.max(0, rideLegs.length - 1);

  const reliabilityScore = computeReliabilityScore({
    maxDegradationProbability,
    riskExposure,
    expectedDelaySeconds,
    totalDurationSeconds,
    transferCount,
  });

  const signature = rideLegs
    .map((leg) => `${leg.lineId}:${leg.fromStationId}>${leg.toStationId}`)
    .join("|");
  const id = `itn-${stableHash(`${signature}@${departureTime}`)}`;

  const itinerary: ItineraryCore = {
    id,
    legs,
    arrival,
    departureTime,
    totalDurationSeconds,
    transferCount,
    lineCount: lineIds.length,
    reliabilityScore,
    reliabilityBadge: badgeForScore(reliabilityScore),
    riskySegmentIds,
    maxDegradationProbability,
    expectedDelaySeconds,
  };

  return {
    signature,
    itinerary,
    lineIds,
    lineLabels: lineIds.map((lineId) => lineLabel(lineById.get(lineId), lineId)),
    segmentIds,
    riskySegmentIds,
    riskExposure,
  };
}

/**
 * Every segment the rider actually travels over, in order, de-duplicated.
 *
 * The frozen `Itinerary` contract has no flat `segmentIds` field (segments live
 * on `legs` and risky ones are mirrored into `riskySegmentIds`), so this is the
 * supported way to ask "which segments does this itinerary use?".
 */
export function itinerarySegmentIds(itinerary: Itinerary): SegmentId[] {
  const seen = new Set<SegmentId>();
  const out: SegmentId[] = [];
  for (const leg of itinerary.legs) {
    for (const segmentId of leg.segmentIds) {
      if (seen.has(segmentId)) continue;
      seen.add(segmentId);
      out.push(segmentId);
    }
  }
  return out;
}

/** Distinct lines ridden, in order of first use. */
export function itineraryLineIds(itinerary: Itinerary): LineId[] {
  const seen = new Set<LineId>();
  const out: LineId[] = [];
  for (const leg of itinerary.legs) {
    if (leg.kind !== "RIDE" || leg.lineId === null) continue;
    if (seen.has(leg.lineId)) continue;
    seen.add(leg.lineId);
    out.push(leg.lineId);
  }
  return out;
}

/** Stable identity of an itinerary's route (line + boarding/alighting stations). */
export function itinerarySignature(itinerary: Itinerary): string {
  return itinerary.legs
    .filter((leg) => leg.kind === "RIDE")
    .map((leg) => `${leg.lineId}:${leg.fromStationId}>${leg.toStationId}`)
    .join("|");
}

/** Trivial itinerary for origin === destination. */export function buildSameStationItinerary(
  stationId: StationId,
  departAfterSeconds: number,
): Itinerary {
  const window = computeArrivalWindow({
    scheduledArrivalSeconds: departAfterSeconds,
    expectedDelaySeconds: 0,
    segmentCount: 1,
  });
  return {
    id: `itn-${stableHash(`same:${stationId}@${departAfterSeconds}`)}`,
    legs: [],
    arrival: {
      p10Seconds: departAfterSeconds,
      p50Seconds: departAfterSeconds,
      p90Seconds: departAfterSeconds,
      meanSeconds: departAfterSeconds,
      meanToP90GapSeconds: 0,
    },
    departureTime: departAfterSeconds,
    totalDurationSeconds: 0,
    transferCount: 0,
    lineCount: 0,
    reliabilityScore: 1,
    reliabilityBadge: "VERY_RELIABLE",
    riskySegmentIds: [],
    maxDegradationProbability: 0,
    expectedDelaySeconds: 0,
    rank: 1,
    whyThisRank:
      "Origin and destination are the same station, so there is nothing to ride and no reliability risk to price.",
  };
}
