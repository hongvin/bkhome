/**
 * Compact, window-expandable transit graph.
 *
 * The full artifact carries ~163k expanded `Connection` objects (~29 MB raw).
 * A phone should not fetch that, and the router never needs more than the
 * departure window it is planning in. So the compact artifact keeps everything
 * EXCEPT `connections` and instead stores one stop pattern per trip template:
 *
 *     template + frequencies.txt headway  ->  concrete Connection[] on demand
 *
 * `expandConnectionsForWindow` reconstructs exactly the connections the full
 * graph would contain for a service day and departure window, in the same order.
 * `tests/routing/compact.test.ts` proves that equivalence against the full
 * artifact rather than asserting it.
 *
 * Client integration: load the compact JSON, then
 *   materializeTransitGraph(compact, { weekday, fromSeconds, toSeconds })
 * and hand the result to `planJourneys` — the frozen `PlanJourneysFn` signature
 * is unchanged.
 */

import type {
  Connection,
  FrequencyTemplate,
  LineId,
  Line,
  Segment,
  SegmentId,
  ServiceCalendar,
  Station,
  StationId,
  TransitGraph,
  TransitGraphStats,
} from "@/lib/contracts";
import { CONTRACTS_VERSION, TZ_NAME, makeSegmentId } from "@/lib/contracts";

export interface CompactTripPattern {
  /** Template trip id, i.e. the key used by `frequencies.txt`. */
  tripId: string;
  lineId: LineId;
  serviceId: string;
  /** Ordered stop ids of the template. */
  stopIds: StationId[];
  /** `departureOffsets[i]` = departure from `stopIds[i]`, relative to the trip's first departure. */
  departureOffsets: number[];
  /** `arrivalOffsets[i]` = arrival at `stopIds[i]`, relative to the trip's first departure. Index 0 is unused. */
  arrivalOffsets: number[];
}

export interface CompactTransitGraph {
  contractsVersion: typeof CONTRACTS_VERSION;
  builtAt: string;
  timezone: typeof TZ_NAME;
  lines: Line[];
  stations: Station[];
  segments: Segment[];
  services: ServiceCalendar[];
  frequencies: FrequencyTemplate[];
  tripPatterns: CompactTripPattern[];
  /** Stats of the FULL graph this compact form was derived from. */
  stats: TransitGraphStats;
  warnings: string[];
}

/** Split `"AGL_MonFri_0#21600"` into its template id. */
function templateIdOf(concreteTripId: string): string {
  const hash = concreteTripId.lastIndexOf("#");
  return hash === -1 ? concreteTripId : concreteTripId.slice(0, hash);
}

/**
 * Derive the compact form from a built graph. Purely mechanical: the earliest
 * expanded departure of each template is un-shifted back into a stop pattern.
 */
export function toCompactGraph(graph: TransitGraph): CompactTransitGraph {
  const byInstance = new Map<string, Connection[]>();
  for (const connection of graph.connections) {
    const list = byInstance.get(connection.tripId);
    if (list) list.push(connection);
    else byInstance.set(connection.tripId, [connection]);
  }

  // Earliest instance per template. `graph.connections` is sorted by departure,
  // so the first connection pushed for an instance is its first departure.
  const earliestByTemplate = new Map<string, { instanceTripId: string; firstDeparture: number }>();
  for (const [instanceTripId, list] of byInstance) {
    const template = templateIdOf(instanceTripId);
    const firstDeparture = list[0].departureTime;
    const current = earliestByTemplate.get(template);
    if (!current || firstDeparture < current.firstDeparture) {
      earliestByTemplate.set(template, { instanceTripId, firstDeparture });
    }
  }

  const tripPatterns: CompactTripPattern[] = [];
  for (const [template, { instanceTripId }] of earliestByTemplate) {
    const list = byInstance.get(instanceTripId);
    if (!list || list.length === 0) continue;
    const origin = list[0].departureTime;
    const stopIds: StationId[] = [list[0].fromStationId];
    const departureOffsets: number[] = [];
    const arrivalOffsets: number[] = [0];
    for (let i = 0; i < list.length; i += 1) {
      const connection = list[i];
      // Guard the contiguity assumption; a gap would mean the graph is broken.
      if (i > 0 && connection.fromStationId !== list[i - 1].toStationId) break;
      departureOffsets.push(connection.departureTime - origin);
      arrivalOffsets.push(connection.arrivalTime - origin);
      stopIds.push(connection.toStationId);
    }
    tripPatterns.push({
      tripId: template,
      lineId: list[0].lineId,
      serviceId: list[0].serviceId,
      stopIds,
      departureOffsets,
      arrivalOffsets,
    });
  }
  tripPatterns.sort((a, b) => a.tripId.localeCompare(b.tripId));

  return {
    contractsVersion: graph.contractsVersion,
    builtAt: graph.builtAt,
    timezone: graph.timezone,
    lines: graph.lines,
    stations: graph.stations,
    segments: graph.segments,
    services: graph.services,
    frequencies: graph.frequencies,
    tripPatterns,
    stats: graph.stats,
    warnings: graph.warnings,
  };
}

export interface ExpansionWindow {
  /** 0 = Sunday, matching `Date#getDay()`. */
  weekday: number;
  /** Inclusive lower bound on `Connection.departureTime`. */
  fromSeconds: number;
  /** Inclusive upper bound on `Connection.departureTime`. */
  toSeconds: number;
}

/**
 * Reconstruct the concrete connections for one service day and departure window,
 * sorted ascending by `departureTime` (the CSA precondition).
 *
 * The window bounds DEPARTURES, not arrivals: a connection that departs inside
 * the window is included even if it arrives after `toSeconds`.
 */
export function expandConnectionsForWindow(
  compact: CompactTransitGraph,
  weekday: number,
  fromSeconds: number,
  toSeconds: number,
): Connection[] {
  const activeServices = new Set<string>();
  for (const service of compact.services) {
    if (service.weekdays[weekday] === true) activeServices.add(service.serviceId);
  }

  const patternByTrip = new Map(compact.tripPatterns.map((p) => [p.tripId, p] as const));
  const connections: Connection[] = [];

  for (const frequency of compact.frequencies) {
    if (!activeServices.has(frequency.serviceId)) continue;
    if (frequency.headwaySeconds <= 0) continue;

    const pattern = patternByTrip.get(frequency.tripId);
    if (!pattern) continue;

    // A trip that STARTED before the window can still have later stops inside
    // it (a Kelana Jaya run takes ~1h40m end to end), so both the row-level
    // overlap test and the grid alignment must account for the trip's length.
    // The per-connection filter below then trims the trips that contribute
    // nothing.
    const lastOffset = pattern.departureOffsets[pattern.departureOffsets.length - 1] ?? 0;
    if (frequency.endTime + lastOffset <= fromSeconds) continue;
    if (frequency.startTime > toSeconds) continue;

    const gridStart = fromSeconds - lastOffset;
    const firstAligned =
      frequency.startTime +
      Math.max(0, Math.ceil((gridStart - frequency.startTime) / frequency.headwaySeconds)) *
        frequency.headwaySeconds;
    const lastDeparture = Math.min(frequency.endTime, toSeconds + 1);

    for (let t = firstAligned; t < lastDeparture; t += frequency.headwaySeconds) {
      const instanceTripId = `${frequency.tripId}#${t}`;
      for (let i = 0; i < pattern.stopIds.length - 1; i += 1) {
        const departureTime = t + pattern.departureOffsets[i];
        if (departureTime < fromSeconds || departureTime > toSeconds) continue;
        const fromStationId = pattern.stopIds[i];
        const toStationId = pattern.stopIds[i + 1];
        connections.push({
          tripId: instanceTripId,
          lineId: pattern.lineId,
          serviceId: pattern.serviceId,
          fromStationId,
          toStationId,
          segmentId: makeSegmentId(pattern.lineId, fromStationId, toStationId),
          departureTime,
          arrivalTime: t + pattern.arrivalOffsets[i + 1],
        });
      }
    }
  }

  connections.sort(
    (a, b) =>
      a.departureTime - b.departureTime ||
      a.arrivalTime - b.arrivalTime ||
      a.segmentId.localeCompare(b.segmentId) ||
      a.tripId.localeCompare(b.tripId),
  );
  return connections;
}

/**
 * Materialise a windowed `TransitGraph` that is drop-in compatible with the
 * frozen contract and therefore with `planJourneys`.
 */
export function materializeTransitGraph(
  compact: CompactTransitGraph,
  window: ExpansionWindow,
): TransitGraph {
  const connections = expandConnectionsForWindow(
    compact,
    window.weekday,
    window.fromSeconds,
    window.toSeconds,
  );
  const serviceDayCount = new Set(connections.map((c) => c.serviceId)).size;
  return {
    contractsVersion: compact.contractsVersion,
    builtAt: compact.builtAt,
    timezone: compact.timezone,
    lines: compact.lines,
    stations: compact.stations,
    segments: compact.segments,
    services: compact.services,
    frequencies: compact.frequencies,
    connections,
    stats: {
      stationCount: compact.stations.length,
      lineCount: compact.lines.length,
      segmentCount: compact.segments.length,
      connectionCount: connections.length,
      serviceDayCount,
    },
    warnings: compact.warnings,
  };
}

export function serializeCompactGraph(compact: CompactTransitGraph): string {
  return JSON.stringify(compact);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateCompactGraph(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["compact graph is not an object"];
  if (value.contractsVersion !== CONTRACTS_VERSION) problems.push("contractsVersion mismatch");
  if (value.timezone !== TZ_NAME) problems.push("timezone mismatch");
  for (const key of ["lines", "stations", "segments", "services", "frequencies", "tripPatterns"]) {
    if (!Array.isArray(value[key])) problems.push(`${key} is not an array`);
  }
  if (problems.length > 0) return problems;
  if ("connections" in value) {
    problems.push("compact graph must not contain `connections`");
  }

  const stationIds = new Set((value.stations as Array<Record<string, unknown>>).map((s) => s.id));
  const frequencyTrips = new Set(
    (value.frequencies as Array<Record<string, unknown>>).map((f) => f.tripId),
  );
  for (const pattern of value.tripPatterns as Array<Record<string, unknown>>) {
    const stopIds = pattern.stopIds as unknown[];
    const departures = pattern.departureOffsets as unknown[];
    const arrivals = pattern.arrivalOffsets as unknown[];
    if (!Array.isArray(stopIds) || stopIds.length < 2) {
      problems.push(`pattern ${String(pattern.tripId)} has fewer than 2 stops`);
      continue;
    }
    if (departures.length !== stopIds.length - 1 || arrivals.length !== stopIds.length) {
      problems.push(`pattern ${String(pattern.tripId)} has inconsistent offset arrays`);
      continue;
    }
    for (const stopId of stopIds) {
      if (!stationIds.has(stopId)) problems.push(`pattern ${String(pattern.tripId)} has unknown stop ${String(stopId)}`);
    }
    if (!frequencyTrips.has(pattern.tripId)) {
      problems.push(`pattern ${String(pattern.tripId)} has no matching frequency row`);
    }
  }
  return problems;
}

export function parseCompactGraph(json: string): CompactTransitGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`compact graph is not valid JSON: ${(error as Error).message}`);
  }
  const problems = validateCompactGraph(parsed);
  if (problems.length > 0) {
    throw new Error(`compact graph failed validation: ${problems.slice(0, 5).join("; ")}`);
  }
  return parsed as CompactTransitGraph;
}

/** Segment ids referenced by a compact graph, for a quick integrity check. */
export function compactSegmentIds(compact: CompactTransitGraph): SegmentId[] {
  const ids = new Set<SegmentId>();
  for (const pattern of compact.tripPatterns) {
    for (let i = 0; i < pattern.stopIds.length - 1; i += 1) {
      ids.add(makeSegmentId(pattern.lineId, pattern.stopIds[i], pattern.stopIds[i + 1]));
    }
  }
  return [...ids];
}
