/**
 * Normalisation helpers for the rapid-rail-kl GTFS feed.
 *
 * The feed is inconsistent in ways that will silently corrupt a graph if you
 * join on the wrong column. Everything that touches raw identifiers goes
 * through here, and `tests/routing/gtfs-normalize.test.ts` asserts that every
 * `route_id` spelling in every file maps to a canonical line id.
 */

import type { LineId, TransitMode } from "@/lib/contracts";

/**
 * Canonical line ids are exactly the `route_id` values in `routes.txt`
 * (which also match `trips.txt`).
 */
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

/**
 * Every `route_id` spelling observed anywhere in the fixture, mapped to the
 * canonical `routes.txt` id.
 *
 *   routes.txt     : AG KJ PH KGL PYL MR BRT SA
 *   trips.txt      : AG BRT KGL KJ MR PH PYL SA
 *   stops.txt      : AG BRT KJ MR MRT PH PYL SA        <- Kajang line is "MRT"
 *   stop_times.txt : AGL BRT KGL KJL MRL PYL SAL SPL   <- SPL is Sri Petaling (PH)
 */
export const LINE_ID_ALIASES: Readonly<Record<string, LineId>> = Object.freeze({
  AG: "AG",
  AGL: "AG",
  AMPANG: "AG",
  KJ: "KJ",
  KJL: "KJ",
  KELANAJAYA: "KJ",
  PH: "PH",
  SPL: "PH",
  SP: "PH",
  SRIPETALING: "PH",
  KGL: "KGL",
  MRT: "KGL",
  KAJANG: "KGL",
  PYL: "PYL",
  PUTRAJAYA: "PYL",
  MR: "MR",
  MRL: "MR",
  MONORAIL: "MR",
  BRT: "BRT",
  SA: "SA",
  SAL: "SA",
  SHAHALAM: "SA",
});

/**
 * Resolve any observed route_id spelling to the canonical line id.
 * Returns null when the value is unknown, so callers can warn instead of
 * inventing a line.
 */
export function normalizeLineId(raw: string): LineId | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase().replace(/[\s_-]/g, "");
  return LINE_ID_ALIASES[key] ?? null;
}

/**
 * Parse a GTFS `HH:MM:SS` (or `HH:MM`) service time into seconds after local
 * midnight. GTFS allows hours >= 24 for trips that run past midnight, and the
 * fixture uses `24:00:00` as a frequency end time, so 86400 is a legal value.
 * Returns null for blank/malformed input.
 */
export function parseGtfsTime(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = parts.length === 3 ? Number(parts[2]) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  if (hours < 0 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Tokens that are acronyms, not words. Without this, "KLCC" becomes "Klcc" and
 * "PWTC" becomes "Pwtc", which looks broken in the UI.
 */
const ACRONYMS: ReadonlySet<string> = new Set([
  "KL",
  "KLCC",
  "KLIA",
  "PWTC",
  "UOB",
  "USJ",
  "USJ7",
  "SS",
  "UITM",
  "UPM",
  "IOI",
  "CBP",
  "SA",
  "TBS",
  "HKL",
  "MRT",
  "LRT",
  "BRT",
  "TRX",
  "PJ",
  "GM",
]);

function titleCaseToken(token: string): string {
  if (token === "") return token;
  const upper = token.toUpperCase();
  if (ACRONYMS.has(upper)) return upper;
  // Already mixed case in the source (e.g. "SunU", "Monash") -> leave alone.
  if (token !== upper && token !== token.toLowerCase()) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * Normalise a published GTFS stop name for display: trim, collapse internal
 * whitespace, and title-case words while preserving known acronyms and
 * hyphenated compounds ("SOUTH QUAY-USJ 1" -> "South Quay-USJ 1").
 */
export function normalizeDisplayName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed === "") return "";
  // Split keeping whitespace and hyphens as separate tokens.
  return collapsed
    .split(/(\s+|-)/)
    .map((part) => (/^(\s+|-)$/.test(part) ? part : titleCaseToken(part)))
    .join("");
}

/**
 * Grouping key for "is this the same place?" checks. Case- and
 * punctuation-insensitive: "USJ 7" and "USJ7" collapse to the same key, as do
 * "BUKIT BINTANG " and "Bukit Bintang".
 */
export function canonicalNameKey(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Map the feed's `category` column (falling back to route_type / line id) onto
 * the frozen `TransitMode` union.
 */
export function toTransitMode(
  category: string,
  routeType: number,
  lineId: LineId,
): TransitMode {
  const c = category.trim().toUpperCase();
  if (c === "LRT" || c === "MRT" || c === "MRL" || c === "BRT" || c === "KTM" || c === "BUS") {
    return c;
  }
  if (lineId === "KGL" || lineId === "PYL") return "MRT";
  if (lineId === "MR") return "MRL";
  if (lineId === "BRT") return "BRT";
  // GTFS route_type 0 = tram/light rail, 1 = subway/metro, 2 = rail.
  if (routeType === 0) return "BRT";
  return "LRT";
}

/** `HH:MM` for a seconds-after-local-midnight value, wrapping past midnight. */
export function formatClock(seconds: number): string {
  const day = 24 * 3600;
  const s = ((Math.round(seconds) % day) + day) % day;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
