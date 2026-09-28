/**
 * FROZEN CONTRACT — do not modify.
 *
 * Network topology contracts. The transit graph is the shared interface between
 * the GTFS/CSA module (S1), the risk model (S4) and the UI (S5).
 *
 * Units: all durations in SECONDS, all distances in METERS, all timestamps ISO-8601 UTC.
 * Time-of-day values are "seconds after midnight in Asia/Kuala_Lumpur" (see TZ_OFFSET_SECONDS).
 */

export const CONTRACTS_VERSION = "1.0.0" as const;

/** Klang Valley local time offset. Malaysia has no DST, so a fixed offset is safe. */
export const TZ_OFFSET_SECONDS = 8 * 3600;
export const TZ_NAME = "Asia/Kuala_Lumpur" as const;

export interface LatLng {
  lat: number;
  lon: number;
}

/** GTFS `stop_id`, e.g. "KJ10" (KLCC). Unique per station platform. */
export type StationId = string;

/** GTFS `route_id`, e.g. "KJ" (Kelana Jaya Line). */
export type LineId = string;

/**
 * Directional track segment, canonically `"<lineId>:<fromStationId>-><toStationId>"`.
 * Risk is directional: a southbound fault need not affect northbound.
 */
export type SegmentId = string;

export type TransitMode = "LRT" | "MRT" | "MRL" | "BRT" | "KTM" | "BUS";

export interface Station {
  id: StationId;
  /** Display name as published in GTFS, normalised for casing. */
  name: string;
  /** Bahasa Malaysia display name. Falls back to `name` when no localised form exists. */
  nameMs: string;
  lat: number;
  lon: number;
  /** Every line serving this station. Length > 1 means interchange. */
  lineIds: LineId[];
  isInterchange: boolean;
  /** GTFS `isOKU` — step-free/accessible access. */
  isAccessible: boolean;
}

export interface Line {
  id: LineId;
  shortName: string;
  longName: string;
  longNameMs: string;
  /** Hex colour without '#', from GTFS `route_color`. */
  color: string;
  mode: TransitMode;
}

export interface Segment {
  id: SegmentId;
  lineId: LineId;
  fromStationId: StationId;
  toStationId: StationId;
  /** GTFS `stop_sequence` of each endpoint, for ordering along the line. */
  fromSequence: number;
  toSequence: number;
  /** Scheduled in-vehicle running time between the two stations. */
  scheduledRunSeconds: number;
  /** Station-to-station dwell allowance at the arrival station. */
  scheduledDwellSeconds: number;
  /** Polyline for map rendering; at least the two endpoints. */
  shape: LatLng[];
  lengthMeters: number;
}

export interface ServiceCalendar {
  serviceId: string;
  /** 0 = Sunday, matching JS `Date#getDay()`. */
  weekdays: boolean[];
  startDate: string;
  endDate: string;
}

/**
 * GTFS `frequencies.txt` row. The rapid-rail-kl feed is FREQUENCY-BASED: it ships
 * a handful of template trips plus headways, not one trip per departure. CSA needs
 * concrete dated connections, so the graph builder MUST expand these into
 * `Connection[]` before routing.
 */
export interface FrequencyTemplate {
  tripId: string;
  serviceId: string;
  lineId: LineId;
  startTime: number;
  endTime: number;
  headwaySeconds: number;
}

/** A single rideable hop at a concrete time. The atomic unit of CSA. */
export interface Connection {
  tripId: string;
  lineId: LineId;
  serviceId: string;
  fromStationId: StationId;
  toStationId: StationId;
  segmentId: SegmentId;
  /** Seconds after local midnight. */
  departureTime: number;
  /** Seconds after local midnight. */
  arrivalTime: number;
}

export interface TransitGraphStats {
  stationCount: number;
  lineCount: number;
  segmentCount: number;
  connectionCount: number;
  /** Distinct service days the connection set was expanded for. */
  serviceDayCount: number;
}

/**
 * The cached, offline-capable transit graph. Serialised to JSON, shipped to the
 * browser, and stored in IndexedDB so routing works in airplane mode.
 */
export interface TransitGraph {
  contractsVersion: typeof CONTRACTS_VERSION;
  /** ISO timestamp of graph construction. */
  builtAt: string;
  timezone: typeof TZ_NAME;
  lines: Line[];
  stations: Station[];
  segments: Segment[];
  services: ServiceCalendar[];
  frequencies: FrequencyTemplate[];
  /**
   * All connections for every expanded service day, sorted ascending by
   * `departureTime`. CSA requires this ordering.
   */
  connections: Connection[];
  stats: TransitGraphStats;
  /**
   * Non-fatal problems found while ingesting GTFS. Surfaced in the UI rather than
   * thrown, because the feed is known to be imperfect.
   */
  warnings: string[];
}

/** Lookup helpers the graph builder must be able to answer in O(1). */
export interface GraphIndex {
  stationById: Map<StationId, Station>;
  lineById: Map<LineId, Line>;
  segmentById: Map<SegmentId, Segment>;
  segmentsByLine: Map<LineId, Segment[]>;
}

export function makeSegmentId(
  lineId: LineId,
  fromStationId: StationId,
  toStationId: StationId,
): SegmentId {
  return `${lineId}:${fromStationId}->${toStationId}`;
}
