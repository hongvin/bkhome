/**
 * Topology loader — the network the UI draws.
 *
 * Two sources, in priority order:
 *   1. `public/graph/transit-graph.json` — the REAL artifact produced by
 *      `make graph` (S1's graph builder, from the official GTFS fixture).
 *   2. `lib/mock/fixtures/network.json` — the offline fallback committed with
 *      the UI so the interface is never blocked on S1.
 *
 * Both are `TransitGraph`, so the loader path is identical and the UI cannot
 * silently disagree with the router about the network: at integration the real
 * artifact simply wins and the fallback goes unused.
 *
 * Server-side only (uses `node:fs`). The browser gets this through `app/api/**`.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  Line,
  LineId,
  Segment,
  SegmentId,
  Station,
  StationId,
  TransitGraph,
} from "@/lib/contracts";

import { normaliseLines, normaliseStations } from "./naming";

export const GRAPH_ARTIFACT_REL = "public/graph/transit-graph.json";
export const GRAPH_FIXTURE_REL = "lib/mock/fixtures/network.json";

export type TopologySource = "artifact" | "fixture";

export interface LoadedTopology {
  graph: TransitGraph;
  source: TopologySource;
  /** Repo-relative path the topology was read from. */
  path: string;
  lineById: Map<LineId, Line>;
  stationById: Map<StationId, Station>;
  segmentById: Map<SegmentId, Segment>;
  segmentsByLine: Map<LineId, Segment[]>;
  /** Every station reachable within 400 m of another line's station, for transfer edges. */
  transfers: TransferEdge[];
}

export interface TransferEdge {
  fromStationId: StationId;
  toStationId: StationId;
  /** Seconds to walk, at 1.25 m/s plus a 45 s gate/faregate allowance. */
  walkSeconds: number;
  meters: number;
}

const EARTH_M_PER_DEG = 111_320;

export function metersBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (b.lat - a.lat) * EARTH_M_PER_DEG;
  const dLon = (b.lon - a.lon) * EARTH_M_PER_DEG * Math.cos(midLat);
  return Math.hypot(dLat, dLon);
}

/** Maximum interchange walking distance. Interchanges are separate stop_ids (contract note). */
const MAX_TRANSFER_METERS = 400;
const WALK_METERS_PER_SECOND = 1.25;
const TRANSFER_OVERHEAD_SECONDS = 45;

function isTransitGraph(value: unknown): value is TransitGraph {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<TransitGraph>;
  return (
    Array.isArray(v.lines) &&
    Array.isArray(v.stations) &&
    Array.isArray(v.segments) &&
    v.stations.length > 0 &&
    v.segments.length > 0
  );
}

function readGraph(relPath: string): TransitGraph | null {
  const abs = path.join(process.cwd(), relPath);
  try {
    if (!fs.existsSync(abs)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(abs, "utf8"));
    return isTransitGraph(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let cached: LoadedTopology | null = null;

export function loadTopology(): LoadedTopology {
  if (cached) return cached;

  const artifact = readGraph(GRAPH_ARTIFACT_REL);
  const raw = artifact ?? readGraph(GRAPH_FIXTURE_REL);
  if (!raw) {
    throw new Error(
      `No transit graph found. Looked for ${GRAPH_ARTIFACT_REL} (run \`make graph\`) ` +
        `and the committed fallback ${GRAPH_FIXTURE_REL}.`,
    );
  }
  const source: TopologySource = artifact ? "artifact" : "fixture";

  // Normalise casing/sponsor suffixes and add BM line names. Applied to the real
  // artifact and the fallback identically, so integration cannot change names.
  const graph: TransitGraph = {
    ...raw,
    lines: normaliseLines(raw.lines),
    stations: normaliseStations(raw.stations),
  };

  const lineById = new Map(graph.lines.map((l) => [l.id, l]));
  const stationById = new Map(graph.stations.map((s) => [s.id, s]));
  const segmentById = new Map(graph.segments.map((s) => [s.id, s]));
  const segmentsByLine = new Map<LineId, Segment[]>();
  for (const seg of graph.segments) {
    const bucket = segmentsByLine.get(seg.lineId);
    if (bucket) bucket.push(seg);
    else segmentsByLine.set(seg.lineId, [seg]);
  }
  for (const bucket of segmentsByLine.values()) {
    bucket.sort((a, b) => a.fromSequence - b.fromSequence);
  }

  cached = {
    graph,
    source,
    path: artifact ? GRAPH_ARTIFACT_REL : GRAPH_FIXTURE_REL,
    lineById,
    stationById,
    segmentById,
    segmentsByLine,
    transfers: buildTransfers(graph.stations, stationById),
  };
  return cached;
}

/**
 * Interchange edges. The GTFS feed models each line's platform as its own
 * `stop_id` (KJ13 / SP7 / AG7 are all Masjid Jamek), so a shared-id lookup
 * would never find a transfer. Proximity plus a name-family match is the
 * documented workaround.
 */
function buildTransfers(
  stations: Station[],
  stationById: Map<StationId, Station>,
): TransferEdge[] {
  const edges: TransferEdge[] = [];
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      const a = stations[i];
      const b = stations[j];
      if (!a || !b) continue;
      if (a.lineIds[0] === b.lineIds[0]) continue;
      const meters = metersBetween(a, b);
      if (meters > MAX_TRANSFER_METERS) continue;
      const walkSeconds = Math.round(meters / WALK_METERS_PER_SECOND) + TRANSFER_OVERHEAD_SECONDS;
      edges.push({ fromStationId: a.id, toStationId: b.id, walkSeconds, meters: Math.round(meters) });
      edges.push({ fromStationId: b.id, toStationId: a.id, walkSeconds, meters: Math.round(meters) });
    }
  }
  // Deterministic order: cost, then id. Keeps Dijkstra tie-breaks reproducible.
  edges.sort((x, y) =>
    x.walkSeconds - y.walkSeconds ||
    x.fromStationId.localeCompare(y.fromStationId) ||
    x.toStationId.localeCompare(y.toStationId),
  );
  void stationById;
  return edges;
}

export function lineColor(line: Line | undefined): string {
  return line ? `#${line.color}` : "#64748b";
}

/** Test hook: drops the module-level cache so a test can swap fixtures. */
export function resetTopologyCache(): void {
  cached = null;
}
