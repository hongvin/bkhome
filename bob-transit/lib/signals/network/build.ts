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

/**
 * Interchanges whose two platforms have DIFFERENT names AND sit further apart
 * than the proximity threshold, so neither the name rule nor the distance rule
 * catches them. Verified against the real network; this list is deliberately
 * tiny and explicit rather than a loosened threshold that would silently merge
 * genuinely separate stations (e.g. KL Sentral with Muzium Negara, 344 m).
 */
export const CURATED_PLACE_LINKS: ReadonlyArray<readonly [string, string]> = [
  // Kelana Jaya Line <-> KL Monorail: Dang Wangi and Bukit Nanas, one interchange.
  ["KJ12", "MR8"],
];

/** Two platforms closer than this are treated as one physical place. */
export const SAME_PLACE_RADIUS_METERS = 250;

/** A physical station: every platform id that shares one location. */
export interface PhysicalPlace {
  key: string;
  name: string;
  stationIds: StationId[];
  lineIds: LineId[];
  lat: number;
  lon: number;
}

/**
 * Collapse platform-level StationIds into physical places.
 *
 * Same normalised name OR within `SAME_PLACE_RADIUS_METERS` OR an explicit
 * curated link counts as one place. This is what makes "Masjid Jamek" resolve to
 * KJ13 + SP7 + AG7 as a single, unambiguous place, while a name that matches
 * genuinely different stations stays ambiguous.
 */
export function buildPlaces(stations: NetworkStation[]): PhysicalPlace[] {
  const parent = new Map<StationId, StationId>();
  const find = (x: StationId): StationId => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as StationId;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as StationId;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: StationId, b: StationId) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const st of stations) parent.set(st.id, st.id);

  const byName = new Map<string, StationId[]>();
  for (const st of stations) {
    const key = st.name.toUpperCase().replace(/\s+/g, " ").trim();
    const list = byName.get(key);
    if (list) list.push(st.id);
    else byName.set(key, [st.id]);
  }
  for (const ids of byName.values()) {
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i]);
  }
  for (const [a, b] of CURATED_PLACE_LINKS) {
    if (parent.has(a) && parent.has(b)) union(a, b);
  }
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      if (find(stations[i].id) === find(stations[j].id)) continue;
      if (
        haversineMeters(stations[i].lat, stations[i].lon, stations[j].lat, stations[j].lon) <=
        SAME_PLACE_RADIUS_METERS
      ) {
        union(stations[i].id, stations[j].id);
      }
    }
  }

  const groups = new Map<StationId, NetworkStation[]>();
  for (const st of stations) {
    const root = find(st.id);
    const list = groups.get(root);
    if (list) list.push(st);
    else groups.set(root, [st]);
  }
  const places: PhysicalPlace[] = [];
  for (const members of groups.values()) {
    const lineIds = new Set<LineId>();
    for (const m of members) for (const l of m.lineIds) lineIds.add(l);
    const longest = [...members].sort((a, b) => b.name.length - a.name.length)[0];
    places.push({
      key: `PLACE:${longest.name.toUpperCase().replace(/\s+/g, " ").trim()}`,
      name: longest.name,
      stationIds: members.map((m) => m.id).sort(),
      lineIds: [...lineIds].sort(),
      lat: members[0].lat,
      lon: members[0].lon,
    });
  }
  return places.sort((a, b) => a.key.localeCompare(b.key));
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
  for (const place of buildPlaces(stations)) {
    for (const stationId of place.stationIds) {
      const st = stationById.get(stationId);
      if (!st) continue;
      st.lineIds = [...place.lineIds].filter((l) => lineById.has(l)).sort();
      st.isInterchange = st.lineIds.length > 1;
    }
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
