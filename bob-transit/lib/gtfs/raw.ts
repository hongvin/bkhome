/**
 * Raw GTFS row shapes for `data/gtfs-static/rapid-rail-kl/*.txt`, plus the
 * record -> typed-row mappers.
 *
 * IMPORTANT DATA FACT (verified against the committed fixture):
 * `route_id` is NOT consistent across files.
 *   routes.txt     : AG KJ PH KGL PYL MR BRT SA
 *   trips.txt      : AG BRT KGL KJ MR PH PYL SA          (canonical)
 *   stops.txt      : AG BRT KJ MR MRT PH PYL SA          (Kajang line is "MRT")
 *   stop_times.txt : AGL BRT KGL KJL MRL PYL SAL SPL     (long names, SPL = PH)
 * Therefore: the ONLY trustworthy line identity is `trips.route_id`, reached by
 * joining `stop_times.trip_id` -> `trips.trip_id`. Never join on
 * `stop_times.route_id` or `stops.route_id`; normalise them instead (normalize.ts).
 */

import { parseGtfsTime } from "./normalize";

export interface GtfsStopRow {
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  category: string;
  routeId: string;
  isOku: boolean;
  status: string;
}

export interface GtfsRouteRow {
  routeId: string;
  shortName: string;
  longName: string;
  routeType: number;
  color: string;
  category: string;
  status: string;
}

export interface GtfsTripRow {
  routeId: string;
  serviceId: string;
  tripId: string;
  directionId: number;
  shapeId: string;
}

export interface GtfsStopTimeRow {
  tripId: string;
  arrivalTime: number;
  departureTime: number;
  stopId: string;
  stopSequence: number;
  /** True when GTFS left the arrival/departure blank and we carried the previous value. */
  interpolated: boolean;
}

export interface GtfsFrequencyRow {
  tripId: string;
  startTime: number;
  endTime: number;
  headwaySeconds: number;
}

export interface GtfsCalendarRow {
  serviceId: string;
  weekdays: boolean[];
  startDate: string;
  endDate: string;
}

export interface GtfsShapePoint {
  shapeId: string;
  lat: number;
  lon: number;
  sequence: number;
}

/** Everything the graph builder needs, typed, in memory. */
export interface RawGtfsFeed {
  stops: GtfsStopRow[];
  routes: GtfsRouteRow[];
  trips: GtfsTripRow[];
  stopTimes: GtfsStopTimeRow[];
  frequencies: GtfsFrequencyRow[];
  calendar: GtfsCalendarRow[];
  shapes: GtfsShapePoint[];
}

function num(value: string | undefined, fallback = 0): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function toStopRow(r: Record<string, string>): GtfsStopRow {
  return {
    stopId: r.stop_id ?? "",
    stopName: r.stop_name ?? "",
    lat: num(r.stop_lat, Number.NaN),
    lon: num(r.stop_lon, Number.NaN),
    category: r.category ?? "",
    routeId: r.route_id ?? "",
    isOku: bool(r.isOKU),
    status: r.status ?? "",
  };
}

export function toRouteRow(r: Record<string, string>): GtfsRouteRow {
  return {
    routeId: r.route_id ?? "",
    shortName: r.route_short_name ?? "",
    longName: r.route_long_name ?? "",
    routeType: num(r.route_type, 1),
    color: (r.route_color ?? "").replace(/^#/, ""),
    category: r.category ?? "",
    status: r.status ?? "",
  };
}

export function toTripRow(r: Record<string, string>): GtfsTripRow {
  return {
    routeId: r.route_id ?? "",
    serviceId: r.service_id ?? "",
    tripId: r.trip_id ?? "",
    directionId: num(r.direction_id, 0),
    shapeId: r.shape_id ?? "",
  };
}

export function toFrequencyRow(r: Record<string, string>): GtfsFrequencyRow {
  return {
    tripId: r.trip_id ?? "",
    startTime: parseGtfsTime(r.start_time ?? "") ?? Number.NaN,
    endTime: parseGtfsTime(r.end_time ?? "") ?? Number.NaN,
    headwaySeconds: num(r.headway_secs, 0),
  };
}

export function toStopTimeRow(r: Record<string, string>): GtfsStopTimeRow {
  const arrival = parseGtfsTime(r.arrival_time ?? "");
  const departure = parseGtfsTime(r.departure_time ?? "");
  return {
    tripId: r.trip_id ?? "",
    arrivalTime: arrival ?? Number.NaN,
    departureTime: departure ?? Number.NaN,
    stopId: r.stop_id ?? "",
    stopSequence: num(r.stop_sequence, 0),
    interpolated: arrival === null || departure === null,
  };
}

export function toCalendarRow(r: Record<string, string>): GtfsCalendarRow {
  // Contract order is JS Date#getDay(): 0 = Sunday.
  return {
    serviceId: r.service_id ?? "",
    weekdays: [
      bool(r.sunday),
      bool(r.monday),
      bool(r.tuesday),
      bool(r.wednesday),
      bool(r.thursday),
      bool(r.friday),
      bool(r.saturday),
    ],
    startDate: r.start_date ?? "",
    endDate: r.end_date ?? "",
  };
}

export function toShapePoint(r: Record<string, string>): GtfsShapePoint {
  return {
    shapeId: r.shape_id ?? "",
    lat: num(r.shape_pt_lat, Number.NaN),
    lon: num(r.shape_pt_lon, Number.NaN),
    sequence: num(r.shape_pt_sequence, 0),
  };
}

/** Guard used by the loader and by tests. */
export function isRawGtfsFeed(value: RawGtfsFeed): boolean {
  return (
    Array.isArray(value.stops) &&
    Array.isArray(value.routes) &&
    Array.isArray(value.trips) &&
    Array.isArray(value.stopTimes) &&
    Array.isArray(value.frequencies) &&
    Array.isArray(value.calendar) &&
    Array.isArray(value.shapes)
  );
}
