/**
 * Display-name normalisation for GTFS names.
 *
 * The committed feed publishes sponsor-suffixed, ALL-CAPS station names
 * ("KL SENTRAL - REDONE", "BANDARAYA - UOB", "KAMPUNG BARU - CBP COOPBANK
 * PERTAMA"). The frozen `Station.name` doc says "Display name as published in
 * GTFS, normalised for casing", so normalisation belongs in the loader and
 * applies identically to the real artifact and the fallback fixture.
 */
import type { Line, Station } from "@/lib/contracts";

/** Words that must stay upper-case when title-casing a GTFS name. */
const ACRONYMS = new Set([
  "KL",
  "KLCC",
  "MRT",
  "LRT",
  "BRT",
  "KTM",
  "USJ",
  "SS",
  "IOI",
  "TRX",
  "PWTC",
  "UOB",
  "CBP",
  "TBS",
  "BB",
  "II",
  "IIUM",
  "UM",
  "UPM",
  "SJ",
  "PJ",
  "TM",
  "KLIA",
  "MARA",
  "UTM",
]);

/** Small words that stay lower-case unless they lead the name. */
const MINOR_WORDS = new Set(["dan", "di", "ke", "of", "the", "and", "a", "at", "on"]);

/** " - SPONSOR" suffixes the operator appends to a handful of interchanges. */
const SPONSOR_SUFFIX =
  /\s+-\s+(REDONE|UOB|CBP COOPBANK PERTAMA|BANK RAKYAT|CIMB|MAYBANK|TNG|LOT 10|PAVILION)\b.*$/i;

export function normaliseStationName(raw: string): string {
  const trimmed = raw.replace(SPONSOR_SUFFIX, "").trim();
  return trimmed
    .split(/\s+/)
    .map((word, index) => {
      const bare = word.replace(/[^A-Za-z0-9']/g, "");
      if (ACRONYMS.has(bare.toUpperCase())) return word.toUpperCase();
      const lower = word.toLowerCase();
      if (index > 0 && MINOR_WORDS.has(lower)) return lower;
      return lower
        .split(/([-\s])/)
        .map((part) =>
          part.length > 1 && /[a-z]/.test(part)
            ? part.charAt(0).toUpperCase() + part.slice(1)
            : part,
        )
        .join("");
    })
    .join(" ")
    .replace(/\bKl\b/g, "KL");
}

/**
 * BM station names.
 *
 * The GTFS feed already publishes Klang Valley station names in Bahasa Malaysia
 * or as proper nouns — "Muzium Negara", "Bandaraya", "Pasar Seni", "Bukit
 * Bintang", "Taman Melati". There is therefore no separate BM form for the vast
 * majority, and the frozen contract explicitly allows `nameMs` to fall back to
 * `name`. Inventing translations for "USJ 7" would be worse than falling back,
 * so the map below only holds the genuinely divergent cases.
 */
export const MALAY_STATION_NAMES: Record<string, string> = {
  "Tun Razak Exchange": "Tun Razak Exchange",
  "Sunway-Setia Jaya": "Sunway-Setia Jaya",
};

/** BM line names. These DO differ from the English feed values. */
const MALAY_LINE_NAMES: Record<string, string> = {
  "LRT Ampang Line": "Laluan LRT Ampang",
  "LRT Kelana Jaya Line": "Laluan LRT Kelana Jaya",
  "LRT Sri Petaling Line": "Laluan LRT Sri Petaling",
  "MRT Kajang Line": "Laluan MRT Kajang",
  "MRT Putrajaya Line": "Laluan MRT Putrajaya",
  "KL Monorail Line": "Laluan Monorail KL",
  "BRT Sunway Line": "Laluan BRT Sunway",
  "LRT Shah Alam Line": "Laluan LRT Shah Alam",
};

export function localiseLineName(longName: string): string {
  const mapped = MALAY_LINE_NAMES[longName];
  if (mapped) return mapped;
  // Generic fallback: "X Line" -> "Laluan X".
  return longName.endsWith(" Line") ? `Laluan ${longName.slice(0, -5)}` : longName;
}

/** Apply normalisation to a station list without mutating the source graph. */
export function normaliseStations(stations: readonly Station[]): Station[] {
  return stations.map((station) => {
    const name = normaliseStationName(station.name);
    return {
      ...station,
      name,
      nameMs: MALAY_STATION_NAMES[name] ?? name,
    };
  });
}

/** Apply BM localisation to a line list without mutating the source graph. */
export function normaliseLines(lines: readonly Line[]): Line[] {
  return lines.map((line) => ({
    ...line,
    longNameMs: localiseLineName(line.longName),
  }));
}
