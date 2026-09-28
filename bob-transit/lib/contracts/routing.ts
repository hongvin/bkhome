/**
 * FROZEN CONTRACT — do not modify.
 *
 * Routing and advisory contracts. The product thesis lives here: itineraries are
 * ranked by RELIABILITY first and duration second, and arrival is reported as a
 * P90 window with the mean alongside.
 */

import type { LineId, SegmentId, StationId } from "./network";
import type { RiskPenalty, SegmentRisk } from "./risk";

export interface RouteQuery {
  originStationId: StationId;
  destinationStationId: StationId;
  /** Local seconds after midnight. */
  departAfterSeconds: number;
  /** 0 = Sunday, matching JS `Date#getDay()`. */
  serviceWeekday: number;
  /** Upper bound on itineraries returned after de-duplication. */
  maxItineraries: number;
  /** How long the rider will wait at the origin before giving up, in seconds. */
  maxInitialWaitSeconds: number;
  maxTransfers: number;
}

export type LegKind = "RIDE" | "TRANSFER" | "WAIT";

export interface ItineraryLeg {
  kind: LegKind;
  lineId: LineId | null;
  fromStationId: StationId;
  toStationId: StationId;
  /** Seconds after local midnight. */
  departureTime: number;
  arrivalTime: number;
  segmentIds: SegmentId[];
  /** Scheduled duration with no disruption applied. */
  scheduledSeconds: number;
  /** Risk penalties applied to this leg, for the Source Inspector. */
  penalties: RiskPenalty[];
  /** Sum of penaltySeconds across this leg's segments. */
  addedDelaySeconds: number;
}

/** Arrival-time distribution summary. P90 is the headline; the mean is shown beside it. */
export interface ArrivalWindow {
  p10Seconds: number;
  p50Seconds: number;
  p90Seconds: number;
  meanSeconds: number;
  /** p90 - mean, in seconds. The gap IS the product, so it is stored explicitly. */
  meanToP90GapSeconds: number;
}

export type ReliabilityBadge =
  | "VERY_RELIABLE"
  | "RELIABLE"
  | "UNCERTAIN"
  | "AT_RISK"
  | "AVOID";

export interface Itinerary {
  id: string;
  legs: ItineraryLeg[];

  /** Absolute arrival times, seconds after local midnight. */
  arrival: ArrivalWindow;
  /** Absolute departure time, seconds after local midnight. */
  departureTime: number;
  /** Mean total journey time, seconds. */
  totalDurationSeconds: number;

  transferCount: number;
  /** Number of distinct lines ridden. */
  lineCount: number;

  /** 0..1, higher is better. Primary sort key. */
  reliabilityScore: number;
  reliabilityBadge: ReliabilityBadge;

  /** Segments on this itinerary that carry material risk. */
  riskySegmentIds: SegmentId[];
  /** Highest degradation probability across the itinerary's segments. */
  maxDegradationProbability: number;
  /** Expected added delay across the itinerary, seconds. */
  expectedDelaySeconds: number;

  /** 1-based rank after reliability-first sorting. */
  rank: number;
  /**
   * One line explaining why this itinerary sits at this rank.
   * Required for rank 1 ("why the top option is the top option").
   */
  whyThisRank: string;
}

export interface GroundTransportFallback {
  description: string;
  estimatedDurationSeconds: number;
  note: string;
}

export interface RouteAdvisory {
  id: string;
  generatedAt: string;
  originStationId: StationId;
  destinationStationId: StationId;

  itineraries: Itinerary[];
  /** The recommendation. Equals itineraries[0] unless none is safe. */
  recommendedItineraryId: string | null;
  /**
   * True when every candidate crosses a segment above
   * AVOID_SEGMENT_CONFIDENCE_THRESHOLD and no safe alternative exists.
   */
  noSafeAlternative: boolean;
  fallback: GroundTransportFallback | null;

  /** One sentence: the single most likely reason this recommendation is wrong. */
  whyThisCouldBeWrong: string;
  /** Signals that influenced ranking, with confidence at this hop. */
  consideredSignals: Array<{
    signalId: string;
    confidence: number;
    severity: string;
    segmentIds: SegmentId[];
  }>;
  /** Set when computed from cached graph/risk while offline. */
  computedOffline: boolean;
  riskAsOf: string;
}

/** Risk lookup the router uses. Returns undefined for a healthy segment. */
export type SegmentRiskLookup = (segmentId: SegmentId) => SegmentRisk | undefined;

export interface PlanJourneysOptions {
  graph: import("./network").TransitGraph;
  query: RouteQuery;
  riskLookup?: SegmentRiskLookup;
  riskPenalty?: import("./risk").RiskPenaltyFn;
}

/** The router's public entry point, implemented by S1. */
export type PlanJourneysFn = (
  options: PlanJourneysOptions,
) => Itinerary[];
