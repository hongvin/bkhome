/**
 * Shared test helpers for `tests/routing/**`.
 *
 * Not a test file itself (vitest only picks up `*.test.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Itinerary,
  RiskPenalty,
  RiskPenaltyFn,
  RouteQuery,
  SegmentRisk,
  SegmentRiskLookup,
  TransitGraph,
} from "@/lib/contracts";
import { SEVERITY_BASE_MULTIPLIER } from "@/lib/contracts";
import { buildTransitGraph } from "@/lib/gtfs/build";
import { parseTransitGraph, serializeTransitGraph } from "@/lib/gtfs/graph-io";
import { GTFS_RAIL_FIXTURE_DIR, readGtfsFeed } from "@/lib/gtfs/read-feed";

export const REPO_ROOT = process.cwd();
export const GRAPH_PATH = join(REPO_ROOT, "public/graph/transit-graph.json");
export const GTFS_DIR = join(REPO_ROOT, GTFS_RAIL_FIXTURE_DIR);

/** Monday. The fixture's MonFri service pattern is active. */
export const MONDAY = 1;
/** Sunday. Only the `Sun` service pattern is active. */
export const SUNDAY = 0;
/** 08:00 local. */
export const MORNING_PEAK = 8 * 3600;

/**
 * The serialized artifact exactly as the browser would receive it.
 *
 * If `make graph` has not been run in this checkout the helper builds the
 * artifact first, so `vitest run tests/routing` is self-contained. Routing
 * itself always goes through `parseTransitGraph` on the JSON text — never
 * through the in-memory build — so the offline path is what is exercised.
 */
export function readGraphJson(): string {
  if (!existsSync(GRAPH_PATH)) {
    const graph = buildTransitGraph(readGtfsFeed(GTFS_DIR), {
      builtAt: "1970-01-01T00:00:00.000Z",
    });
    mkdirSync(dirname(GRAPH_PATH), { recursive: true });
    writeFileSync(GRAPH_PATH, serializeTransitGraph(graph), "utf8");
  }
  return readFileSync(GRAPH_PATH, "utf8");
}

let cached: TransitGraph | null = null;

/** The cached graph, parsed from the on-disk JSON. */
export function cachedGraph(): TransitGraph {
  if (cached === null) cached = parseTransitGraph(readGraphJson());
  return cached;
}

export function makeQuery(
  originStationId: string,
  destinationStationId: string,
  overrides: Partial<RouteQuery> = {},
): RouteQuery {
  return {
    originStationId,
    destinationStationId,
    departAfterSeconds: MORNING_PEAK,
    serviceWeekday: MONDAY,
    maxItineraries: 5,
    maxInitialWaitSeconds: 1800,
    maxTransfers: 3,
    ...overrides,
  };
}

export function makeIncident(
  segmentId: string,
  overrides: Partial<SegmentRisk> = {},
): SegmentRisk {
  return {
    segmentId,
    degradationProbability: 0.95,
    confidence: 0.9,
    severity: "SEVERE",
    issueType: "TRACK_FAULT",
    sourceCount: 3,
    lastUpdated: "2024-01-01T00:00:00.000Z",
    stale: false,
    ...overrides,
  };
}

export function lookupFrom(risks: SegmentRisk[]): SegmentRiskLookup {
  const byId = new Map(risks.map((r) => [r.segmentId, r] as const));
  return (segmentId) => byId.get(segmentId);
}

/**
 * A contract-conformant `RiskPenaltyFn` for tests ONLY. S4 owns the production
 * implementation; this one exists so the router's risk path can be exercised in
 * isolation. It is pure, monotonic in confidence and severity, and returns
 * multiplier >= 1.
 */
export const testRiskPenalty: RiskPenaltyFn = (input): RiskPenalty => {
  const base = SEVERITY_BASE_MULTIPLIER[input.severity] ?? 1;
  const confidence = Math.min(1, Math.max(0, input.confidence));
  return {
    segmentId: input.segmentId,
    penaltySeconds: Math.round(600 * confidence * base),
    multiplier: 1 + (base - 1) * confidence,
    confidence,
    severity: input.severity,
    reason: `test penalty: ${input.severity} at ${Math.round(confidence * 100)}% confidence`,
  };
};

export function segmentIdsOf(itinerary: Itinerary): string[] {
  const out: string[] = [];
  for (const leg of itinerary.legs) for (const id of leg.segmentIds) if (!out.includes(id)) out.push(id);
  return out;
}

export function rideSignature(itinerary: Itinerary): string {
  return itinerary.legs
    .filter((leg) => leg.kind === "RIDE")
    .map((leg) => `${leg.lineId}:${leg.fromStationId}>${leg.toStationId}`)
    .join(" | ");
}

export function lineSet(itinerary: Itinerary): string {
  const lines = itinerary.legs
    .filter((leg) => leg.kind === "RIDE" && leg.lineId !== null)
    .map((leg) => leg.lineId as string);
  return [...new Set(lines)].sort().join("+");
}

export function describeItinerary(itinerary: Itinerary): string {
  return [
    `#${itinerary.rank}`,
    `${(itinerary.reliabilityScore * 100).toFixed(1)}%`,
    itinerary.reliabilityBadge,
    `${Math.round(itinerary.totalDurationSeconds / 60)}min`,
    `p90=${Math.round(itinerary.arrival.p90Seconds)}`,
    `xfer=${itinerary.transferCount}`,
    `[${lineSet(itinerary)}]`,
    rideSignature(itinerary),
  ].join(" ");
}

export function summarise(itineraries: Itinerary[]): string {
  return itineraries.map(describeItinerary).join("\n");
}
