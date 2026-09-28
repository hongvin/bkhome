/**
 * Per-query routing context.
 *
 * A `TransitGraph` is the whole network for every service pattern. A routing
 * context narrows it to one weekday, indexes stations to dense integers (CSA
 * runs on typed arrays), and precomputes interchange footpaths as integer
 * edges. Built once per `planJourneys` call.
 */

import type {
  Connection,
  LineId,
  SegmentId,
  ServiceCalendar,
  Station,
  StationId,
  TransitGraph,
} from "@/lib/contracts";
import { computeInterchanges, type InterchangeTopology } from "@/lib/gtfs/interchange";

export interface Footpath {
  /** Index into `RoutingContext.stations`. */
  to: number;
  walkSeconds: number;
  distanceMeters: number;
}

export interface RoutingContext {
  graph: TransitGraph;
  stations: Station[];
  stationIndex: Map<StationId, number>;
  /** Connections active on the queried weekday, ascending by departureTime. */
  connections: Connection[];
  /** Footpaths indexed by origin station index. */
  footpaths: Footpath[][];
  topology: InterchangeTopology;
  activeServiceIds: Set<string>;
  serviceWeekdays: Map<string, boolean[]>;
}

export function buildServiceWeekdayMap(services: ServiceCalendar[]): Map<string, boolean[]> {
  return new Map(services.map((s) => [s.serviceId, s.weekdays] as const));
}

/**
 * @param serviceWeekday 0 = Sunday, matching `Date#getDay()`.
 * @param options optional departure-time window; connections outside it are
 *   dropped before CSA ever sees them. Nothing boardable departs before
 *   `departAfterSeconds`, and no journey in this feed runs for six hours, so the
 *   window is a pure work reduction, not an approximation of the answer.
 */
export function buildRoutingContext(
  graph: TransitGraph,
  serviceWeekday: number,
  options: { minDepartureSeconds?: number; maxDepartureSeconds?: number } = {},
): RoutingContext {
  const stations = graph.stations;
  const stationIndex = new Map<StationId, number>();
  for (let i = 0; i < stations.length; i += 1) stationIndex.set(stations[i].id, i);

  const serviceWeekdays = buildServiceWeekdayMap(graph.services);
  const activeServiceIds = new Set<string>();
  for (const [serviceId, weekdays] of serviceWeekdays) {
    if (weekdays[serviceWeekday] === true) activeServiceIds.add(serviceId);
  }

  const minDeparture = options.minDepartureSeconds ?? Number.NEGATIVE_INFINITY;
  const maxDeparture = options.maxDepartureSeconds ?? Number.POSITIVE_INFINITY;

  const connections: Connection[] = [];
  for (const c of graph.connections) {
    if (!activeServiceIds.has(c.serviceId)) continue;
    if (c.departureTime < minDeparture || c.departureTime > maxDeparture) continue;
    connections.push(c);
  }
  // The stored graph is already sorted by departureTime; the filtered
  // subsequence preserves that order, so no re-sort is needed.

  const topology = computeInterchanges(stations);
  const footpaths: Footpath[][] = stations.map(() => []);
  for (let i = 0; i < stations.length; i += 1) {
    const links = topology.linksByStation.get(stations[i].id);
    if (!links) continue;
    for (const link of links) {
      const to = stationIndex.get(link.toStationId);
      if (to === undefined) continue;
      footpaths[i].push({
        to,
        walkSeconds: link.walkSeconds,
        distanceMeters: link.distanceMeters,
      });
    }
  }

  return {
    graph,
    stations,
    stationIndex,
    connections,
    footpaths,
    topology,
    activeServiceIds,
    serviceWeekdays,
  };
}

/** Distinct ride segments of a connection sequence, in order of traversal. */
export function segmentIdsOfConnections(connections: Connection[]): SegmentId[] {
  const seen = new Set<SegmentId>();
  const out: SegmentId[] = [];
  for (const c of connections) {
    if (seen.has(c.segmentId)) continue;
    seen.add(c.segmentId);
    out.push(c.segmentId);
  }
  return out;
}

export function linesOfConnections(connections: Connection[]): LineId[] {
  const seen = new Set<LineId>();
  const out: LineId[] = [];
  for (const c of connections) {
    if (seen.has(c.lineId)) continue;
    seen.add(c.lineId);
    out.push(c.lineId);
  }
  return out;
}
