/**
 * Minimal, dependency-free GTFS static parsers.
 *
 * OWNERSHIP: S3 (lib/signals/**). S1 owns lib/gtfs/**; this module deliberately
 * re-implements the tiny slice of GTFS reading the signal pipeline needs so the
 * two modules can be built in parallel without a dependency edge.
 *
 * The rapid-rail-kl feed has known quirks that these parsers must survive:
 *  - a UTF-8 BOM on stop_times.txt's header,
 *  - quoted fields containing apostrophes ("DATO' KERAMAT"),
 *  - trailing spaces inside names ("BUKIT BINTANG "),
 *  - an inconsistent `route_id` vocabulary across files (see CANONICAL_LINE_IDS).
 */

import type { LineId } from "@/lib/contracts";

/** Canonical line ids, exactly the `routes.txt` set. Everything we emit uses these. */
export const CANONICAL_LINE_IDS = [
  "AG",
  "KJ",
  "PH",
  "KGL",
  "PYL",
  "MR",
  "BRT",
  "SA",
] as const;

export type CanonicalLineId = (typeof CANONICAL_LINE_IDS)[number];

const CANONICAL_SET: ReadonlySet<string> = new Set<string>(CANONICAL_LINE_IDS);

/**
 * `route_id` is NOT consistent across the GTFS files. This is the one place that
 * mapping is allowed to live. Verified against the committed feed:
 *
 *   routes.txt     AG KJ PH KGL PYL MR BRT SA
 *   trips.txt      AG BRT KGL KJ MR PH PYL SA
 *   stops.txt      AG BRT KJ MR MRT PH PYL SA     (Kajang line is "MRT")
 *   stop_times.txt AGL BRT KGL KJL MRL PYL SAL SPL
 */
const ROUTE_ID_ALIASES: Readonly<Record<string, CanonicalLineId>> = {
  AGL: "AG",
  KJL: "KJ",
  SPL: "PH",
  MRL: "MR",
  SAL: "SA",
  MRT: "KGL",
};

/** Map any of the feed's route_id dialects onto a canonical line id. */
export function toCanonicalLineId(rawRouteId: string): LineId | null {
  const raw = rawRouteId.trim().toUpperCase();
  if (CANONICAL_SET.has(raw)) return raw;
  return ROUTE_ID_ALIASES[raw] ?? null;
}

/** True when `lineId` is one of the canonical ids. Used by the resolver guard test. */
export function isCanonicalLineId(lineId: string): lineId is CanonicalLineId {
  return CANONICAL_SET.has(lineId);
}

/**
 * Split one CSV record. Handles double-quoted fields, escaped quotes ("") and
 * the `[object Object]` literal in stops.txt.geometry.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Parse a whole CSV document into header-keyed rows. Strips a leading BOM. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c += 1) row[header[c]] = cells[c] ?? "";
    rows.push(row);
  }
  return rows;
}

export interface GtfsStopRow {
  stopId: string;
  stopName: string;
  lat: number;
  lon: number;
  category: string;
  /** Raw, non-canonical route id from stops.txt. */
  rawRouteId: string;
  isOku: boolean;
}

export interface GtfsRouteRow {
  routeId: LineId;
  shortName: string;
  longName: string;
  routeDesc: string;
  color: string;
  category: string;
}

export interface GtfsTripRow {
  routeId: LineId;
  serviceId: string;
  tripId: string;
  headsign: string;
  directionId: number;
  shapeId: string;
}

export interface GtfsStopTimeRow {
  tripId: string;
  directionId: number;
  arrivalSeconds: number;
  departureSeconds: number;
  stopId: string;
  stopSequence: number;
}

/** "6:02:03" | "24:00:00" -> seconds after local midnight. */
export function gtfsTimeToSeconds(value: string): number {
  const parts = value.trim().split(":");
  if (parts.length < 2) return Number.NaN;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = parts.length > 2 ? Number(parts[2]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return Number.NaN;
  return h * 3600 + m * 60 + s;
}

export function parseStops(text: string): GtfsStopRow[] {
  return parseCsv(text).map((r) => ({
    stopId: r.stop_id.trim(),
    // Names carry stray trailing spaces in this feed; keep the trimmed display form.
    stopName: r.stop_name.trim(),
    lat: Number(r.stop_lat),
    lon: Number(r.stop_lon),
    category: (r.category ?? "").trim(),
    rawRouteId: (r.route_id ?? "").trim(),
    isOku: (r.isOKU ?? "").trim().toLowerCase() === "true",
  }));
}

export function parseRoutes(text: string): GtfsRouteRow[] {
  const rows: GtfsRouteRow[] = [];
  for (const r of parseCsv(text)) {
    const lineId = toCanonicalLineId(r.route_id ?? "");
    if (!lineId) continue;
    rows.push({
      routeId: lineId,
      shortName: (r.route_short_name ?? "").trim(),
      longName: (r.route_long_name ?? "").trim(),
      routeDesc: (r.route_desc ?? "").trim(),
      color: (r.route_color ?? "").trim(),
      category: (r.category ?? "").trim(),
    });
  }
  return rows;
}

/**
 * Trips are the ONLY authoritative source of a trip's line: `stop_times.txt`
 * uses a different route_id dialect, so we join on trip_id (brief §6).
 */
export function parseTrips(text: string): GtfsTripRow[] {
  const rows: GtfsTripRow[] = [];
  for (const r of parseCsv(text)) {
    const lineId = toCanonicalLineId(r.route_id ?? "");
    if (!lineId) continue;
    rows.push({
      routeId: lineId,
      serviceId: (r.service_id ?? "").trim(),
      tripId: (r.trip_id ?? "").trim(),
      headsign: (r.trip_headsign ?? "").trim(),
      directionId: Number(r.direction_id ?? "0"),
      shapeId: (r.shape_id ?? "").trim(),
    });
  }
  return rows;
}

export function parseStopTimes(text: string): GtfsStopTimeRow[] {
  const rows: GtfsStopTimeRow[] = [];
  for (const r of parseCsv(text)) {
    rows.push({
      tripId: (r.trip_id ?? "").trim(),
      directionId: Number(r.direction_id ?? "0"),
      arrivalSeconds: gtfsTimeToSeconds(r.arrival_time ?? ""),
      departureSeconds: gtfsTimeToSeconds(r.departure_time ?? ""),
      stopId: (r.stop_id ?? "").trim(),
      stopSequence: Number(r.stop_sequence ?? "0"),
    });
  }
  return rows;
}
