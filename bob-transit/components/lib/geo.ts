/**
 * GeoJSON builders for the map. Pure — no MapLibre import — so they are cheap
 * to reason about and reusable in tests.
 */
import type { Feature, FeatureCollection, LineString, Point } from "geojson";

import type { Line, Segment, SegmentId, SegmentRisk, Station } from "@/lib/contracts";

export interface SegmentFeatureProps {
  segmentId: SegmentId;
  lineId: string;
  color: string;
  /** 0..1 degradation probability; 0 for healthy segments. */
  probability: number;
  severity: string;
  risky: boolean;
}

export function buildSegmentFeatures(
  segments: readonly Segment[],
  lines: readonly Line[],
  risks: ReadonlyMap<SegmentId, SegmentRisk>,
): FeatureCollection<LineString, SegmentFeatureProps> {
  const colorByLine = new Map(lines.map((l) => [l.id, `#${l.color}`]));
  return {
    type: "FeatureCollection",
    features: segments.map((segment) => {
      const risk = risks.get(segment.id);
      return {
        type: "Feature",
        id: segment.id,
        properties: {
          segmentId: segment.id,
          lineId: segment.lineId,
          color: colorByLine.get(segment.lineId) ?? "#64748b",
          probability: risk ? risk.degradationProbability : 0,
          severity: risk ? risk.severity : "NONE",
          risky: risk !== undefined,
        },
        geometry: {
          type: "LineString",
          coordinates: segment.shape.map((p) => [p.lon, p.lat]),
        },
      };
    }),
  };
}

export interface StationFeatureProps {
  stationId: string;
  name: string;
  isInterchange: boolean;
  isAccessible: boolean;
  lineIds: string;
}

export function buildStationFeatures(
  stations: readonly Station[],
): FeatureCollection<Point, StationFeatureProps> {
  return {
    type: "FeatureCollection",
    features: stations.map((station) => ({
      type: "Feature",
      id: station.id,
      properties: {
        stationId: station.id,
        name: station.name,
        isInterchange: station.isInterchange,
        isAccessible: station.isAccessible,
        lineIds: station.lineIds.join(","),
      },
      geometry: { type: "Point", coordinates: [station.lon, station.lat] },
    })),
  };
}

export function buildRouteFeature(
  segmentIds: readonly SegmentId[],
  segmentById: ReadonlyMap<SegmentId, Segment>,
  color = "#e2e8f0",
): Feature<LineString, { color: string }> {
  const coordinates: Array<[number, number]> = [];
  for (const segmentId of segmentIds) {
    const segment = segmentById.get(segmentId);
    if (!segment) continue;
    for (const point of segment.shape) {
      const coord: [number, number] = [point.lon, point.lat];
      const last = coordinates[coordinates.length - 1];
      if (last && last[0] === coord[0] && last[1] === coord[1]) continue;
      coordinates.push(coord);
    }
  }
  return {
    type: "Feature",
    properties: { color },
    geometry: { type: "LineString", coordinates },
  };
}

export interface EndpointFeatureProps {
  role: "origin" | "destination";
  label: string;
}

export function buildEndpointFeatures(
  origin: Station | undefined,
  destination: Station | undefined,
): FeatureCollection<Point, EndpointFeatureProps> {
  const features: Array<Feature<Point, EndpointFeatureProps>> = [];
  if (origin) {
    features.push({
      type: "Feature",
      properties: { role: "origin", label: origin.name },
      geometry: { type: "Point", coordinates: [origin.lon, origin.lat] },
    });
  }
  if (destination) {
    features.push({
      type: "Feature",
      properties: { role: "destination", label: destination.name },
      geometry: { type: "Point", coordinates: [destination.lon, destination.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** [[west, south], [east, north]] covering every segment, or null when empty. */
export function networkBounds(
  segments: readonly Segment[],
): [[number, number], [number, number]] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    for (const point of segment.shape) {
      if (point.lon < west) west = point.lon;
      if (point.lon > east) east = point.lon;
      if (point.lat < south) south = point.lat;
      if (point.lat > north) north = point.lat;
    }
  }
  if (!Number.isFinite(west)) return null;
  return [
    [west, south],
    [east, north],
  ];
}

/** Collect every ride segment id on an itinerary, in order. */
export function itinerarySegmentIds(
  legs: ReadonlyArray<{ kind: string; segmentIds: string[] }>,
): SegmentId[] {
  return legs.flatMap((leg) => (leg.kind === "RIDE" ? leg.segmentIds : []));
}
