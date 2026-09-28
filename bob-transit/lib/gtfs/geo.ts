/**
 * Geodesic helpers. Segment polylines come from `shapes.txt`; distances are
 * great-circle sums, which is accurate enough for ranking transfers and for
 * reporting `Segment.lengthMeters`.
 *
 * NOTE: `stops.txt` has a `geometry` column, but every row in the fixture
 * contains the literal string "[object Object]". It is never read.
 */

import type { LatLng } from "@/lib/contracts";

export const EARTH_RADIUS_METERS = 6_371_008.8;

/** Great-circle distance in metres between two WGS84 points. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Sum of consecutive great-circle hops along a polyline. */
export function polylineLengthMeters(points: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Index of the shape point closest to `target`, searching only at or after
 * `fromIndex`. The monotonic search is what keeps stop->shape assignment
 * sane on the long, densely sampled MRT polylines.
 */
export function nearestShapeIndex(
  points: LatLng[],
  target: LatLng,
  fromIndex: number,
): number {
  let bestIndex = Math.max(0, Math.min(fromIndex, points.length - 1));
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = bestIndex; i < points.length; i += 1) {
    const d = haversineMeters(points[i], target);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}
