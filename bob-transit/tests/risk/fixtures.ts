/**
 * Shared fixtures for `tests/risk/**`.
 *
 * Everything here is typed against the FROZEN contracts. No fixture imports a
 * router module to *build* an itinerary: the candidates are constructed by hand,
 * exactly as the brief requires, so these tests do not depend on S1's CSA search
 * working.
 *
 * The one exception is the arrival window. Per the orchestrator ruling there is a
 * single canonical arrival model (`lib/routing/reliability.ts`), so the fixture
 * uses it to simulate what the router would have produced — otherwise these tests
 * would be asserting against a window no other part of the app can produce.
 */

import type {
  ArrivalWindow,
  ConfidenceScore,
  DisruptionSignal,
  Itinerary,
  ItineraryLeg,
  IssueType,
  LineId,
  RiskPenalty,
  SegmentId,
  SegmentRisk,
  SegmentRiskLookup,
  Severity,
  SourceRef,
  StationId,
} from "@/lib/contracts";
import { computeArrivalWindow } from "@/lib/routing/reliability";
import { createRiskPenaltyFn, type RiskPenaltyOptions } from "@/lib/risk/penalty";

/* ------------------------------------------------------------------ *
 * Segment ids
 * ------------------------------------------------------------------ */

export interface ParsedSegmentId {
  lineId: LineId;
  fromStationId: StationId;
  toStationId: StationId;
}

/** `"KJ:A->B"` -> `{ lineId: "KJ", fromStationId: "A", toStationId: "B" }`. */
export function parseSegmentId(segmentId: SegmentId): ParsedSegmentId {
  const [lineId, rest] = segmentId.split(":");
  const [fromStationId, toStationId] = rest.split("->");
  return { lineId, fromStationId, toStationId };
}

export function makeSegmentId(
  lineId: LineId,
  fromStationId: StationId,
  toStationId: StationId,
): SegmentId {
  return `${lineId}:${fromStationId}->${toStationId}`;
}

/* ------------------------------------------------------------------ *
 * Itineraries
 * ------------------------------------------------------------------ */

export interface RideLegSpec {
  lineId: LineId;
  segmentIds: SegmentId[];
  /** Total scheduled run time for the whole leg, seconds. */
  scheduledSeconds: number;
}

export interface MakeItineraryArgs {
  id: string;
  departureTime: number;
  rideLegs: RideLegSpec[];
  /** Seconds for the TRANSFER leg inserted between ride leg i and i+1. */
  transferSeconds?: number[];
  /** Risk picture, exactly as the router would have priced it. */
  riskLookup?: SegmentRiskLookup;
  /** Per-segment scheduled run times, so penalties are priced realistically. */
  riskPenaltyOptions?: RiskPenaltyOptions;
  /** Local seconds after midnight used when pricing penalties. Defaults to 12:00. */
  atTime?: number;
}

const ZERO_ARRIVAL: ArrivalWindow = {
  p10Seconds: 0,
  p50Seconds: 0,
  p90Seconds: 0,
  meanSeconds: 0,
  meanToP90GapSeconds: 0,
};

/**
 * Build a fully-populated `Itinerary` fixture the way the router would:
 * price each segment through `RiskPenaltyFn`, sum the penalties into `mu`, and
 * run the canonical arrival model.
 *
 * `reliabilityScore`, `reliabilityBadge`, `rank` and `whyThisRank` are left as
 * placeholders on purpose — `rankItineraries` recomputes every one of them, and a
 * test that fed in a pre-baked score would not be testing the ranker.
 */
export function makeItinerary(args: MakeItineraryArgs): Itinerary {
  const penaltyFn = createRiskPenaltyFn(args.riskPenaltyOptions ?? {});
  const atTime = args.atTime ?? 12 * 3600;

  const legs: ItineraryLeg[] = [];
  const lineIds = new Set<LineId>();
  let cursor = args.departureTime;
  let segmentCount = 0;
  let expectedDelaySeconds = 0;
  let transferCount = 0;

  args.rideLegs.forEach((spec, index) => {
    const first = parseSegmentId(spec.segmentIds[0]);
    const last = parseSegmentId(spec.segmentIds[spec.segmentIds.length - 1]);
    lineIds.add(spec.lineId);

    const penalties: RiskPenalty[] = [];
    let addedDelaySeconds = 0;
    for (const segmentId of spec.segmentIds) {
      segmentCount += 1;
      const risk = args.riskLookup?.(segmentId);
      if (!risk) continue;
      const penalty = penaltyFn({
        segmentId,
        severity: risk.severity,
        confidence: risk.confidence,
        issueType: risk.issueType,
        atTime,
        isOngoing: true,
      });
      penalties.push(penalty);
      addedDelaySeconds += penalty.penaltySeconds;
    }
    expectedDelaySeconds += addedDelaySeconds;

    legs.push({
      kind: "RIDE",
      lineId: spec.lineId,
      fromStationId: first.fromStationId,
      toStationId: last.toStationId,
      departureTime: cursor,
      arrivalTime: cursor + spec.scheduledSeconds,
      segmentIds: [...spec.segmentIds],
      scheduledSeconds: spec.scheduledSeconds,
      penalties,
      addedDelaySeconds,
    });
    cursor += spec.scheduledSeconds;

    if (index < args.rideLegs.length - 1) {
      const next = args.rideLegs[index + 1];
      const seconds = args.transferSeconds?.[index] ?? 180;
      legs.push({
        kind: "TRANSFER",
        lineId: null,
        fromStationId: last.toStationId,
        toStationId: parseSegmentId(next.segmentIds[0]).fromStationId,
        departureTime: cursor,
        arrivalTime: cursor + seconds,
        segmentIds: [],
        scheduledSeconds: seconds,
        penalties: [],
        addedDelaySeconds: 0,
      });
      cursor += seconds;
      transferCount += 1;
    }
  });

  const arrival = computeArrivalWindow({
    scheduledArrivalSeconds: cursor,
    expectedDelaySeconds,
    segmentCount,
  });

  return {
    id: args.id,
    legs,
    arrival,
    departureTime: args.departureTime,
    totalDurationSeconds: arrival.meanSeconds - args.departureTime,
    transferCount,
    lineCount: lineIds.size,
    reliabilityScore: 0,
    reliabilityBadge: "UNCERTAIN",
    riskySegmentIds: [],
    maxDegradationProbability: 0,
    expectedDelaySeconds,
    rank: 0,
    whyThisRank: "",
  };
}

/** A single-line itinerary of `segmentCount` equal segments. */
export function makeSimpleItinerary(args: {
  id: string;
  lineId: LineId;
  segmentCount: number;
  perSegmentSeconds: number;
  departureTime?: number;
  /**
   * Adds this many zero-duration interchanges so the reliability score sees the
   * transfer penalty without the scheduled duration changing.
   */
  transferCount?: number;
  riskLookup?: SegmentRiskLookup;
  atTime?: number;
}): Itinerary {
  const departureTime = args.departureTime ?? 8 * 3600;
  const transferCount = args.transferCount ?? 0;
  const rideLegs: RideLegSpec[] = [];
  const transferSeconds: number[] = [];

  const segmentsPerLeg = Math.max(1, Math.ceil(args.segmentCount / (transferCount + 1)));
  let cursor = 0;
  let segmentIndex = 0;
  while (cursor < args.segmentCount) {
    const take = Math.min(segmentsPerLeg, args.segmentCount - cursor);
    const segmentIds: SegmentId[] = [];
    for (let i = 0; i < take; i += 1) {
      segmentIds.push(
        makeSegmentId(args.lineId, `${args.lineId}${segmentIndex}`, `${args.lineId}${segmentIndex + 1}`),
      );
      segmentIndex += 1;
    }
    rideLegs.push({
      lineId: args.lineId,
      segmentIds,
      scheduledSeconds: take * args.perSegmentSeconds,
    });
    cursor += take;
    if (cursor < args.segmentCount) transferSeconds.push(0);
  }

  return makeItinerary({
    id: args.id,
    departureTime,
    rideLegs,
    transferSeconds: transferSeconds.length > 0 ? transferSeconds : undefined,
    riskLookup: args.riskLookup,
    atTime: args.atTime,
  });
}

/* ------------------------------------------------------------------ *
 * Risk
 * ------------------------------------------------------------------ */

export function makeSegmentRisk(args: {
  segmentId: SegmentId;
  degradationProbability: number;
  confidence: number;
  severity?: Severity;
  issueType?: IssueType;
  sourceCount?: number;
  lastUpdated?: string;
  stale?: boolean;
}): SegmentRisk {
  return {
    segmentId: args.segmentId,
    degradationProbability: args.degradationProbability,
    confidence: args.confidence,
    severity: args.severity ?? "MAJOR",
    issueType: args.issueType ?? "DELAY",
    sourceCount: args.sourceCount ?? 1,
    lastUpdated: args.lastUpdated ?? "2025-06-02T01:00:00.000Z",
    stale: args.stale ?? false,
  };
}

export function makeLookup(risks: readonly SegmentRisk[]): SegmentRiskLookup {
  const index = new Map<SegmentId, SegmentRisk>();
  for (const risk of risks) index.set(risk.segmentId, risk);
  return (segmentId: SegmentId) => index.get(segmentId);
}

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

export function makeSourceRef(args: {
  id: string;
  rawText?: string;
  publishedAt?: string;
}): SourceRef {
  return {
    id: args.id,
    sourceClass: "OFFICIAL_STATEMENT",
    url: `https://example.invalid/${args.id}`,
    authorId: `author-${args.id}`,
    rawText: args.rawText ?? "Gangguan perkhidmatan di stesen ini.",
    publishedAt: args.publishedAt ?? "2025-06-02T01:00:00.000Z",
    retrievedAt: "2025-06-02T01:05:00.000Z",
    language: "ms",
    contentHash: `hash-${args.id}`,
  };
}

export function makeConfidence(
  value: number,
  overrides: Partial<ConfidenceScore> = {},
): ConfidenceScore {
  return {
    value,
    calibrationVersion: "test-1.0.0",
    factors: [{ name: "test", weight: 1, contribution: value, note: "fixture" }],
    band:
      value >= 0.85 ? "VERY_HIGH" : value >= 0.65 ? "HIGH" : value >= 0.4 ? "MODERATE" : value >= 0.2 ? "LOW" : "VERY_LOW",
    degradedByOfflineCache: false,
    ...overrides,
  };
}

export function makeSignal(args: {
  id: string;
  segmentIds?: SegmentId[];
  confidenceValue: number;
  severity?: Severity;
  issueType?: IssueType;
  status?: DisruptionSignal["status"];
  resolution?: DisruptionSignal["resolution"];
  unresolvedCandidates?: SegmentId[];
  sourceIds?: string[];
  updatedAt?: string;
  windowStart?: string;
  windowEnd?: string | null;
  lineIds?: LineId[];
  stationIds?: StationId[];
}): DisruptionSignal {
  const updatedAt = args.updatedAt ?? "2025-06-02T01:00:00.000Z";
  return {
    id: args.id,
    createdAt: updatedAt,
    updatedAt,
    status: args.status ?? "CONFIRMED",
    segmentIds: args.segmentIds ?? [],
    stationIds: args.stationIds ?? [],
    lineIds: args.lineIds ?? [],
    resolution: args.resolution ?? "RESOLVED",
    unresolvedCandidates: args.unresolvedCandidates,
    issueType: args.issueType ?? "TRACK_FAULT",
    severity: args.severity ?? "MAJOR",
    confidence: makeConfidence(args.confidenceValue),
    firstSeenAt: updatedAt,
    lastSeenAt: updatedAt,
    operatorNotifiedAt: null,
    leadTimeMinutes: null,
    corroboratingSources: { official: 1, socialDistinctAuthors: 0, realtimeObservations: 0 },
    sources: (args.sourceIds ?? [`src-${args.id}`]).map((id) =>
      makeSourceRef({ id, publishedAt: updatedAt }),
    ),
    reasoning: "Fixture signal for tests.",
    wouldAHumanCheckThis: false,
    window: {
      startsAt: args.windowStart ?? "2025-06-02T00:00:00.000Z",
      endsAt: args.windowEnd ?? null,
    },
    provenance: [],
  };
}

/** Fixed injected "now" used across the suite. Nothing here reads the clock. */
export const NOW_ISO = "2025-06-02T01:10:00.000Z";
