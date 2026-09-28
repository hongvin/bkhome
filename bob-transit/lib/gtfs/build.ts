/**
 * Build the frozen `TransitGraph` from a parsed GTFS static feed.
 *
 * Shape of the pipeline:
 *   stops/routes/trips/stop_times/shapes -> Lines, Stations, directional Segments
 *   frequencies.txt                       -> concrete Connection[] (CSA needs these)
 *   stations                              -> interchange footpaths (derived, not stored)
 *
 * The feed is FREQUENCY-BASED: `trips.txt` holds 48 templates (8 lines x 2
 * directions x 3 service patterns) and `frequencies.txt` holds headways. Each
 * headway row is expanded into concrete departures, and each departure into one
 * `Connection` per stop-to-stop hop.
 *
 * `Connection.tripId` is the *concrete departure instance*
 * (`"<templateTripId>#<firstDepartureSeconds>"`), not the template id, because
 * CSA infers "the rider stayed on the same vehicle" from a repeated tripId.
 * Two departures of the same template are different trains and must not be
 * merged into one ride leg.
 */

import type {
  Connection,
  FrequencyTemplate,
  LatLng,
  Line,
  LineId,
  Segment,
  SegmentId,
  ServiceCalendar,
  Station,
  TransitGraph,
} from "@/lib/contracts";
import { CONTRACTS_VERSION, TZ_NAME, makeSegmentId } from "@/lib/contracts";
import type { GtfsFrequencyRow, GtfsShapePoint, GtfsStopTimeRow, RawGtfsFeed } from "./raw";
import {
  normalizeDisplayName,
  normalizeLineId,
  toTransitMode,
} from "./normalize";
import { nearestShapeIndex, polylineLengthMeters } from "./geo";
import { computeInterchanges } from "./interchange";

export interface BuildTransitGraphOptions {
  /** ISO timestamp recorded as `TransitGraph.builtAt`. Defaults to now. */
  builtAt?: string;
  /** Safety valve for a malformed frequencies row. */
  maxDeparturesPerFrequencyRow?: number;
}

interface TripMeta {
  tripId: string;
  lineId: LineId;
  serviceId: string;
  directionId: number;
  shapeId: string;
}

function toLatLng(lat: number, lon: number): LatLng {
  return { lat, lon };
}

export function buildTransitGraph(
  feed: RawGtfsFeed,
  options: BuildTransitGraphOptions = {},
): TransitGraph {
  const warnings: string[] = [];
  const builtAt = options.builtAt ?? new Date().toISOString();
  const maxDepartures = options.maxDeparturesPerFrequencyRow ?? 2000;

  /* ------------------------------- lines ------------------------------- */

  const lineById = new Map<LineId, Line>();
  for (const r of feed.routes) {
    const id = normalizeLineId(r.routeId);
    if (id === null) {
      warnings.push(
        `routes.txt: route_id "${r.routeId}" does not map to a canonical line id; line skipped.`,
      );
      continue;
    }
    if (lineById.has(id)) continue;
    const longName = r.longName || r.shortName || id;
    lineById.set(id, {
      id,
      shortName: r.shortName || id,
      longName,
      // The feed ships no Bahasa Malaysia names, so the contract's fallback applies.
      longNameMs: longName,
      color: (r.color || "000000").toLowerCase(),
      mode: toTransitMode(r.category, r.routeType, id),
    });
  }
  const lines = [...lineById.values()].sort((a, b) => a.id.localeCompare(b.id));

  /* ------------------------------- trips ------------------------------- */

  const tripById = new Map<string, TripMeta>();
  for (const t of feed.trips) {
    const lineId = normalizeLineId(t.routeId);
    if (lineId === null) {
      warnings.push(
        `trips.txt: trip "${t.tripId}" has unmappable route_id "${t.routeId}"; trip skipped.`,
      );
      continue;
    }
    tripById.set(t.tripId, {
      tripId: t.tripId,
      lineId,
      serviceId: t.serviceId,
      directionId: t.directionId,
      shapeId: t.shapeId,
    });
  }

  /* ---------------------------- stop_times ----------------------------- */

  const stopTimesByTrip = new Map<string, GtfsStopTimeRow[]>();
  for (const st of feed.stopTimes) {
    const list = stopTimesByTrip.get(st.tripId);
    if (list) list.push(st);
    else stopTimesByTrip.set(st.tripId, [st]);
  }
  for (const list of stopTimesByTrip.values()) {
    list.sort((a, b) => a.stopSequence - b.stopSequence);
  }

  /* ------------------------------ shapes ------------------------------- */

  const shapePointsById = new Map<string, GtfsShapePoint[]>();
  for (const p of feed.shapes) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const list = shapePointsById.get(p.shapeId);
    if (list) list.push(p);
    else shapePointsById.set(p.shapeId, [p]);
  }
  const shapeByShapeId = new Map<string, LatLng[]>();
  for (const [shapeId, points] of shapePointsById) {
    points.sort((a, b) => a.sequence - b.sequence);
    shapeByShapeId.set(
      shapeId,
      points.map((p) => toLatLng(p.lat, p.lon)),
    );
  }

  /* ----------------------------- stations ------------------------------ */

  // Authoritative line membership comes from stop_times -> trips -> route_id,
  // never from stops.route_id (which calls the Kajang line "MRT").
  const linesByStop = new Map<string, Set<LineId>>();
  for (const [tripId, times] of stopTimesByTrip) {
    const meta = tripById.get(tripId);
    if (!meta) continue;
    for (const t of times) {
      const set = linesByStop.get(t.stopId);
      if (set) set.add(meta.lineId);
      else linesByStop.set(t.stopId, new Set([meta.lineId]));
    }
  }

  const stations: Station[] = [];
  const stationById = new Map<string, Station>();
  for (const s of feed.stops) {
    if (!s.stopId) continue;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) {
      warnings.push(`stops.txt: stop "${s.stopId}" has no usable coordinates; station skipped.`);
      continue;
    }
    const used = linesByStop.get(s.stopId);
    const fallback = normalizeLineId(s.routeId);
    const lineIds: LineId[] =
      used && used.size > 0 ? [...used].sort() : fallback !== null ? [fallback] : [];
    if (lineIds.length === 0) {
      warnings.push(`stops.txt: stop "${s.stopId}" is not served by any trip and has no line.`);
    }
    const name = normalizeDisplayName(s.stopName);
    const station: Station = {
      id: s.stopId,
      name,
      // No localised (Bahasa Malaysia) names exist in this feed.
      nameMs: name,
      lat: s.lat,
      lon: s.lon,
      lineIds,
      isInterchange: false,
      isAccessible: s.isOku,
    };
    stations.push(station);
    stationById.set(station.id, station);
  }
  stations.sort((a, b) => a.id.localeCompare(b.id));

  /* ----------------------------- segments ------------------------------ */

  const segmentById = new Map<SegmentId, Segment>();
  for (const [tripId, times] of stopTimesByTrip) {
    const meta = tripById.get(tripId);
    if (!meta || times.length < 2) continue;
    const shape = meta.shapeId ? shapeByShapeId.get(meta.shapeId) : undefined;

    // Assign each stop to a shape point, monotonically, so the polyline slice
    // between two consecutive stops cannot run backwards.
    const shapeIndexAtStop: number[] = [];
    let cursor = 0;
    for (const t of times) {
      const station = stationById.get(t.stopId);
      if (!shape || !station) {
        shapeIndexAtStop.push(-1);
        continue;
      }
      const idx = nearestShapeIndex(shape, toLatLng(station.lat, station.lon), cursor);
      cursor = idx;
      shapeIndexAtStop.push(idx);
    }

    for (let i = 0; i + 1 < times.length; i += 1) {
      const from = times[i];
      const to = times[i + 1];
      const fromStation = stationById.get(from.stopId);
      const toStation = stationById.get(to.stopId);
      if (!fromStation || !toStation) continue;
      const id = makeSegmentId(meta.lineId, from.stopId, to.stopId);
      if (segmentById.has(id)) continue;

      const runSeconds = to.arrivalTime - from.departureTime;
      if (!Number.isFinite(runSeconds) || runSeconds <= 0) {
        warnings.push(
          `segment "${id}" has a non-positive scheduled run time (${runSeconds}s); clamped to 1s.`,
        );
      }
      const dwellSeconds = to.departureTime - to.arrivalTime;

      const i0 = shapeIndexAtStop[i];
      const i1 = shapeIndexAtStop[i + 1];
      const start = toLatLng(fromStation.lat, fromStation.lon);
      const end = toLatLng(toStation.lat, toStation.lon);
      const shapePoints: LatLng[] =
        shape && i0 >= 0 && i1 > i0
          ? [start, ...shape.slice(i0 + 1, i1), end]
          : [start, end];

      segmentById.set(id, {
        id,
        lineId: meta.lineId,
        fromStationId: from.stopId,
        toStationId: to.stopId,
        fromSequence: from.stopSequence,
        toSequence: to.stopSequence,
        scheduledRunSeconds: Math.max(1, Math.round(runSeconds)),
        scheduledDwellSeconds: Math.max(0, Math.round(Number.isFinite(dwellSeconds) ? dwellSeconds : 0)),
        shape: shapePoints,
        lengthMeters: Math.round(polylineLengthMeters(shapePoints)),
      });
    }
  }
  const segments = [...segmentById.values()].sort((a, b) => a.id.localeCompare(b.id));

  /* --------------------- frequencies + connections --------------------- */

  const frequencyRowsByTrip = new Map<string, GtfsFrequencyRow[]>();
  for (const f of feed.frequencies) {
    if (!Number.isFinite(f.startTime) || !Number.isFinite(f.endTime)) {
      warnings.push(`frequencies.txt: trip "${f.tripId}" has an unparseable start/end time; row skipped.`);
      continue;
    }
    const list = frequencyRowsByTrip.get(f.tripId);
    if (list) list.push(f);
    else frequencyRowsByTrip.set(f.tripId, [f]);
  }

  const frequencies: FrequencyTemplate[] = [];
  for (const [tripId, rows] of frequencyRowsByTrip) {
    const meta = tripById.get(tripId);
    if (!meta) {
      warnings.push(
        `frequencies.txt: trip "${tripId}" is not present in trips.txt; headway rows ignored.`,
      );
      continue;
    }
    for (const row of rows) {
      frequencies.push({
        tripId,
        serviceId: meta.serviceId,
        lineId: meta.lineId,
        startTime: row.startTime,
        endTime: row.endTime,
        headwaySeconds: row.headwaySeconds,
      });
    }
  }
  frequencies.sort(
    (a, b) =>
      a.tripId.localeCompare(b.tripId) ||
      a.startTime - b.startTime ||
      a.headwaySeconds - b.headwaySeconds,
  );

  const connections: Connection[] = [];
  for (const [tripId, times] of stopTimesByTrip) {
    const meta = tripById.get(tripId);
    if (!meta) continue;
    if (times.length < 2) {
      warnings.push(`trips.txt: trip "${tripId}" has fewer than 2 stop_times; not expanded.`);
      continue;
    }
    const rows = frequencyRowsByTrip.get(tripId);
    if (!rows || rows.length === 0) {
      warnings.push(
        `trips.txt: trip "${tripId}" has a stop pattern but no frequencies.txt headway; not expanded into connections.`,
      );
      continue;
    }
    const templateOriginDeparture = times[0].departureTime;
    for (const row of rows) {
      if (!Number.isFinite(row.headwaySeconds) || row.headwaySeconds <= 0) {
        warnings.push(
          `frequencies.txt: trip "${tripId}" has a non-positive headway (${row.headwaySeconds}); row skipped.`,
        );
        continue;
      }
      let departures = 0;
      for (let t = row.startTime; t < row.endTime; t += row.headwaySeconds) {
        if (departures >= maxDepartures) {
          warnings.push(
            `frequencies.txt: trip "${tripId}" produced more than ${maxDepartures} departures in one row; expansion truncated.`,
          );
          break;
        }
        departures += 1;
        const offset = t - templateOriginDeparture;
        const instanceTripId = `${tripId}#${t}`;
        for (let i = 0; i + 1 < times.length; i += 1) {
          const a = times[i];
          const b = times[i + 1];
          connections.push({
            tripId: instanceTripId,
            lineId: meta.lineId,
            serviceId: meta.serviceId,
            fromStationId: a.stopId,
            toStationId: b.stopId,
            segmentId: makeSegmentId(meta.lineId, a.stopId, b.stopId),
            departureTime: a.departureTime + offset,
            arrivalTime: b.arrivalTime + offset,
          });
        }
      }
    }
  }

  // CSA requires this exact ordering.
  connections.sort(
    (a, b) =>
      a.departureTime - b.departureTime ||
      a.arrivalTime - b.arrivalTime ||
      a.segmentId.localeCompare(b.segmentId) ||
      a.tripId.localeCompare(b.tripId),
  );

  /* ---------------------------- interchanges --------------------------- */

  const topology = computeInterchanges(stations);
  const interchangeStationIds = new Set<string>();
  for (const group of topology.groups) {
    for (const id of group.stationIds) interchangeStationIds.add(id);
  }
  for (const station of stations) {
    station.isInterchange = interchangeStationIds.has(station.id);
  }

  /* ------------------------------ services ----------------------------- */

  const services: ServiceCalendar[] = feed.calendar
    .map((c) => ({
      serviceId: c.serviceId,
      weekdays: [...c.weekdays],
      startDate: c.startDate,
      endDate: c.endDate,
    }))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId));

  /* ------------------------------- stats ------------------------------- */

  const serviceDayCount = new Set(connections.map((c) => c.serviceId)).size;

  if (feed.stops.length > 0 && feed.stops.every((s) => s.category !== "")) {
    warnings.push(
      "stops.txt `geometry` column ignored: it contains the literal string \"[object Object]\" for every stop; segment polylines are derived from shapes.txt instead.",
    );
  }

  return {
    contractsVersion: CONTRACTS_VERSION,
    builtAt,
    timezone: TZ_NAME,
    lines,
    stations,
    segments,
    services,
    frequencies,
    connections,
    stats: {
      stationCount: stations.length,
      lineCount: lines.length,
      segmentCount: segments.length,
      connectionCount: connections.length,
      serviceDayCount,
    },
    warnings,
  };
}
