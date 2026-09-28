/**
 * Network-index sources.
 *
 * Two loaders, one shape:
 *  - `loadNetworkIndexFromGtfs()` reads `data/gtfs-static/rapid-rail-kl/*.txt`
 *    directly (read-only). Used by the snapshot generator and by the drift test
 *    that proves the committed snapshot still matches the feed.
 *  - `loadBundledNetworkIndex()` reads the committed JSON snapshot so the demo
 *    request path is fully offline and synchronous (no fs, no network, works in
 *    the browser and in a Worker).
 *
 * The JSON snapshot is an *untrusted module boundary*: it is parsed and coerced
 * field by field rather than cast, so a hand-edited fixture cannot smuggle a
 * malformed station into the resolver.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { LineId, SegmentId, StationId, TransitMode } from "@/lib/contracts";

import {
  type NetworkIndex,
  type NetworkLine,
  type NetworkSegment,
  type NetworkStation,
  buildNetworkIndex,
} from "./build";
import { parseRoutes, parseStopTimes, parseStops, parseTrips } from "./parse";

import snapshotJson from "@/data/corpus/network/network-index.snapshot.json";

export const DEFAULT_GTFS_DIR = "data/gtfs-static/rapid-rail-kl";

export interface SnapshotShape {
  generatedAt: string;
  generatedFrom: string;
  warnings: string[];
  lines: NetworkLine[];
  stations: NetworkStation[];
  segments: NetworkSegment[];
}

/* ------------------------------------------------------------------ *
 * Defensive readers for the JSON boundary
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readLine(value: unknown): NetworkLine | null {
  const r = asRecord(value);
  const id = asString(r.id);
  if (!id) return null;
  const mode = asString(r.mode, "LRT");
  return {
    id,
    shortName: asString(r.shortName),
    longName: asString(r.longName),
    longNameMs: asString(r.longNameMs),
    color: asString(r.color),
    mode: mode as TransitMode,
  };
}

function readStation(value: unknown): NetworkStation | null {
  const r = asRecord(value);
  const id = asString(r.id);
  if (!id) return null;
  // Rebuilt with a typed accumulator so the result is exactly Record<string, number>.
  const sequenceByLine: Record<string, number> = {};
  for (const [lineId, seq] of Object.entries(asRecord(r.sequenceByLine))) {
    if (typeof seq === "number" && Number.isFinite(seq)) sequenceByLine[lineId] = seq;
  }
  return {
    id,
    name: asString(r.name),
    nameMs: asString(r.nameMs, asString(r.name)),
    lat: asNumber(r.lat),
    lon: asNumber(r.lon),
    lineIds: asStringArray(r.lineIds),
    isInterchange: r.isInterchange === true,
    isAccessible: r.isAccessible === true,
    sequenceByLine,
  };
}

function readSegment(value: unknown): NetworkSegment | null {
  const r = asRecord(value);
  const id = asString(r.id);
  const lineId = asString(r.lineId);
  if (!id || !lineId) return null;
  return {
    id,
    lineId,
    fromStationId: asString(r.fromStationId),
    toStationId: asString(r.toStationId),
    fromSequence: asNumber(r.fromSequence),
    toSequence: asNumber(r.toSequence),
    scheduledRunSeconds: asNumber(r.scheduledRunSeconds, 120),
    scheduledDwellSeconds: asNumber(r.scheduledDwellSeconds, 18),
    lengthMeters: asNumber(r.lengthMeters),
  };
}

/** Coerce the committed snapshot JSON into a validated `SnapshotShape`. */
export function parseSnapshot(value: unknown): SnapshotShape {
  const r = asRecord(value);
  return {
    generatedAt: asString(r.generatedAt),
    generatedFrom: asString(r.generatedFrom),
    warnings: asStringArray(r.warnings),
    lines: (Array.isArray(r.lines) ? r.lines : [])
      .map(readLine)
      .filter((x): x is NetworkLine => x !== null),
    stations: (Array.isArray(r.stations) ? r.stations : [])
      .map(readStation)
      .filter((x): x is NetworkStation => x !== null),
    segments: (Array.isArray(r.segments) ? r.segments : [])
      .map(readSegment)
      .filter((x): x is NetworkSegment => x !== null),
  };
}

/* ------------------------------------------------------------------ *
 * Loaders
 * ------------------------------------------------------------------ */

/** Rehydrate the Map-based lookup tables that the pure builder produces. */
export function indexFromSnapshot(snap: SnapshotShape): NetworkIndex {
  const segmentsByLine = new Map<LineId, NetworkSegment[]>();
  const segmentsByLineStation = new Map<string, NetworkSegment[]>();
  for (const seg of snap.segments) {
    const list = segmentsByLine.get(seg.lineId);
    if (list) list.push(seg);
    else segmentsByLine.set(seg.lineId, [seg]);
    for (const stationId of [seg.fromStationId, seg.toStationId]) {
      const key = `${seg.lineId}|${stationId}`;
      const l = segmentsByLineStation.get(key);
      if (l) l.push(seg);
      else segmentsByLineStation.set(key, [seg]);
    }
  }
  for (const list of segmentsByLine.values()) {
    list.sort((a, b) => a.fromSequence - b.fromSequence || a.id.localeCompare(b.id));
  }
  return {
    lines: snap.lines,
    stations: snap.stations,
    segments: snap.segments,
    stationById: new Map<StationId, NetworkStation>(snap.stations.map((s) => [s.id, s])),
    lineById: new Map<LineId, NetworkLine>(snap.lines.map((l) => [l.id, l])),
    segmentById: new Map<SegmentId, NetworkSegment>(snap.segments.map((s) => [s.id, s])),
    segmentsByLine,
    segmentsByLineStation,
    warnings: snap.warnings,
  };
}

/** The committed, offline snapshot. Import-safe on the client and in Workers. */
export function loadBundledNetworkIndex(): NetworkIndex {
  return indexFromSnapshot(parseSnapshot(snapshotJson));
}

/** Read the real GTFS feed from disk. Node-only; never used on the demo path. */
export async function loadNetworkIndexFromGtfs(
  gtfsDir: string = DEFAULT_GTFS_DIR,
): Promise<NetworkIndex> {
  const dir = path.isAbsolute(gtfsDir) ? gtfsDir : path.join(process.cwd(), gtfsDir);
  const read = (f: string) => readFile(path.join(dir, f), "utf8");
  const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt] = await Promise.all([
    read("stops.txt"),
    read("routes.txt"),
    read("trips.txt"),
    read("stop_times.txt"),
  ]);
  return buildNetworkIndex({
    stops: parseStops(stopsTxt),
    routes: parseRoutes(routesTxt),
    trips: parseTrips(tripsTxt),
    stopTimes: parseStopTimes(stopTimesTxt),
  });
}

/** Strip the runtime Maps so the index can be written as a committed fixture. */
export function snapshotFromIndex(index: NetworkIndex, generatedAt: string): SnapshotShape {
  return {
    generatedAt,
    generatedFrom: DEFAULT_GTFS_DIR,
    warnings: index.warnings,
    lines: index.lines,
    stations: index.stations,
    segments: index.segments,
  };
}
