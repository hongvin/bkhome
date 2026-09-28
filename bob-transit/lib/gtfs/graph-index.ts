/**
 * O(1) lookup helpers over a `TransitGraph`, per the frozen `GraphIndex`
 * contract. Built once per graph load and reused by the router.
 */

import type { GraphIndex, LineId, Segment, TransitGraph } from "@/lib/contracts";

export function buildGraphIndex(graph: TransitGraph): GraphIndex {
  const stationById = new Map(graph.stations.map((s) => [s.id, s] as const));
  const lineById = new Map(graph.lines.map((l) => [l.id, l] as const));
  const segmentById = new Map(graph.segments.map((s) => [s.id, s] as const));
  const segmentsByLine = new Map<LineId, Segment[]>();
  for (const segment of graph.segments) {
    const list = segmentsByLine.get(segment.lineId);
    if (list) list.push(segment);
    else segmentsByLine.set(segment.lineId, [segment]);
  }
  return { stationById, lineById, segmentById, segmentsByLine };
}
