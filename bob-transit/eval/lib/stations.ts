/**
 * Station-name index built from the committed GTFS static fixture
 * (`data/gtfs-static/rapid-rail-kl/stops.txt`).
 *
 * This module only READS that fixture. It never touches the network, and it
 * never writes outside `eval/`.
 *
 * Matching is deliberately fuzzy-tolerant in one direction only: the PDFs
 * frequently misspell or abbreviate a station name ("KENTONMEN" for KENTOMEN,
 * "KG BATU" for KAMPUNG BATU), so we normalise both sides and accept the
 * longest GTFS name that the PDF token run starts with.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slug } from "./text";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const GTFS_STOPS = path.join(
  REPO_ROOT,
  "data/gtfs-static/rapid-rail-kl/stops.txt",
);

export interface StationEntry {
  stopId: string;
  /** GTFS display name, e.g. "BANDARAYA - UOB". */
  name: string;
  /** Normalised comparison key, e.g. "BANDARAYA UOB". */
  key: string;
  /** Comparison key with the " - <suffix>" commercial suffix removed. */
  shortKey: string;
  lineId: string;
}

export interface StationIndex {
  entries: StationEntry[];
  /** shortKey -> entry. First writer wins (lowest stop_id, for determinism). */
  byShortKey: Map<string, StationEntry>;
  /** Every key, longest first, for greedy longest-match scanning. */
  keysByLengthDesc: string[];
}

/** Commercial renamings in GTFS that never appear in a press statement. */
const SUFFIX_SPLIT = /\s+-\s+/;

/**
 * Names the PDF corpus writes differently from GTFS, verified by inspecting the
 * unmatched `Stesen <X>` captures across all 165 archived statements.
 * Keys and values are in `slug()` space.
 */
export const STATION_ALIASES: Record<string, string> = {
  KENTONMEN: "KENTOMEN",
  "BANDAR TUN HUSSIEN ONN": "BANDAR TUN HUSSEIN ONN",
  "KG BATU": "KAMPUNG BATU",
  "KG BARU": "KAMPUNG BARU",
  "KAMPUNG BARU CBP COOPBANK PERTAMA": "KAMPUNG BARU",
  UNIVERSITY: "UNIVERSITI",
  "KEPONG SENTRAL": "KEPONG BARU",
  "KTM SETIA JAYA": "SETIA JAYA",
  "KTM SUNGAI BULOH": "SUNGAI BULOH",
  "KTM SEGAMBUT": "SEGAMBUT",
  "SOUTH QUAY LANJUTAN": "SOUTH QUAY USJ 1",
  "USJ7": "USJ 7",
  "SUNWAY SETIA JAYA": "SUNWAY SETIA JAYA",
  "BUKIT BINTANG": "BUKIT BINTANG",
};

/**
 * Captures that match the `Stesen <X>` shape but are not stations at all.
 * Without this stop-list they would create phantom station ids.
 */
export const STATION_STOPWORDS = new Set([
  "LRT",
  "MRT",
  "MONOREL",
  "BRT",
  "KTM",
  "TERLIBAT",
  "TERLIBAT KHAMIS",
  "TERLIBAT RABU",
  "LALUAN SUNWAY",
  "REL BERSEMPENA",
  "TRANSIT ALIRAN RINGAN",
  "BUS RAPID TRANSIT",
  "REL DILANJUTKAN PERKHIDMATAN SEHINGGA JAM",
  "DILANJUTKAN",
  "BERIKUT",
  "TERPILIH",
]);

/** Stations outside this GTFS feed (KTM Komuter) that the PDFs still name. */
export const OFF_FEED_STATIONS: Record<string, string> = {
  "SETIA JAYA": "KTM_SETIA_JAYA",
  "SUNGAI BULOH": "KTM_SUNGAI_BULOH",
  SEGAMBUT: "KTM_SEGAMBUT",
};

function shortKeyOf(name: string): string {
  const parts = name.split(SUFFIX_SPLIT);
  return slug(parts[0] ?? name);
}

export function buildStationIndex(stopsFile: string = GTFS_STOPS): StationIndex {
  const lines = readFileSync(stopsFile, "utf8").split(/\r?\n/);
  const header = (lines[0] ?? "").split(",");
  const iName = header.indexOf("stop_name");
  const iId = header.indexOf("stop_id");
  const iRoute = header.indexOf("route_id");
  if (iName < 0 || iId < 0 || iRoute < 0) {
    throw new Error(`stops.txt missing expected columns: ${header.join(",")}`);
  }

  const entries: StationEntry[] = [];
  const seenIds = new Set<string>();
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    const cols = line.split(",");
    const stopId = cols[iId] ?? "";
    const name = cols[iName] ?? "";
    if (!stopId || !name || seenIds.has(stopId)) continue;
    seenIds.add(stopId);
    entries.push({
      stopId,
      name,
      key: slug(name),
      shortKey: shortKeyOf(name),
      lineId: cols[iRoute] ?? "",
    });
  }
  entries.sort((a, b) => (a.stopId < b.stopId ? -1 : a.stopId > b.stopId ? 1 : 0));

  const byShortKey = new Map<string, StationEntry>();
  for (const e of entries) {
    if (!byShortKey.has(e.shortKey)) byShortKey.set(e.shortKey, e);
  }
  const keysByLengthDesc = [...byShortKey.keys()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : 1),
  );

  return { entries, byShortKey, keysByLengthDesc };
}

let cached: StationIndex | null = null;

/** Process-wide memoised index. Deterministic — the fixture never changes. */
export function stationIndex(): StationIndex {
  cached ??= buildStationIndex();
  return cached;
}

export interface StationMatch {
  /** GTFS stop_id, or a synthetic `KTM_*` id for off-feed stations. */
  stationId: string;
  /** The GTFS name the capture resolved to. */
  name: string;
  /** Exactly what the PDF said. */
  surface: string;
  lineId: string;
  /** Character offset of the `Stesen` keyword in the source text. */
  index: number;
}

/**
 * Resolve one captured name fragment ("Taman Jaya", "KENTONMEN", "LRT Masjid
 * Jamek") to a station. Returns null when nothing plausible matches.
 */
export function resolveStation(
  surface: string,
  index: StationIndex,
): Omit<StationMatch, "index"> | null {
  const cleaned = surface
    .replace(/\b(LRT|MRT|MONOREL|BRT|KTM)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  let key = slug(cleaned);
  if (key.length < 3) return null;

  key = STATION_ALIASES[key] ?? key;
  if (STATION_STOPWORDS.has(key)) return null;

  if (OFF_FEED_STATIONS[key]) {
    return {
      stationId: OFF_FEED_STATIONS[key]!,
      name: key,
      surface: surface.trim(),
      lineId: "KTM",
    };
  }

  const exact = index.byShortKey.get(key);
  if (exact) {
    return {
      stationId: exact.stopId,
      name: exact.shortKey,
      surface: surface.trim(),
      lineId: exact.lineId,
    };
  }

  // Longest GTFS key that the captured run starts with, or that starts with the
  // captured run (handles truncation like "BANDAR TASIK").
  for (const candidate of index.keysByLengthDesc) {
    if (key.startsWith(`${candidate} `) || candidate === key) {
      const entry = index.byShortKey.get(candidate)!;
      return {
        stationId: entry.stopId,
        name: candidate,
        surface: surface.trim(),
        lineId: entry.lineId,
      };
    }
  }
  for (const candidate of index.keysByLengthDesc) {
    if (candidate.startsWith(`${key} `) && key.length >= 5) {
      const entry = index.byShortKey.get(candidate)!;
      return {
        stationId: entry.stopId,
        name: candidate,
        surface: surface.trim(),
        lineId: entry.lineId,
      };
    }
  }
  return null;
}
