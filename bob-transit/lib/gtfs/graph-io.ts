/**
 * Serialisation + structural validation for the cached `TransitGraph`.
 *
 * This is the airplane-mode path: the graph is written to
 * `public/graph/transit-graph.json`, fetched once, stored in IndexedDB, and
 * parsed back into the exact same object for routing with no network.
 */

import type { TransitGraph } from "@/lib/contracts";
import { CONTRACTS_VERSION, TZ_NAME } from "@/lib/contracts";

/** Compact JSON — this file is ~20 MB of connections and is shipped to the browser. */
export function serializeTransitGraph(graph: TransitGraph): string {
  return JSON.stringify(graph);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse + structurally validate a serialized graph. Throws with a precise
 * message rather than letting a malformed cache produce silently wrong routes.
 */
export function parseTransitGraph(json: string): TransitGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`transit-graph.json is not valid JSON: ${(error as Error).message}`);
  }
  const problems = validateTransitGraph(parsed);
  if (problems.length > 0) {
    throw new Error(`transit-graph.json failed validation: ${problems.slice(0, 5).join("; ")}`);
  }
  return parsed as TransitGraph;
}

/**
 * Structural + referential checks. Returns a list of problems (empty = valid).
 * Used by the build script as a pre-write gate and by the offline test.
 */
export function validateTransitGraph(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["graph is not an object"];

  if (value.contractsVersion !== CONTRACTS_VERSION) {
    problems.push(
      `contractsVersion is ${String(value.contractsVersion)}, expected ${CONTRACTS_VERSION}`,
    );
  }
  if (value.timezone !== TZ_NAME) {
    problems.push(`timezone is ${String(value.timezone)}, expected ${TZ_NAME}`);
  }
  if (typeof value.builtAt !== "string" || Number.isNaN(Date.parse(value.builtAt))) {
    problems.push("builtAt is not an ISO timestamp");
  }

  const arrays = ["lines", "stations", "segments", "services", "frequencies", "connections", "warnings"] as const;
  for (const key of arrays) {
    if (!Array.isArray(value[key])) problems.push(`${key} is not an array`);
  }
  if (problems.length > 0) return problems;

  const lines = value.lines as Array<Record<string, unknown>>;
  const stations = value.stations as Array<Record<string, unknown>>;
  const segments = value.segments as Array<Record<string, unknown>>;
  const connections = value.connections as Array<Record<string, unknown>>;

  const lineIds = new Set<string>();
  for (const line of lines) {
    if (typeof line.id !== "string" || line.id === "") problems.push("line without id");
    else if (lineIds.has(line.id)) problems.push(`duplicate line id ${line.id}`);
    else lineIds.add(line.id);
  }

  const stationIds = new Set<string>();
  for (const station of stations) {
    if (typeof station.id !== "string" || station.id === "") {
      problems.push("station without id");
      continue;
    }
    if (stationIds.has(station.id)) problems.push(`duplicate station id ${station.id}`);
    stationIds.add(station.id);
    if (!Array.isArray(station.lineIds)) problems.push(`station ${station.id} has no lineIds array`);
    else {
      for (const lineId of station.lineIds as unknown[]) {
        if (typeof lineId !== "string" || !lineIds.has(lineId)) {
          problems.push(`station ${station.id} references unknown line ${String(lineId)}`);
        }
      }
    }
  }

  const segmentIds = new Set<string>();
  for (const segment of segments) {
    if (typeof segment.id !== "string" || segment.id === "") {
      problems.push("segment without id");
      continue;
    }
    if (segmentIds.has(segment.id)) problems.push(`duplicate segment id ${segment.id}`);
    segmentIds.add(segment.id);
    if (!stationIds.has(String(segment.fromStationId))) {
      problems.push(`segment ${segment.id} has unknown fromStationId ${String(segment.fromStationId)}`);
    }
    if (!stationIds.has(String(segment.toStationId))) {
      problems.push(`segment ${segment.id} has unknown toStationId ${String(segment.toStationId)}`);
    }
    if (!lineIds.has(String(segment.lineId))) {
      problems.push(`segment ${segment.id} has unknown lineId ${String(segment.lineId)}`);
    }
    if (!Array.isArray(segment.shape) || (segment.shape as unknown[]).length < 2) {
      problems.push(`segment ${segment.id} has a shape with fewer than 2 points`);
    }
  }

  let previousDeparture = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < connections.length; i += 1) {
    const c = connections[i];
    const departure = c.departureTime;
    if (typeof departure !== "number" || !Number.isFinite(departure)) {
      problems.push(`connection ${i} has a non-numeric departureTime`);
      break;
    }
    if (departure < previousDeparture) {
      problems.push(
        `connections are not sorted by departureTime at index ${i} (${departure} < ${previousDeparture})`,
      );
      break;
    }
    previousDeparture = departure;
    if (typeof c.arrivalTime !== "number" || c.arrivalTime < departure) {
      problems.push(`connection ${i} arrives before it departs`);
      break;
    }
    if (!segmentIds.has(String(c.segmentId))) {
      problems.push(`connection ${i} references unknown segment ${String(c.segmentId)}`);
      break;
    }
    if (!lineIds.has(String(c.lineId))) {
      problems.push(`connection ${i} references unknown line ${String(c.lineId)}`);
      break;
    }
    if (!stationIds.has(String(c.fromStationId)) || !stationIds.has(String(c.toStationId))) {
      problems.push(`connection ${i} references an unknown station`);
      break;
    }
  }

  const stats = value.stats;
  if (!isRecord(stats)) {
    problems.push("stats is missing");
  } else {
    const expected: Array<[string, number]> = [
      ["stationCount", stations.length],
      ["lineCount", lines.length],
      ["segmentCount", segments.length],
      ["connectionCount", connections.length],
    ];
    for (const [key, actual] of expected) {
      if (stats[key] !== actual) {
        problems.push(`stats.${key} is ${String(stats[key])}, expected ${actual}`);
      }
    }
  }

  return problems;
}
