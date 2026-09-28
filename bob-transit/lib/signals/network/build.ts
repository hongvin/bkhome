/**
 * Builds the signal pipeline's own station/line/segment index from the raw GTFS
 * rows. Self-contained on purpose: S1 owns `lib/gtfs/**`, and S3 must not depend
 * on it (the two modules are built in parallel).
 *
 * Directional segments are the unit of risk in this product, so every segment is
 * emitted in BOTH directions (`KJ:KLCC->AMPANG PARK` and `KJ:AMPANG PARK->KLCC`).
 * The `SegmentId` format matches the frozen contract helper `makeSegmentId`.
 */

import type { LineId, SegmentId, StationId, TransitMode } from "@/lib/contracts";
import { makeSegmentId } from "@/lib/contracts";
import {
  type CanonicalLineId,
  type GtfsRouteRow,
  type GtfsStopRow,
  type GtfsStopTimeRow,
  type GtfsTripRow,
  toCanonicalLineId,
} from "./parse";

export interface NetworkStation {
  id: StationId;
  name: string;
  nameMs: string;
  lat: number;
  lon: number;
  lineIds: LineId[];
  isInterchange: boolean;
  isAccessible: boolean;
  /** stop_sequence of this station along each of its lines (lineId -> sequence). */
  sequenceByLine: Record<LineId, number>;
}

export interface NetworkLine {
  id: LineId;
  shortName: string;
  longName: string;
  longNameMs: string;
  color: string;
  mode: TransitMode;
}

export interface NetworkSegment {
  id: SegmentId;
  lineId: LineId;
  fromStationId: StationId;
  toStationId: StationId;
  fromSequence: number;
  toSequence: number;
  scheduledRunSeconds: number;
  scheduledDwellSeconds: number;
  lengthMeters: number;
}

export interface NetworkIndex {
  lines: NetworkLine[];
  stations: NetworkStation[];
  segments: NetworkSegment[];
  stationById: Map<StationId, NetworkStation>;
  lineById: Map<LineId, NetworkLine>;
  segmentById: Map<SegmentId, NetworkSegment>;
  segmentsByLine: Map<LineId, NetworkSegment[]>;
  /** Stations reachable from a station on one line, keyed `${lineId}|${stationId}`. */
  segmentsByLineStation: Map<string, NetworkSegment[]>;
  /** Human-readable record of feed problems handled without throwing. */
  warnings: string[];
}

const MODE_BY_CATEGORY: Readonly<Record<string, TransitMode>> = {
  LRT: "LRT",
  MRT: "MRT",
  MRL: "MRL",
  BRT: "BRT",
  KTM: "KTM",
  BUS: "BUS",
};

/** Malay display names for the eight Klang Valley lines. */
const LINE_NAME_MS: Readonly<Record<string, string>> = {
  AG: "Laluan LRT Ampang",
  KJ: "Laluan LRT Kelana Jaya",
  PH: "Laluan LRT Sri Petaling",
  KGL: "Laluan MRT Kajang",
  PYL: "Laluan MRT Putrajaya",
  MR: "Laluan Monorel Kuala Lumpur",
  BRT: "Laluan BRT Sunway",
  SA: "Laluan LRT Shah Alam",
};

/** Deterministic fallback order when stop_times cannot supply a pattern. */
function numericSuffix(stopId: string): number {
  const m = /(\d+)\s*$/.exec(stopId);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))));
}

export interface BuildNetworkInput {
  stops: GtfsStopRow[];
  routes: GtfsRouteRow[];
  trips: GtfsTripRow[];
  stopTimes: GtfsStopTimeRow[];
}

export function buildNetworkIndex(input: BuildNetworkInput): NetworkIndex {
  const warnings: string[] = [];

  /* ---------- lines ---------- */
  const lines: NetworkLine[] = input.routes.map((r) => ({
    id: r.routeId,
    shortName: r.shortName,
    longName: r.longName,
    longNameMs: LINE_NAME_MS[r.routeId] ?? r.longName,
    color: r.color,
    mode: MODE_BY_CATEGORY[r.category] ?? "LRT",
  }));
  const lineById = new Map(lines.map((l) => [l.id, l]));

  /* ---------- stations ---------- */
  // stops.txt is one row per platform. Two rows at the same place on different
  // lines are separate StationIds (KJ13 / SP7 / AG7 are all Masjid Jamek).
  const stationById = new Map<StationId, NetworkStation>();
  const linesByStation = new Map<StationId, Set<LineId>>();
  for (const s of input.stops) {
    const lineId = toCanonicalLineId(s.rawRouteId);
    if (!lineId) {
      warnings.push(`stops.txt: unmapped route_id "${s.rawRouteId}" for ${s.stopId}`);
      continue;
    }
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) {
      warnings.push(`stops.txt: bad coordinates for ${s.stopId}`);
      continue;
    }
    if (stationById.has(s.stopId)) {
      warnings.push(`stops.txt: duplicate stop_id ${s.stopId}`);
      continue;
    }
    stationById.set(s.stopId, {
      id: s.stopId,
      name: s.stopName,
      nameMs: s.stopName,
      lat: s.lat,
      lon: s.lon,
      lineIds: [lineId],
      isInterchange: false,
      isAccessible: s.isOku,
      sequenceByLine: {},
    });
    linesByStation.set(s.stopId, new Set([lineId]));
  }

  /* ---------- ordering: prefer stop_times, fall back to stop_id order ---------- */
  const tripById = new Map(input.trips.map((t) => [t.tripId, t]));
  const orderByLineDirection = new Map<string, string[]>();
  const dwellByLineStation = new Map<string, number[]>();
  const runByLinePair = new Map<string, number[]>();

  const byTrip = new Map<string, GtfsStopTimeRow[]>();
  for (const st of input.stopTimes) {
    const list = byTrip.get(st.tripId);
    if (list) list.push(st);
    else byTrip.set(st.tripId, [st]);
  }

  for (const [tripId, rows] of byTrip) {
    const trip = tripById.get(tripId);
    if (!trip) {
      warnings.push(`stop_times.txt: trip_id ${tripId} has no row in trips.txt`);
      continue;
    }
    const ordered = [...rows].sort((a, b) => a.stopSequence - b.stopSequence);
    const key = `${trip.routeId}|${trip.directionId}`;
    if (!orderByLineDirection.has(key)) {
      orderByLineDirection.set(
        key,
        ordered.map((r) => r.stopId),
      );
    }
    for (let i = 0; i < ordered.length; i += 1) {
      const cur = ordered[i];
      const dwell = cur.departureSeconds - cur.arrivalSeconds;
      if (Number.isFinite(dwell) && dwell >= 0) {
        const dk = `${trip.routeId}|${cur.stopId}`;
        const arr = dwellByLineStation.get(dk);
        if (arr) arr.push(dwell);
        else dwellByLineStation.set(dk, [dwell]);
      }
      const next = ordered[i + 1];
      if (next) {
        const run = next.arrivalSeconds - cur.departureSeconds;
        if (Number.isFinite(run) && run >= 0) {
          const rk = `${trip.routeId}|${cur.stopId}|${next.stopId}`;
          const arr = runByLinePair.get(rk);
          if (arr) arr.push(run);
          else runByLinePair.set(rk, [run]);
        }
      }
    }
  }

  const average = (values: number[] | undefined, fallback: number): number => {
    if (!values || values.length === 0) return fallback;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  };

  const sequenceFor = (lineId: LineId, direction: 0 | 1, stopId: string): number => {
    const ids = orderByLineDirection.get(`${lineId}|${direction}`);
    if (ids) {
      const idx = ids.indexOf(stopId);
      if (idx >= 0) return idx + 1;
    }
    // Fallback: the feed's stop_ids are numbered along the line in stops.txt order.
    const station = stationById.get(stopId);
    if (station) {
      const fallbackIds = input.stops
        .filter((s) => toCanonicalLineId(s.rawRouteId) === lineId)
        .map((s) => s.stopId);
      const idx = fallbackIds.indexOf(stopId);
      if (idx >= 0) return idx + 1;
    }
    return numericSuffix(stopId);
  };

  /* ---------- segments (both directions) ---------- */
  const segments: NetworkSegment[] = [];
  const seen = new Set<SegmentId>();
  const lineIdsInFeed = new Set<LineId>([
    ...input.routes.map((r) => r.routeId),
    ...input.stops.map((s) => toCanonicalLineId(s.rawRouteId)).filter((x): x is LineId => !!x),
  ]);

  for (const lineId of lineIdsInFeed) {
    const direction0 = orderByLineDirection.get(`${lineId}|0`);
    const direction1 = orderByLineDirection.get(`${lineId}|1`);
    let patterns: string[][] = [];
    if (direction0 && direction1) {
      patterns = [direction0, direction1];
    } else if (direction0) {
      warnings.push(`${lineId}: only direction 0 present in stop_times; reversing it`);
      patterns = [direction0, [...direction0].reverse()];
    } else {
      // Graceful degradation: no stop_times for this line at all.
      const fallback = input.stops
        .filter((s) => toCanonicalLineId(s.rawRouteId) === lineId)
        .map((s) => s.stopId)
        .sort((a, b) => numericSuffix(a) - numericSuffix(b));
      if (fallback.length === 0) continue;
      warnings.push(`${lineId}: no stop_times rows; ordering segments from stops.txt`);
      patterns = [fallback, [...fallback].reverse()];
    }

    for (let p = 0; p < patterns.length; p += 1) {
      const pattern = patterns[p];
      const direction = (p === 0 ? 0 : 1) as 0 | 1;
      for (let i = 0; i < pattern.length - 1; i += 1) {
        const fromStationId = pattern[i];
        const toStationId = pattern[i + 1];
        const segmentId = makeSegmentId(lineId, fromStationId, toStationId);
        if (seen.has(segmentId)) continue;
        const from = stationById.get(fromStationId);
        const to = stationById.get(toStationId);
        if (!from || !to) {
          warnings.push(`${lineId}: segment references unknown stop ${fromStationId}->${toStationId}`);
          continue;
        }
        seen.add(segmentId);
        segments.push({
          id: segmentId,
          lineId,
          fromStationId,
          toStationId,
          fromSequence: sequenceFor(lineId, direction, fromStationId),
          toSequence: sequenceFor(lineId, direction, toStationId),
          scheduledRunSeconds: average(
            runByLinePair.get(`${lineId}|${fromStationId}|${toStationId}`),
            average(runByLinePair.get(`${lineId}|${toStationId}|${fromStationId}`), 120),
          ),
          scheduledDwellSeconds: average(dwellByLineStation.get(`${lineId}|${toStationId}`), 18),
          lengthMeters: haversineMeters(from.lat, from.lon, to.lat, to.lon),
        });
      }
    }
  }

  // Fill in per-line sequence numbers on stations.
  for (const seg of segments) {
    const from = stationById.get(seg.fromStationId);
    const to = stationById.get(seg.toStationId);
    if (from) from.sequenceByLine[seg.lineId] = seg.fromSequence;
    if (to) to.sequenceByLine[seg.lineId] = seg.toSequence;
  }

  /* ---------- interchange flags (same place, different lines) ---------- */
  const stations = [...stationById.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const st of stations) {
    const samePlace = stations.filter(
      (o) =>
        o.id !== st.id &&
        (o.name.toUpperCase() === st.name.toUpperCase() ||
          haversineMeters(o.lat, o.lon, st.lat, st.lon) <= 250),
    );
    const lineIds = new Set<LineId>([st.lineIds[0]]);
    for (const o of samePlace) for (const l of o.lineIds) lineIds.add(l);
    st.lineIds = [...lineIds].sort();
    st.isInterchange = st.lineIds.length > 1;
  }

  const segmentsByLine = new Map<LineId, NetworkSegment[]>();
  const segmentsByLineStation = new Map<string, NetworkSegment[]>();
  for (const seg of segments) {
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

  // Only report lines that actually made it into the index.
  for (const lineId of lineIdsInFeed) {
    if (!lineById.has(lineId)) warnings.push(`line ${lineId} appears in stops but not routes.txt`);
  }

  return {
    lines,
    stations,
    segments,
    stationById,
    lineById,
    segmentById: new Map(segments.map((s) => [s.id, s])),
    segmentsByLine,
    segmentsByLineStation,
    warnings,
  };
}

/** Every line id that can appear in the index, canonical by construction. */
export function canonicalLineIds(index: NetworkIndex): CanonicalLineId[] {
  return index.lines.map((l) => l.id).filter((id): id is CanonicalLineId => toCanonicalLineId(id) !== null);
}
