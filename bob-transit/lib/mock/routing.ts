/**
 * Mock route planner.
 *
 * This is a real, working time-independent router over the real network
 * topology, not a canned response: Dijkstra over (station, transfers-used)
 * states with risk-adjusted edge costs, then a penalty-method k-alternatives
 * pass. It exists so the UI is genuinely functional for ANY station pair while
 * S1's frequency-expanding CSA is being built in parallel.
 *
 * What it deliberately does NOT do (S1 owns these):
 *   - frequency expansion into dated `Connection[]`
 *   - timetable-exact departure/arrival
 * It uses scheduled run + dwell times plus a modelled average wait, which is
 * why the advisory is marked `computedOffline`/modelled rather than live.
 *
 * At integration `planMockJourneys` is replaced by S1's `PlanJourneysFn`; the
 * `RouteAdvisory` shape it returns does not change.
 */
import type {
  ArrivalWindow,
  GroundTransportFallback,
  Itinerary,
  ItineraryLeg,
  LineId,
  RiskPenalty,
  RouteAdvisory,
  RouteQuery,
  SegmentId,
  SegmentRisk,
  SegmentRiskLookup,
  StationId,
  TransitGraph,
} from "@/lib/contracts";
import {
  AVOID_SEGMENT_CONFIDENCE_THRESHOLD,
  MATERIAL_RISK_CONFIDENCE_THRESHOLD,
} from "@/lib/contracts";
import {
  badgeFor,
  computeReliabilityScore,
  explainRank,
  fastestByMean,
  rankItineraries,
} from "@/components/lib/ranking";
import { translator } from "@/lib/i18n";

import { DEMO_NOW_MS, toKlIso } from "./clock";
import { loadTopology, type LoadedTopology } from "./graph";
import { mockRiskPenalty } from "./risk";

/** Modelled average wait for the next train at the origin. */
export const MODELLED_ORIGIN_WAIT_SECONDS = 120;
/**
 * Modelled average wait after a transfer, on top of the walk between platforms.
 *
 * 240s, not 150s: a transfer is a platform walk plus a wait for the next train
 * plus the risk of just missing one, and the Klang Valley interchange walks
 * (Masjid Jamek, Maluri) are genuinely long. Understating this is what makes a
 * two-transfer itinerary look artificially attractive.
 */
export const MODELLED_TRANSFER_WAIT_SECONDS = 240;
/** Assumed coefficient of variation on scheduled run time. */
const RUN_TIME_CV = 0.08;
/** Weight applied to a disruption penalty when converting it to variance. */
const PENALTY_VARIANCE_WEIGHT = 0.8;
/** Z score for the P90 of a normal arrival distribution. */
const Z_P90 = 1.2816;
/** Z score for the P10. */
const Z_P10 = 1.2816;
/** Cost multiplier applied to edges already used, to find alternatives. */
const ALTERNATIVE_PENALTY = 1.6;

interface Edge {
  kind: "RIDE" | "TRANSFER";
  from: StationId;
  to: StationId;
  lineId: LineId | null;
  segmentId: SegmentId | null;
  /** In-vehicle run + dwell for RIDE, walking time for TRANSFER. */
  runSeconds: number;
  risk: SegmentRisk | undefined;
}

interface Adjacency {
  byStation: Map<StationId, Edge[]>;
}

function buildAdjacency(topology: LoadedTopology, lookup: SegmentRiskLookup): Adjacency {
  const byStation = new Map<StationId, Edge[]>();
  const push = (edge: Edge) => {
    const bucket = byStation.get(edge.from);
    if (bucket) bucket.push(edge);
    else byStation.set(edge.from, [edge]);
  };

  for (const segment of topology.graph.segments) {
    push({
      kind: "RIDE",
      from: segment.fromStationId,
      to: segment.toStationId,
      lineId: segment.lineId,
      segmentId: segment.id,
      runSeconds: segment.scheduledRunSeconds + segment.scheduledDwellSeconds,
      risk: lookup(segment.id),
    });
  }
  for (const transfer of topology.transfers) {
    push({
      kind: "TRANSFER",
      from: transfer.fromStationId,
      to: transfer.toStationId,
      lineId: null,
      segmentId: null,
      runSeconds: transfer.walkSeconds,
      risk: undefined,
    });
  }
  // Deterministic iteration order.
  for (const bucket of byStation.values()) {
    bucket.sort(
      (a, b) =>
        a.runSeconds - b.runSeconds ||
        (a.segmentId ?? "").localeCompare(b.segmentId ?? "") ||
        a.to.localeCompare(b.to),
    );
  }
  return { byStation };
}

/** Extra seconds this edge costs, including its share of risk. */
function edgePenalty(edge: Edge, atTime: number): number {
  if (!edge.risk || edge.kind !== "RIDE") return 0;
  return mockRiskPenalty({
    segmentId: edge.segmentId ?? "",
    severity: edge.risk.severity,
    confidence: edge.risk.degradationProbability,
    issueType: edge.risk.issueType,
    atTime,
    isOngoing: true,
  }).penaltySeconds;
}

interface SearchState {
  stationId: StationId;
  transfers: number;
}

function stateKey(state: SearchState): string {
  return `${state.stationId}#${state.transfers}`;
}

interface SearchResult {
  edges: Edge[];
  totalSeconds: number;
}

/**
 * Dijkstra over (station, transfers-used). A plain node-per-station search
 * cannot enforce `maxTransfers`, which is a hard constraint on the query.
 */
function shortestPath(
  adjacency: Adjacency,
  origin: StationId,
  destination: StationId,
  maxTransfers: number,
  departAfterSeconds: number,
  penalisedSegments: ReadonlySet<SegmentId>,
): SearchResult | null {
  if (origin === destination) return null;

  const best = new Map<string, number>();
  const previous = new Map<string, { key: string; edge: Edge }>();
  const start: SearchState = { stationId: origin, transfers: 0 };
  best.set(stateKey(start), 0);

  // Small graph: a sorted-array frontier is simpler and fast enough, and its
  // ordering is fully deterministic.
  const frontier: Array<{ key: string; state: SearchState; cost: number }> = [
    { key: stateKey(start), state: start, cost: 0 },
  ];

  let endKey: string | null = null;

  while (frontier.length > 0) {
    frontier.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
    const current = frontier.shift();
    if (!current) break;
    if (current.cost > (best.get(current.key) ?? Number.POSITIVE_INFINITY)) continue;

    if (current.state.stationId === destination) {
      endKey = current.key;
      break;
    }

    const outgoing = adjacency.byStation.get(current.state.stationId) ?? [];
    for (const edge of outgoing) {
      const isTransfer = edge.kind === "TRANSFER";
      const nextTransfers = current.state.transfers + (isTransfer ? 1 : 0);
      if (nextTransfers > maxTransfers) continue;

      const penalty = edgePenalty(edge, departAfterSeconds + current.cost);
      const wait = isTransfer ? MODELLED_TRANSFER_WAIT_SECONDS : 0;
      let stepCost = edge.runSeconds + penalty + wait;
      if (edge.segmentId && penalisedSegments.has(edge.segmentId)) {
        stepCost *= ALTERNATIVE_PENALTY;
      }
      const nextState: SearchState = {
        stationId: edge.to,
        transfers: nextTransfers,
      };
      const nextKey = stateKey(nextState);
      const nextCost = current.cost + stepCost;
      if (nextCost < (best.get(nextKey) ?? Number.POSITIVE_INFINITY) - 1e-9) {
        best.set(nextKey, nextCost);
        previous.set(nextKey, { key: current.key, edge });
        frontier.push({ key: nextKey, state: nextState, cost: nextCost });
      }
    }
  }

  if (!endKey) return null;

  const edges: Edge[] = [];
  let cursor: string | undefined = endKey;
  while (cursor) {
    const step = previous.get(cursor);
    if (!step) break;
    edges.unshift(step.edge);
    cursor = step.key;
  }
  if (edges.length === 0) return null;

  const totalSeconds = edges.reduce(
    (sum, edge, index) =>
      sum +
      edge.runSeconds +
      edgePenalty(edge, departAfterSeconds) +
      (edge.kind === "TRANSFER" ? MODELLED_TRANSFER_WAIT_SECONDS : 0) +
      (index === 0 ? MODELLED_ORIGIN_WAIT_SECONDS : 0),
    0,
  );

  return { edges, totalSeconds };
}

function signatureOf(edges: readonly Edge[]): string {
  return edges
    .map((e) => e.segmentId ?? `W:${e.from}->${e.to}`)
    .sort()
    .join("|");
}

interface PathCandidate {
  edges: Edge[];
  totalSeconds: number;
  signature: string;
}

function findCandidates(
  adjacency: Adjacency,
  query: RouteQuery,
  maxCandidates: number,
): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  const penalised = new Set<SegmentId>();
  const seen = new Set<string>();
  const attempts = Math.max(maxCandidates * 3, 6);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = shortestPath(
      adjacency,
      query.originStationId,
      query.destinationStationId,
      query.maxTransfers,
      query.departAfterSeconds,
      penalised,
    );
    if (!result) break;

    const signature = signatureOf(result.edges);
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push({
        edges: result.edges,
        totalSeconds: result.totalSeconds,
        signature,
      });
      if (candidates.length >= maxCandidates) break;
    }
    // Penalise every ride segment on the found path and search again.
    let added = false;
    for (const edge of result.edges) {
      if (edge.segmentId && !penalised.has(edge.segmentId)) {
        penalised.add(edge.segmentId);
        added = true;
      }
    }
    if (!added) break;
  }

  return candidates;
}

/* ------------------------------------------------------------------ */
/* Candidate -> Itinerary                                              */
/* ------------------------------------------------------------------ */

function buildLegs(
  edges: readonly Edge[],
  departAfterSeconds: number,
): { legs: ItineraryLeg[]; arrivalSeconds: number } {
  const legs: ItineraryLeg[] = [];
  let cursor = departAfterSeconds + MODELLED_ORIGIN_WAIT_SECONDS;
  let index = 0;

  while (index < edges.length) {
    const edge = edges[index];
    if (!edge) break;

    if (edge.kind === "TRANSFER") {
      const departureTime = cursor;
      const arrivalTime = departureTime + edge.runSeconds;
      legs.push({
        kind: "TRANSFER",
        lineId: null,
        fromStationId: edge.from,
        toStationId: edge.to,
        departureTime,
        arrivalTime,
        segmentIds: [],
        scheduledSeconds: edge.runSeconds,
        penalties: [],
        addedDelaySeconds: 0,
      });
      // Transfer leg is followed by a modelled wait before the next ride.
      cursor = arrivalTime + MODELLED_TRANSFER_WAIT_SECONDS;
      index += 1;
      continue;
    }

    // Group consecutive RIDE edges on the same line into one leg.
    const lineId = edge.lineId;
    const grouped: Edge[] = [];
    while (
      index < edges.length &&
      edges[index]?.kind === "RIDE" &&
      edges[index]?.lineId === lineId
    ) {
      const next = edges[index];
      if (!next) break;
      grouped.push(next);
      index += 1;
    }

    const departureTime = cursor;
    let scheduledSeconds = 0;
    let addedDelaySeconds = 0;
    const segmentIds: SegmentId[] = [];
    const penalties: RiskPenalty[] = [];
    let clock = departureTime;

    for (const ride of grouped) {
      scheduledSeconds += ride.runSeconds;
      const penalty = edgePenalty(ride, clock);
      if (ride.segmentId) {
        segmentIds.push(ride.segmentId);
        if (ride.risk) {
          penalties.push(
            mockRiskPenalty({
              segmentId: ride.segmentId,
              severity: ride.risk.severity,
              confidence: ride.risk.degradationProbability,
              issueType: ride.risk.issueType,
              atTime: clock,
              isOngoing: true,
            }),
          );
        }
      }
      addedDelaySeconds += penalty;
      clock += ride.runSeconds + penalty;
    }

    legs.push({
      kind: "RIDE",
      lineId,
      fromStationId: grouped[0]?.from ?? "",
      toStationId: grouped[grouped.length - 1]?.to ?? "",
      departureTime,
      arrivalTime: clock,
      segmentIds,
      scheduledSeconds,
      penalties,
      addedDelaySeconds,
    });
    cursor = clock;
  }

  return { legs, arrivalSeconds: cursor };
}

function arrivalWindow(
  legs: readonly ItineraryLeg[],
  meanArrivalSeconds: number,
  departureTime: number,
): ArrivalWindow {
  let variance = 0;
  for (const leg of legs) {
    if (leg.kind === "TRANSFER") {
      variance += (leg.scheduledSeconds * 0.25) ** 2;
      continue;
    }
    for (const penalty of leg.penalties) {
      variance += (penalty.penaltySeconds * PENALTY_VARIANCE_WEIGHT) ** 2;
    }
    variance += (leg.scheduledSeconds * RUN_TIME_CV) ** 2;
  }
  // Waiting for a train is itself uncertain; model it as a uniform headway.
  variance += (MODELLED_ORIGIN_WAIT_SECONDS / Math.sqrt(3)) ** 2;

  const sigma = Math.sqrt(variance);
  const meanDuration = meanArrivalSeconds - departureTime;
  const p90Duration = meanDuration + Z_P90 * sigma;
  const p10Duration = Math.max(0, meanDuration - Z_P10 * sigma);

  return {
    p10Seconds: Math.round(departureTime + p10Duration),
    p50Seconds: Math.round(meanArrivalSeconds),
    p90Seconds: Math.round(departureTime + p90Duration),
    meanSeconds: Math.round(meanArrivalSeconds),
    meanToP90GapSeconds: Math.round(p90Duration - meanDuration),
  };
}

export interface PlanMockOptions {
  graph: TransitGraph;
  query: RouteQuery;
  riskLookup?: SegmentRiskLookup;
  topology?: LoadedTopology;
}

/**
 * Contract-compatible with S1's `PlanJourneysFn`, but returns the full ranked
 * list (S1's signature returns `Itinerary[]` too — the advisory wrapper is
 * `planMockAdvisory` below).
 */
export function planMockJourneys(options: PlanMockOptions): Itinerary[] {
  const topology = options.topology ?? loadTopology();
  const lookup: SegmentRiskLookup = options.riskLookup ?? (() => undefined);
  const adjacency = buildAdjacency(topology, lookup);
  const query = options.query;
  const maxCandidates = Math.max(1, Math.min(query.maxItineraries || 3, 5));
  const candidates = findCandidates(adjacency, query, maxCandidates);

  const itineraries = candidates.map((candidate, index) => {
    const { legs, arrivalSeconds } = buildLegs(candidate.edges, query.departAfterSeconds);
    const rideSegments = legs.flatMap((leg) => leg.segmentIds);
    const expectedDelaySeconds = legs.reduce(
      (sum, leg) => sum + leg.addedDelaySeconds,
      0,
    );
    const riskySegmentIds = rideSegments.filter((segmentId) => {
      const risk = lookup(segmentId);
      return (
        risk !== undefined &&
        risk.degradationProbability >= MATERIAL_RISK_CONFIDENCE_THRESHOLD
      );
    });
    let maxDegradationProbability = 0;
    for (const segmentId of rideSegments) {
      const risk = lookup(segmentId);
      if (risk && risk.degradationProbability > maxDegradationProbability) {
        maxDegradationProbability = risk.degradationProbability;
      }
    }

    const arrival = arrivalWindow(legs, arrivalSeconds, query.departAfterSeconds);
    const totalDurationSeconds = arrival.meanSeconds - query.departAfterSeconds;
    const transferCount = legs.filter((leg) => leg.kind === "TRANSFER").length;
    const lineCount = new Set(
      legs.map((leg) => leg.lineId).filter((id): id is LineId => id !== null),
    ).size;

    const reliabilityScore = computeReliabilityScore({
      maxDegradationProbability,
      expectedDelaySeconds,
      totalDurationSeconds,
      transferCount,
    });

    const itinerary: Itinerary = {
      id: `ITIN-${index + 1}-${signatureHash(candidate.signature)}`,
      legs,
      arrival,
      departureTime: query.departAfterSeconds,
      totalDurationSeconds,
      transferCount,
      lineCount,
      reliabilityScore,
      reliabilityBadge: badgeFor(reliabilityScore, maxDegradationProbability),
      riskySegmentIds,
      maxDegradationProbability: Number(maxDegradationProbability.toFixed(4)),
      expectedDelaySeconds: Math.round(expectedDelaySeconds),
      rank: index + 1,
      whyThisRank: "",
    };
    return itinerary;
  });

  const ranked = rankItineraries(itineraries);
  // The narrative compares against the quickest option by MEAN duration, because
  // that is the number the rider sees as "Typical". P90 remains the ranking
  // tie-break (see compareByReliability).
  const fastest = fastestByMean(ranked);
  const tr = translator("en");
  return ranked.map((itinerary) => {
    const explanation = explainRank(itinerary, {
      all: ranked,
      riskLookup: lookup,
      fastest,
      t: tr,
    });
    const details = explanation.details.join(" ");
    return {
      ...itinerary,
      whyThisRank: details ? `${explanation.headline} ${details}` : explanation.headline,
    };
  });
}

function signatureHash(signature: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < signature.length; i += 1) {
    h = Math.imul(h ^ signature.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/* ------------------------------------------------------------------ */
/* Advisory wrapper                                                    */
/* ------------------------------------------------------------------ */

export interface AdvisoryOptions {
  query: RouteQuery;
  riskLookup: SegmentRiskLookup;
  riskAsOf: string;
  computedOffline: boolean;
  topology?: LoadedTopology;
  /** segment id -> the signal that explains it, so `consideredSignals` cites real signal ids. */
  signalIndex?: ReadonlyMap<SegmentId, string>;
}

/**
 * Assemble a `RouteAdvisory` from an already-planned itinerary list.
 *
 * Extracted so the live integration adapter (`source-live.ts`) can wrap S1's
 * `PlanJourneysFn` output with exactly the same advisory semantics — fallback,
 * no-safe-alternative flag, considered signals, fragility note — instead of
 * reimplementing them.
 */
export function assembleAdvisory(
  itineraries: Itinerary[],
  options: Omit<AdvisoryOptions, "topology"> & { topology: LoadedTopology },
): RouteAdvisory {
  const ranked = rankItineraries(itineraries);
  const topology = options.topology;

  const noSafeAlternative =
    ranked.length > 0 &&
    ranked.every(
      (itinerary) =>
        itinerary.maxDegradationProbability >= AVOID_SEGMENT_CONFIDENCE_THRESHOLD,
    );

  const recommended = ranked[0];
  const fastest = fastestByMean(ranked);
  const consideredSignals = collectConsideredSignals(
    ranked,
    options.riskLookup,
    options.signalIndex,
  );
  const fallback = buildFallback(ranked, topology, options.query);

  return {
    id: `ADV-${queryHash(options.query)}`,
    generatedAt: toKlIso(DEMO_NOW_MS),
    originStationId: options.query.originStationId,
    destinationStationId: options.query.destinationStationId,
    itineraries: ranked,
    recommendedItineraryId: recommended ? recommended.id : null,
    noSafeAlternative,
    fallback: ranked.length === 0 || noSafeAlternative ? fallback : null,
    whyThisCouldBeWrong: explainFragility(ranked, fastest, topology),
    consideredSignals,
    computedOffline: options.computedOffline,
    riskAsOf: options.riskAsOf,
  };
}

export function planMockAdvisory(options: AdvisoryOptions): RouteAdvisory {
  const topology = options.topology ?? loadTopology();
  const itineraries = planMockJourneys({
    graph: topology.graph,
    query: options.query,
    riskLookup: options.riskLookup,
    topology,
  });
  return assembleAdvisory(itineraries, {
    query: options.query,
    riskLookup: options.riskLookup,
    riskAsOf: options.riskAsOf,
    computedOffline: options.computedOffline,
    topology,
    signalIndex: options.signalIndex,
  });
}

function collectConsideredSignals(
  itineraries: readonly Itinerary[],
  lookup: SegmentRiskLookup,
  signalIndex: ReadonlyMap<SegmentId, string> | undefined,
): RouteAdvisory["consideredSignals"] {
  const bySegment = new Map<
    string,
    { signalId: string; confidence: number; severity: string; segmentIds: string[] }
  >();
  for (const itinerary of itineraries) {
    for (const leg of itinerary.legs) {
      for (const segmentId of leg.segmentIds) {
        const risk = lookup(segmentId);
        if (!risk) continue;
        if (bySegment.has(segmentId)) continue;
        bySegment.set(segmentId, {
          // Cite the real signal when we know it; fall back to the segment so
          // the field is never empty.
          signalId: signalIndex?.get(segmentId) ?? `SEGMENT:${segmentId}`,
          confidence: risk.degradationProbability,
          severity: risk.severity,
          segmentIds: [segmentId],
        });
      }
    }
  }
  return [...bySegment.values()].sort(
    (a, b) => b.confidence - a.confidence || a.signalId.localeCompare(b.signalId),
  );
}

function buildFallback(
  itineraries: readonly Itinerary[],
  topology: LoadedTopology,
  query: RouteQuery,
): GroundTransportFallback {
  const origin = topology.stationById.get(query.originStationId);
  const destination = topology.stationById.get(query.destinationStationId);
  const straightLineKm =
    origin && destination
      ? Math.hypot(
          (destination.lat - origin.lat) * 111.32,
          (destination.lon - origin.lon) * 111.32 * Math.cos((origin.lat * Math.PI) / 180),
        )
      : 0;
  // 22 km/h average for Klang Valley road traffic in the peak.
  const estimated = Math.round((straightLineKm / 22) * 3600);
  const best = itineraries[0];
  return {
    description: `E-hailing or taxi from ${origin?.name ?? query.originStationId} to ${destination?.name ?? query.destinationStationId}`,
    estimatedDurationSeconds: Math.max(600, estimated),
    note: best
      ? `About ${Math.round(best.totalDurationSeconds / 60)} min by rail on the recommended option; road may be faster while the disruption is live.`
      : "No rail itinerary was found between these stations; road is the only option we can suggest.",
  };
}

function explainFragility(
  itineraries: readonly Itinerary[],
  fastest: Itinerary | null,
  topology: LoadedTopology,
): string {
  const top = itineraries[0];
  if (!top) {
    return "We found no rail itinerary at all for this pair, so this is a fallback rather than a recommendation.";
  }
  const worstSegmentId = top.riskySegmentIds[0];
  if (worstSegmentId) {
    const segment = topology.segmentById.get(worstSegmentId);
    const from = segment ? topology.stationById.get(segment.fromStationId)?.name : undefined;
    const to = segment ? topology.stationById.get(segment.toStationId)?.name : undefined;
    return `If the disruption between ${from ?? "the affected stations"} and ${to ?? "the next station"} clears, the ranking could flip back to a faster option.`;
  }
  if (fastest && fastest.id !== top.id) {
    return "If the faster option's risk is downgraded, it would become the recommendation again.";
  }
  return "If an unreported disruption appears on one of this route's segments, the ranking could change.";
}

function queryHash(query: RouteQuery): string {
  const raw = `${query.originStationId}|${query.destinationStationId}|${query.departAfterSeconds}|${query.serviceWeekday}|${query.maxItineraries}|${query.maxTransfers}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").slice(0, 8);
}
