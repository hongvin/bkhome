/**
 * Node-only GTFS static loader.
 *
 * Reads ONLY from the committed fixture directory. This file uses `node:fs`, so
 * it is deliberately NOT re-exported from `lib/gtfs/index.ts` — the barrel must
 * stay importable from browser code for offline routing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawGtfsFeed } from "./raw";
import {
  toCalendarRow,
  toFrequencyRow,
  toRouteRow,
  toShapePoint,
  toStopRow,
  toStopTimeRow,
  toTripRow,
} from "./raw";
import { parseCsvRecords } from "./csv";

export const GTFS_RAIL_FIXTURE_DIR = "data/gtfs-static/rapid-rail-kl";

export interface GtfsFileSpec {
  file: string;
  map: (record: Record<string, string>) => unknown;
  required: boolean;
}

export interface ReadGtfsFeedResult {
  feed: RawGtfsFeed;
  warnings: string[];
}

function readRecords(dir: string, file: string, required: boolean, warnings: string[]): Record<string, string>[] {
  const path = join(dir, file);
  if (!existsSync(path)) {
    if (required) throw new Error(`GTFS fixture file missing: ${path}`);
    warnings.push(`Optional GTFS file missing: ${path}`);
    return [];
  }
  return parseCsvRecords(readFileSync(path, "utf8"));
}

/** Parse a GTFS directory into a typed, in-memory feed. Throws only when a required file is missing. */
export function readGtfsFeed(dir: string): RawGtfsFeed {
  const warnings: string[] = [];
  const feed: RawGtfsFeed = {
    stops: readRecords(dir, "stops.txt", true, warnings).map(toStopRow),
    routes: readRecords(dir, "routes.txt", true, warnings).map(toRouteRow),
    trips: readRecords(dir, "trips.txt", true, warnings).map(toTripRow),
    stopTimes: readRecords(dir, "stop_times.txt", true, warnings).map(toStopTimeRow),
    frequencies: readRecords(dir, "frequencies.txt", true, warnings).map(toFrequencyRow),
    calendar: readRecords(dir, "calendar.txt", true, warnings).map(toCalendarRow),
    shapes: readRecords(dir, "shapes.txt", false, warnings).map(toShapePoint),
  };
  return fillMissingStopTimes(feed);
}

/**
 * Defensive interpolation for blank GTFS arrival/departure values. The committed
 * fixture has no blanks, so this is a no-op today, but a frequency-based feed is
 * exactly where blank times appear once a real-time source starts feeding it.
 */
export function fillMissingStopTimes(feed: RawGtfsFeed): RawGtfsFeed {
  const byTrip = new Map<string, number[]>();
  feed.stopTimes.forEach((row, index) => {
    const list = byTrip.get(row.tripId);
    if (list) list.push(index);
    else byTrip.set(row.tripId, [index]);
  });

  for (const indices of byTrip.values()) {
    indices.sort((a, b) => feed.stopTimes[a].stopSequence - feed.stopTimes[b].stopSequence);
    let previousDeparture = Number.NaN;
    for (const index of indices) {
      const row = feed.stopTimes[index];
      if (!Number.isFinite(row.arrivalTime) && Number.isFinite(previousDeparture)) {
        row.arrivalTime = previousDeparture;
        row.interpolated = true;
      }
      if (!Number.isFinite(row.departureTime) && Number.isFinite(row.arrivalTime)) {
        row.departureTime = row.arrivalTime;
        row.interpolated = true;
      }
      if (Number.isFinite(row.departureTime)) previousDeparture = row.departureTime;
    }
    // Leading blanks: walk backwards from the first known arrival.
    for (let k = indices.length - 1; k >= 0; k -= 1) {
      const row = feed.stopTimes[indices[k]];
      if (Number.isFinite(row.arrivalTime)) continue;
      const nextIndex = indices[k + 1];
      const nextArrival = nextIndex === undefined ? Number.NaN : feed.stopTimes[nextIndex].arrivalTime;
      if (!Number.isFinite(nextArrival)) continue;
      row.arrivalTime = Math.max(0, nextArrival - 60);
      row.departureTime = row.arrivalTime;
      row.interpolated = true;
    }
  }
  return feed;
}

/** Convenience wrapper for the committed rail fixture. */
export function readCommittedRailFeed(repoRoot: string = process.cwd()): RawGtfsFeed {
  return readGtfsFeed(join(repoRoot, GTFS_RAIL_FIXTURE_DIR));
}
