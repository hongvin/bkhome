/**
 * Station / line / segment entity resolver.
 *
 * This is the single most failure-prone step in the pipeline: a wrong segment id
 * sends commuters the wrong way. The resolver therefore obeys one rule above all:
 * **never silently pick one interpretation.** When a claim matches several
 * distinct places it returns `UNRESOLVED` with every candidate segment listed.
 *
 * It handles:
 *  - the feed's own names, including the trailing spaces and ` - UOB`-style suffixes,
 *  - Malay/English variants and real Klang Valley colloquialisms (TTDI, TRX, HKL, BTS),
 *  - mode-prefixed references ("LRT Kelana Jaya", "MRT Phileo Damansara"),
 *  - `LALUAN ...` / `STESEN ...` / `ANTARA X DAN Y` phrasing,
 *  - misspellings, via Damerau-Levenshtein with a length-scaled threshold,
 *  - interchanges: `KJ13`, `SP7` and `AG7` are one physical place (Masjid Jamek)
 *    and resolve together; same-name-different-place stays ambiguous.
 */

import type { LineId, SegmentId, StationId } from "@/lib/contracts";

import { extractBetweenMention, foldMalay } from "./malay-text";
import {
  type PhysicalPlace,
  buildPlaces,
} from "./network/build";
import type { NetworkIndex } from "./network/build";
import { isCanonicalLineId } from "./network/parse";

export type { PhysicalPlace };

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/** Uppercase, strip diacritics, drop punctuation, collapse whitespace. */
export function normalizeName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Spaces removed — lets "USJ 7" match "USJ7". */
export function compactName(input: string): string {
  return normalizeName(input).replace(/\s+/g, "");
}

function tokens(input: string): string[] {
  const n = normalizeName(input);
  return n.length === 0 ? [] : n.split(" ");
}

/* ------------------------------------------------------------------ *
 * Alias tables
 * ------------------------------------------------------------------ */

/**
 * Curated Malay / English / colloquial aliases. Keys are already normalised.
 * Every value is a station name as it appears in stops.txt; the index maps it to
 * one or more StationIds (one per line serving that place).
 */
export const STATION_ALIASES: Readonly<Record<string, string[]>> = {
  // Real Klang Valley acronyms and short forms.
  TTDI: ["TAMAN TUN DR ISMAIL"],
  TRX: ["TUN RAZAK EXCHANGE"],
  HKL: ["HOSPITAL KUALA LUMPUR"],
  BTS: ["BANDAR TASIK SELATAN"],
  BTHO: ["BANDAR TUN HUSSEIN ONN"],
  PBD: ["PUSAT BANDAR DAMANSARA"],
  "BUKIT BINTANG": ["BUKIT BINTANG"],
  BB: [],
  "KL SENTRAL": ["KL SENTRAL", "KL SENTRAL - REDONE"],
  "KL SENTRAL REDONE": ["KL SENTRAL - REDONE"],
  SENTRAL: ["KL SENTRAL"],
  BANDARAYA: ["BANDARAYA - UOB"],
  "BANDARAYA UOB": ["BANDARAYA - UOB"],
  BANGSAR: ["BANGSAR - BANK RAKYAT"],
  "BANGSAR BANK RAKYAT": ["BANGSAR - BANK RAKYAT"],
  "KAMPUNG BARU": ["KAMPUNG BARU - CBP COOPBANK PERTAMA"],
  "DATO MENTERI": ["DATO' MENTERI - SA SENTRAL"],
  "SA SENTRAL": ["DATO' MENTERI - SA SENTRAL"],
  "SETIA JAYA": ["SUNWAY-SETIA JAYA"],
  "SUNWAY SETIA JAYA": ["SUNWAY-SETIA JAYA"],
  "SETIAJAYA": ["SUNWAY-SETIA JAYA"],
  "SUNWAY LAGOON": ["SUNWAY LAGOON"],
  "SUN U MONASH": ["SunU-Monash"],
  MONASH: ["SunU-Monash"],
  "SOUTH QUAY": ["SOUTH QUAY-USJ 1"],
  "USJ 1": ["SOUTH QUAY-USJ 1"],
  "USJ7": ["USJ 7", "USJ7"],
  "USJ 7": ["USJ 7", "USJ7"],
  "USJ21": ["USJ 21"],
  "SS15": ["SS 15"],
  "SS18": ["SS 18"],
  // Malay <-> English variants seen in real statements.
  "MUZIUM NEGARA": ["MUZIUM NEGARA"],
  "NATIONAL MUSEUM": ["MUZIUM NEGARA"],
  "PASAR SENI": ["PASAR SENI"],
  "PASAR KLANG": ["PASAR KLANG"],
  "JLN IPOH": ["JALAN IPOH"],
  "JALAN IPOH": ["JALAN IPOH"],
  "JLN MERU": ["JALAN MERU"],
  "JLN AMPANG": ["AMPANG"],
  "STADIUM KAJANG": ["STADIUM KAJANG"],
  "STADIUM SHAH ALAM": ["STADIUM SHAH ALAM"],
  "BUKIT JALIL": ["BUKIT JALIL"],
  "SUNGAI BESI": ["SUNGAI BESI"],
  "SUNGAI BULOH": ["SUNGAI BULOH"],
  "SRI PETALING": ["SRI PETALING"],
  "SRI RAYA": ["SRI RAYA"],
  "TAMAN JAYA": ["TAMAN JAYA"],
  "TAMAN BAHAGIA": ["TAMAN BAHAGIA"],
  "TAMAN MELATI": ["TAMAN MELATI"],
  "TAMAN PARAMOUNT": ["TAMAN PARAMOUNT"],
  "TAMAN MUTIARA": ["TAMAN MUTIARA"],
  "TAMAN MIDAH": ["TAMAN MIDAH"],
  "TAMAN SUNTEX": ["TAMAN SUNTEX"],
  "TAMAN PERTAMA": ["TAMAN PERTAMA"],
  "TAMAN CONNAUGHT": ["TAMAN CONNAUGHT"],
  "TAMAN NAGA EMAS": ["TAMAN NAGA EMAS"],
  "TAMAN EQUINE": ["TAMAN EQUINE"],
  "EQUINE PARK": ["TAMAN EQUINE"],
  "TAMAN SELATAN": ["TAMAN SELATAN"],
  "TAMAN TUN DR ISMAIL": ["TAMAN TUN DR ISMAIL"],
  "BANDAR UTAMA": ["BANDAR UTAMA"],
  "BANDAR UTAMA 11": ["BANDAR UTAMA 11"],
  "BANDAR BARU KLANG": ["BANDAR BARU KLANG"],
  "BANDAR BUKIT TINGGI": ["BANDAR BUKIT TINGGI"],
  "BANDAR PUTERI": ["BANDAR PUTERI"],
  "BANDAR TUN RAZAK": ["BANDAR TUN RAZAK"],
  "BANDAR TASIK SELATAN": ["BANDAR TASIK SELATAN"],
  "BANDAR TUN HUSSEIN ONN": ["BANDAR TUN HUSSEIN ONN"],
  "PUSAT BANDAR PUCHONG": ["PUSAT BANDAR PUCHONG"],
  "PUSAT BANDAR DAMANSARA": ["PUSAT BANDAR DAMANSARA"],
  "TAMAN PERINDUSTRIAN PUCHONG": ["TAMAN PERINDUSTRIAN PUCHONG"],
  "IOI PUCHONG JAYA": ["IOI PUCHONG JAYA"],
  "IOI PUCHONG": ["IOI PUCHONG JAYA"],
  "IOI MALL": ["IOI PUCHONG JAYA"],
  "KAMPUNG SELAMAT": ["KAMPUNG SELAMAT"],
  "KAMPUNG BATU": ["KAMPUNG BATU"],
  "KOTA DAMANSARA": ["KOTA DAMANSARA"],
  "KOTA WARISAN": [],
  "KWASA DAMANSARA": ["KWASA DAMANSARA"],
  "KWASA SENTRAL": ["KWASA SENTRAL"],
  "MUTIARA DAMANSARA": ["MUTIARA DAMANSARA"],
  "PHILEO DAMANSARA": ["PHILEO DAMANSARA"],
  "ARA DAMANSARA": ["ARA DAMANSARA"],
  "DAMANSARA DAMAI": ["DAMANSARA DAMAI"],
  "DAMANSARA IDAMAN": ["DAMANSARA IDAMAN"],
  "SRI DAMANSARA BARAT": ["SRI DAMANSARA BARAT"],
  "SRI DAMANSARA SENTRAL": ["SRI DAMANSARA SENTRAL"],
  "SRI DAMANSARA TIMUR": ["SRI DAMANSARA TIMUR"],
  "BANDAR TUN HUSSEIN ONN 2": [],
  "METRO PRIMA": ["METRO PRIMA"],
  "KEPONG BARU": ["KEPONG BARU"],
  "JINJANG": ["JINJANG"],
  "SRI DELIMA": ["SRI DELIMA"],
  "KENTOMEN": ["KENTOMEN"],
  "SENTUL BARAT": ["SENTUL BARAT"],
  "SENTUL TIMUR": ["SENTUL TIMUR"],
  "SENTUL": ["SENTUL"],
  "RAJA UDA": ["RAJA UDA"],
  "RAJA CHULAN": ["RAJA CHULAN"],
  "HOSPITAL KUALA LUMPUR": ["HOSPITAL KUALA LUMPUR"],
  "CONLAY": ["CONLAY"],
  "PERSIARAN KLCC": ["PERSIARAN KLCC"],
  "AMPANG PARK": ["AMPANG PARK"],
  "AMPANG": ["AMPANG"],
  "CAHAYA": ["CAHAYA"],
  "CEMPAKA": ["CEMPAKA"],
  "PANDAN INDAH": ["PANDAN INDAH"],
  "PANDAN JAYA": ["PANDAN JAYA"],
  "MALURI": ["MALURI"],
  "MIHARJA": ["MIHARJA"],
  "CHAN SOW LIN": ["CHAN SOW LIN"],
  "PUDU": ["PUDU"],
  "HANG TUAH": ["HANG TUAH"],
  "PLAZA RAKYAT": ["PLAZA RAKYAT"],
  "MASJID JAMEK": ["MASJID JAMEK"],
  "MASJID JAMEK LRT": ["MASJID JAMEK"],
  "SULTAN ISMAIL": ["SULTAN ISMAIL"],
  "PWTC": ["PWTC"],
  "TITIWANGSA": ["TITIWANGSA"],
  "DANG WANGI": ["DANG WANGI"],
  "KLCC": ["KLCC"],
  "DAMAI": ["DAMAI"],
  "DATO KERAMAT": ["DATO' KERAMAT"],
  "JELATEK": ["JELATEK"],
  "SETIAWANGSA": ["SETIAWANGSA"],
  "SRI RAMPAI": ["SRI RAMPAI"],
  "WANGSA MAJU": ["WANGSA MAJU"],
  "GOMBAK": ["GOMBAK"],
  "UNIVERSITI": ["UNIVERSITI"],
  "KERINCHI": ["KERINCHI"],
  "ABDULLAH HUKUM": ["ABDULLAH HUKUM"],
  "ASIA JAYA": ["ASIA JAYA"],
  "TAMAN JAYA 2": [],
  "GLENMARIE": ["GLENMARIE"],
  "GLENMARIE 2": ["GLENMARIE 2"],
  "SUBANG JAYA": ["SUBANG JAYA"],
  "SUBANG ALAM": ["SUBANG ALAM"],
  "SUBANG": ["SUBANG"],
  "LEMBAH SUBANG": ["LEMBAH SUBANG"],
  "KELANA JAYA": ["KELANA JAYA"],
  "TAIPAN": ["TAIPAN"],
  "WAWASAN": ["WAWASAN"],
  "ALAM MEGAH": ["ALAM MEGAH"],
  "ALAM SUTERA": ["ALAM SUTERA"],
  "PUTRA HEIGHTS": ["PUTRA HEIGHTS"],
  "PUCHONG PRIMA": ["PUCHONG PRIMA"],
  "PUCHONG PERDANA": ["PUCHONG PERDANA"],
  "KINRARA": ["KINRARA"],
  "MUHIBBAH": ["MUHIBBAH"],
  "AWAN BESAR": ["AWAN BESAR"],
  "SALAK SELATAN": ["SALAK SELATAN"],
  "CHERAS": ["CHERAS"],
  "BUKIT DUKUNG": ["BUKIT DUKUNG"],
  "SUNGAI JERNIH": ["SUNGAI JERNIH"],
  "KAJANG": ["KAJANG"],
  "SERDANG RAYA UTARA": ["SERDANG RAYA UTARA"],
  "SERDANG RAYA SELATAN": ["SERDANG RAYA SELATAN"],
  "SERDANG JAYA": ["SERDANG JAYA"],
  "SERDANG": ["SERDANG JAYA"],
  "UPM": ["UPM"],
  "PUTRA PERMAI": ["PUTRA PERMAI"],
  "16 SIERRA": ["16 SIERRA"],
  "CYBERJAYA UTARA": ["CYBERJAYA UTARA"],
  "CYBERJAYA": ["CYBERJAYA CITY CENTRE", "CYBERJAYA UTARA"],
  "CYBERJAYA CITY CENTRE": ["CYBERJAYA CITY CENTRE"],
  "PUTRAJAYA SENTRAL": ["PUTRAJAYA SENTRAL"],
  "PUTRAJAYA": ["PUTRAJAYA SENTRAL"],
  "TUN SAMBANTHAN": ["TUN SAMBANTHAN"],
  "MAHARAJALELA": ["MAHARAJALELA"],
  "IMBI": ["IMBI"],
  "BUKIT NANAS": ["BUKIT NANAS"],
  "MEDAN TUANKU": ["MEDAN TUANKU"],
  "CHOW KIT": ["CHOW KIT"],
  "BUKIT BINTANG MRT": ["BUKIT BINTANG"],
  "KAYU ARA": ["KAYU ARA"],
  "KERJAYA": ["KERJAYA"],
  "SEKSYEN 7": ["SEKSYEN 7"],
  "UITM": ["UITM SHAH ALAM"],
  "UITM SHAH ALAM": ["UITM SHAH ALAM"],
  "JOHAN SETIA": ["JOHAN SETIA"],
  "KLANG JAYA": ["KLANG JAYA"],
  "PASAR BESAR KLANG": ["PASAR KLANG"],
  "JAMBATAN KOTA": ["JAMBATAN KOTA"],
  "SERI ANDALAS": ["SERI ANDALAS"],
  "BUKIT TINGGI": ["BANDAR BUKIT TINGGI"],
  "KLANG": ["PASAR KLANG", "BANDAR BARU KLANG", "KLANG JAYA"],
  "MENTARI": ["MENTARI"],
  "SUNMED": ["SUNMED"],
};

/** Colloquial Malay for the lines, plus official English names and line codes. */
export const LINE_ALIASES: Readonly<Record<string, LineId>> = {
  AMPANG: "AG",
  AGL: "AG",
  "LRT AMPANG": "AG",
  "AMPANG LINE": "AG",
  "LALUAN AMPANG": "AG",
  "KELANA JAYA": "KJ",
  KJL: "KJ",
  "LRT KELANA JAYA": "KJ",
  "KELANA JAYA LINE": "KJ",
  "LALUAN KELANA JAYA": "KJ",
  "SRI PETALING": "PH",
  SPL: "PH",
  "LRT SRI PETALING": "PH",
  "SRI PETALING LINE": "PH",
  "LALUAN SRI PETALING": "PH",
  "AMPANG SRI PETALING": "PH",
  KAJANG: "KGL",
  KGL: "KGL",
  "MRT KAJANG": "KGL",
  "KAJANG LINE": "KGL",
  "LALUAN KAJANG": "KGL",
  SBK: "KGL",
  "MRT SBK": "KGL",
  PUTRAJAYA: "PYL",
  PYL: "PYL",
  "MRT PUTRAJAYA": "PYL",
  "PUTRAJAYA LINE": "PYL",
  "LALUAN PUTRAJAYA": "PYL",
  SSP: "PYL",
  "MRT SSP": "PYL",
  MONOREL: "MR",
  MONORAIL: "MR",
  MRL: "MR",
  "KL MONOREL": "MR",
  "KL MONORAIL": "MR",
  "LALUAN MONOREL": "MR",
  "MONOREL KL": "MR",
  BRT: "BRT",
  "BRT SUNWAY": "BRT",
  "SUNWAY BRT": "BRT",
  "LALUAN BRT": "BRT",
  "BRT LINE": "BRT",
  "SHAH ALAM": "SA",
  SAL: "SA",
  "LRT SHAH ALAM": "SA",
  "LALUAN SHAH ALAM": "SA",
  LRT3: "SA",
  "LRT 3": "SA",
  "SHAH ALAM LINE": "SA",
};

const MODE_PREFIXES = new Set(["LRT", "MRT", "MONOREL", "MONORAIL", "BRT", "KTM", "BAS", "TREN"]);
const LINE_KEYWORDS = new Set(["LALUAN", "LINE", "ALIRAN", "ROUTE"]);
const STATION_KEYWORDS = new Set(["STESEN", "STATION", "HENTIAN", "STOP"]);

/* ------------------------------------------------------------------ *
 * Fuzzy matching
 * ------------------------------------------------------------------ */

/** Optimal string alignment (restricted Damerau-Levenshtein). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev2 = new Array<number>(n + 1).fill(0);
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + cost);
      }
    }
    for (let j = 0; j <= n; j += 1) prev2[j] = prev[j];
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/** Length-scaled typo budget. Short names must match exactly. */
export function typoBudget(length: number): number {
  if (length >= 10) return 2;
  if (length >= 6) return 1;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Alias index
 * ------------------------------------------------------------------ */

export interface AliasEntry {
  alias: string;
  compact: string;
  tokenCount: number;
  kinds: Array<"STATION" | "LINE">;
  stationIds: StationId[];
  lineId: LineId | null;
  /** The alias is generic enough that a bare hit is meaningless. */
  generic: boolean;
}

const GENERIC_SINGLE_TOKENS = new Set([
  "TAMAN",
  "BANDAR",
  "PUSAT",
  "STESEN",
  "LRT",
  "MRT",
  "BRT",
  "SERI",
  "SRI",
  "KUALA",
  "LUMPUR",
  "JALAN",
  "SUNGAI",
  "BUKIT",
  "ALAM",
  "JAYA",
  "BARU",
  "UTARA",
  "SELATAN",
  "TIMUR",
  "BARAT",
  "PASAR",
  "STADIUM",
  "DAMANSARA",
  "SUBANG",
]);

export interface AliasIndex {
  entries: AliasEntry[];
  byAlias: Map<string, AliasEntry>;
  byCompact: Map<string, AliasEntry[]>;
  places: PhysicalPlace[];
  placeByStation: Map<StationId, PhysicalPlace>;
}

function stripDecorations(name: string): string[] {
  const out = new Set<string>();
  const n = normalizeName(name);
  out.add(n);
  // "BANDARAYA - UOB" -> "BANDARAYA"
  const head = n.split(/\s+-\s+/)[0];
  if (head && head !== n) out.add(head.trim());
  // Some feeds bake the mode into the name.
  for (const prefix of ["LRT ", "MRT ", "BRT ", "MONOREL ", "MONORAIL "]) {
    if (n.startsWith(prefix)) out.add(n.slice(prefix.length));
  }
  return [...out].filter((x) => x.length > 0);
}

export function buildAliasIndex(index: NetworkIndex): AliasIndex {
  const places = buildPlaces(index.stations);
  const placeByStation = new Map<StationId, PhysicalPlace>();
  for (const p of places) for (const id of p.stationIds) placeByStation.set(id, p);

  const byAlias = new Map<string, AliasEntry>();
  const byCompact = new Map<string, AliasEntry[]>();
  const stationByName = new Map<string, StationId[]>();
  for (const st of index.stations) {
    const key = normalizeName(st.name);
    const list = stationByName.get(key);
    if (list) list.push(st.id);
    else stationByName.set(key, [st.id]);
  }

  const upsert = (
    alias: string,
    patch: Partial<Pick<AliasEntry, "stationIds" | "lineId" | "kinds">>,
  ): void => {
    const norm = normalizeName(alias);
    if (norm.length === 0) return;
    const existing = byAlias.get(norm);
    if (existing) {
      if (patch.stationIds) {
        existing.stationIds = [...new Set([...existing.stationIds, ...patch.stationIds])].sort();
      }
      if (patch.lineId) existing.lineId = patch.lineId;
      if (patch.kinds) existing.kinds = [...new Set([...existing.kinds, ...patch.kinds])];
    } else {
      const entry: AliasEntry = {
        alias: norm,
        compact: norm.replace(/\s+/g, ""),
        tokenCount: norm.split(" ").length,
        kinds: patch.kinds ?? [],
        stationIds: patch.stationIds ?? [],
        lineId: patch.lineId ?? null,
        generic: norm.split(" ").length === 1 && GENERIC_SINGLE_TOKENS.has(norm),
      };
      byAlias.set(norm, entry);
      const list = byCompact.get(entry.compact);
      if (list) list.push(entry);
      else byCompact.set(entry.compact, [entry]);
    }
  };

  // 1. Every station's own name and its decorated forms.
  for (const st of index.stations) {
    for (const alias of stripDecorations(st.name)) {
      upsert(alias, { stationIds: [st.id], kinds: ["STATION"] });
    }
  }
  // 2. Curated colloquial / translated aliases.
  for (const [alias, names] of Object.entries(STATION_ALIASES)) {
    const ids: StationId[] = [];
    for (const name of names) {
      const found = stationByName.get(normalizeName(name));
      if (found) ids.push(...found);
    }
    if (ids.length > 0) upsert(alias, { stationIds: [...new Set(ids)].sort(), kinds: ["STATION"] });
  }
  // 3. Line aliases.
  for (const [alias, lineId] of Object.entries(LINE_ALIASES)) {
    upsert(alias, { lineId, kinds: ["LINE"] });
  }
  // 4. Bare canonical line codes ("AG", "KJ", ...) are LINE aliases only.
  for (const line of index.lines) {
    upsert(line.id, { lineId: line.id, kinds: ["LINE"] });
  }

  const entries = [...byAlias.values()].sort(
    (a, b) => b.tokenCount - a.tokenCount || b.alias.length - a.alias.length || a.alias.localeCompare(b.alias),
  );
  return { entries, byAlias, byCompact, places, placeByStation };
}

/* ------------------------------------------------------------------ *
 * Mention extraction
 * ------------------------------------------------------------------ */

export type MentionKind = "STATION" | "LINE" | "SEGMENT" | "ROAD";

export interface LocationMention {
  kind: MentionKind;
  /** Normalised surface form found in the text. */
  text: string;
  /** For SEGMENT: the two endpoint surface forms. */
  endpoints?: [string, string];
  /** Character offsets in the normalised text, for reasoning strings. */
  start: number;
  end: number;
}

const ROAD_KEYWORDS = [
  "JALAN",
  "LEBUHRAYA",
  "LEBUHRAYA",
  "HIGHWAY",
  "EXPRESSWAY",
  "PERSIARAN",
  "LINGKARAN",
  "SIMPANG",
  "BULATAN",
  "TRAFIK",
  "TRAFFIC",
  "ROAD",
];

/**
 * Scan normalised text for the longest non-overlapping alias matches, then
 * classify each by its left context. Longest-match-first is what stops
 * "AMPANG PARK" from also matching the line alias "AMPANG".
 */
export function extractMentions(
  text: string,
  aliasIndex: AliasIndex,
  options: { includeGeneric?: boolean } = {},
): LocationMention[] {
  const norm = normalizeName(text);
  const toks = norm.length === 0 ? [] : norm.split(" ");
  const consumed = new Array<boolean>(toks.length).fill(false);
  const mentions: LocationMention[] = [];

  // Pre-compute token offsets so mentions carry usable spans.
  const offsets: number[] = [];
  {
    let cursor = 0;
    for (const t of toks) {
      const idx = norm.indexOf(t, cursor);
      offsets.push(idx);
      cursor = idx + t.length;
    }
  }

  const maxWindow = 6;
  for (let i = 0; i < toks.length; i += 1) {
    if (consumed[i]) continue;
    let matched: AliasEntry | null = null;
    let matchedLen = 0;
    for (let len = Math.min(maxWindow, toks.length - i); len >= 1; len -= 1) {
      if (consumed[i + len - 1]) continue;
      const phrase = toks.slice(i, i + len).join(" ");
      const entry = aliasIndex.byAlias.get(phrase);
      if (entry) {
        if (entry.generic && !options.includeGeneric) continue;
        matched = entry;
        matchedLen = len;
        break;
      }
    }
    if (!matched) continue;

    // Left context decides whether this is a line claim or a station claim.
    const prev1 = i > 0 ? toks[i - 1] : "";
    const prev2 = i > 1 ? toks[i - 2] : "";
    const start = offsets[i];
    const end = offsets[i + matchedLen - 1] + toks[i + matchedLen - 1].length;

    let kind: MentionKind | null = null;
    if (LINE_KEYWORDS.has(prev1) || (LINE_KEYWORDS.has(prev2) && MODE_PREFIXES.has(prev1))) {
      kind = matched.lineId ? "LINE" : null;
    } else if (STATION_KEYWORDS.has(prev1)) {
      kind = matched.stationIds.length > 0 ? "STATION" : null;
    } else if (MODE_PREFIXES.has(prev1)) {
      kind = matched.lineId ? "LINE" : matched.stationIds.length > 0 ? "STATION" : null;
    } else if (matched.stationIds.length > 0) {
      kind = "STATION";
    } else if (matched.lineId) {
      kind = "LINE";
    }
    if (!kind) continue;

    for (let k = 0; k < matchedLen; k += 1) consumed[i + k] = true;
    mentions.push({ kind, text: matched.alias, start, end });
    i += matchedLen - 1;
  }

  // "antara X dan Y" / "between X and Y" is a SEGMENT claim and outranks the
  // individual station mentions it contains. Trimming is shared with the phrase
  // parser (lib/signals/malay-text.ts) so both halves agree on where a place
  // name ends and a clause begins.
  const between = extractBetweenMention(foldMalay(text));
  if (between) {
    const [left, right] = between;
    const leftHit = matchStationText(left, aliasIndex);
    const rightHit = matchStationText(right, aliasIndex);
    if (leftHit.stationIds.length > 0 && rightHit.stationIds.length > 0) {
      const idx = norm.indexOf(normalizeName(left));
      const start = idx < 0 ? 0 : idx;
      mentions.push({
        kind: "SEGMENT",
        text: `${left} -> ${right}`,
        endpoints: [left, right],
        start,
        end: start + left.length + right.length,
      });
    }
  }

  // Road claims: keep them so the verifier can type the issue even when the road
  // is not in the rail feed (there will be no station match).
  if (mentions.every((m) => m.kind !== "STATION" && m.kind !== "SEGMENT")) {
    for (const kw of ROAD_KEYWORDS) {
      const idx = norm.indexOf(`${kw} `);
      if (idx >= 0) {
        mentions.push({ kind: "ROAD", text: norm.slice(idx, idx + 40).trim(), start: idx, end: idx + 40 });
        break;
      }
    }
  }

  return mentions.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ *
 * Station matching
 * ------------------------------------------------------------------ */

export type MatchStrategy = "EXACT" | "ALIAS" | "COMPACT" | "FUZZY" | "NONE";

export interface StationMatch {
  mention: string;
  normalized: string;
  stationIds: StationId[];
  /** Distinct physical places matched. > 1 means genuinely ambiguous. */
  placeKeys: string[];
  strategy: MatchStrategy;
  score: number;
}

/** Match one surface form against the station alias index. Never picks silently. */
export function matchStationText(mention: string, aliasIndex: AliasIndex): StationMatch {
  const norm = normalizeName(mention);
  const empty: StationMatch = {
    mention,
    normalized: norm,
    stationIds: [],
    placeKeys: [],
    strategy: "NONE",
    score: 0,
  };
  if (norm.length === 0) return empty;

  const direct = aliasIndex.byAlias.get(norm);
  if (direct && direct.stationIds.length > 0) {
    return finalize(norm, direct.stationIds, norm === direct.alias ? "EXACT" : "ALIAS", 1, aliasIndex);
  }

  const compact = compactName(norm);
  const compactHits = aliasIndex.byCompact.get(compact) ?? [];
  const compactIds = [...new Set(compactHits.flatMap((e) => e.stationIds))].sort();
  if (compactIds.length > 0) return finalize(norm, compactIds, "COMPACT", 0.95, aliasIndex);

  // Typo tolerance. Only compare against aliases of the same token count so that
  // "TAMAN JAYA" cannot drift into "TAMAN MELATI".
  const toks = norm.split(" ");
  const budget = typoBudget(compact.length);
  if (budget > 0) {
    let best = Number.POSITIVE_INFINITY;
    let bestIds: StationId[] = [];
    for (const entry of aliasIndex.entries) {
      if (entry.stationIds.length === 0) continue;
      if (entry.tokenCount !== toks.length) continue;
      if (entry.generic) continue;
      if (Math.abs(entry.compact.length - compact.length) > budget) continue;
      const d = editDistance(compact, entry.compact);
      if (d > budget) continue;
      if (d < best) {
        best = d;
        bestIds = entry.stationIds;
      } else if (d === best) {
        bestIds = [...new Set([...bestIds, ...entry.stationIds])].sort();
      }
    }
    if (bestIds.length > 0) {
      const score = best === 0 ? 0.98 : best === 1 ? 0.82 : 0.68;
      return finalize(norm, bestIds, best === 0 ? "COMPACT" : "FUZZY", score, aliasIndex);
    }
  }
  return empty;
}

function finalize(
  mention: string,
  stationIds: StationId[],
  strategy: MatchStrategy,
  score: number,
  aliasIndex: AliasIndex,
): StationMatch {
  const ids = [...new Set(stationIds)].sort();
  const placeKeys = [
    ...new Set(ids.map((id) => aliasIndex.placeByStation.get(id)?.key).filter((x): x is string => !!x)),
  ].sort();
  return { mention, normalized: mention, stationIds: ids, placeKeys, strategy, score };
}

/* ------------------------------------------------------------------ *
 * Location resolution
 * ------------------------------------------------------------------ */

export type ResolutionStrategy = "SEGMENT_BETWEEN" | "STATION" | "LINE" | "NONE";

export interface LocationResolution {
  resolution: "RESOLVED" | "UNRESOLVED";
  strategy: ResolutionStrategy;
  stationIds: StationId[];
  lineIds: LineId[];
  /**
   * Lines the TEXT actually named ("LRT Kelana Jaya", "LALUAN KAJANG"). Distinct
   * from `lineIds`, which also picks up every line serving a resolved station.
   * The verifier uses this to keep an interchange's other line out of a
   * cluster whose witnesses all named one line.
   */
  mentionedLineIds: LineId[];
  segmentIds: SegmentId[];
  unresolvedCandidates: SegmentId[];
  /** 0..1 confidence that we know *where* the claim applies. */
  locationConfidence: number;
  reasons: string[];
  matchedNames: string[];
  /** Present only when the resolver had to refuse a choice. */
  ambiguity?: { candidates: Array<{ name: string; stationIds: StationId[] }>; reason: string };
}

export interface ResolveOptions {
  /** Additional raw location strings the ingest parser already extracted. */
  extraStationMentions?: string[];
  extraLineMentions?: string[];
}

export function segmentsAtStations(index: NetworkIndex, stationIds: StationId[]): SegmentId[] {
  const out = new Set<SegmentId>();
  for (const stationId of stationIds) {
    const station = index.stationById.get(stationId);
    if (!station) continue;
    for (const lineId of station.lineIds) {
      for (const seg of index.segmentsByLineStation.get(`${lineId}|${stationId}`) ?? []) out.add(seg.id);
    }
  }
  return [...out].sort();
}

function segmentsBetween(
  index: NetworkIndex,
  aIds: StationId[],
  bIds: StationId[],
): { segments: SegmentId[]; lineIds: LineId[] } {
  const segments = new Set<SegmentId>();
  const lineIds = new Set<LineId>();
  for (const a of aIds) {
    const sa = index.stationById.get(a);
    if (!sa) continue;
    for (const b of bIds) {
      const sb = index.stationById.get(b);
      if (!sb || sa.id === sb.id) continue;
      for (const lineId of sa.lineIds) {
        if (!sb.lineIds.includes(lineId)) continue;
        const seqA = sa.sequenceByLine[lineId];
        const seqB = sb.sequenceByLine[lineId];
        if (seqA === undefined || seqB === undefined) continue;
        const lo = Math.min(seqA, seqB);
        const hi = Math.max(seqA, seqB);
        for (const seg of index.segmentsByLine.get(lineId) ?? []) {
          if (seg.fromSequence >= lo && seg.toSequence <= hi && seg.fromSequence !== seg.toSequence) {
            segments.add(seg.id);
            lineIds.add(lineId);
          }
        }
      }
    }
  }
  return { segments: [...segments].sort(), lineIds: [...lineIds].filter(isCanonicalLineId).sort() };
}

/**
 * Turn a raw claim into segment ids — or refuse.
 *
 * Ordering of strategies is deliberate: an explicit "between X and Y" claim is
 * the most precise; a named station is next; a bare line claim can only ever be
 * UNRESOLVED because a line is not a segment.
 */
export function resolveLocation(
  text: string,
  index: NetworkIndex,
  aliasIndex: AliasIndex,
  options: ResolveOptions = {},
): LocationResolution {
  const mentions = extractMentions(text, aliasIndex);
  const reasons: string[] = [];
  const matchedNames: string[] = [];

  // ---- 1. explicit segment claim -------------------------------------------
  const segmentMention = mentions.find((m) => m.kind === "SEGMENT");
  if (segmentMention?.endpoints) {
    const [left, right] = segmentMention.endpoints;
    const a = matchStationText(left, aliasIndex);
    const b = matchStationText(right, aliasIndex);
    matchedNames.push(a.normalized, b.normalized);
    if (a.placeKeys.length === 1 && b.placeKeys.length === 1 && a.placeKeys[0] !== b.placeKeys[0]) {
      const { segments, lineIds } = segmentsBetween(index, a.stationIds, b.stationIds);
      if (segments.length > 0) {
        reasons.push(
          `explicit "antara ${left} dan ${right}" claim resolved to ${segments.length} directed segment(s)`,
        );
        return {
          resolution: "RESOLVED",
          strategy: "SEGMENT_BETWEEN",
          stationIds: [...new Set([...a.stationIds, ...b.stationIds])].sort(),
          lineIds,
          mentionedLineIds: lineIds,
          segmentIds: segments,
          unresolvedCandidates: [],
          locationConfidence: 0.95,
          reasons,
          matchedNames,
        };
      }
      reasons.push(`"${left}" and "${right}" share no adjacent segment; falling back to station resolution`);
    } else if (a.placeKeys.length > 1 || b.placeKeys.length > 1) {
      reasons.push(`segment endpoints ambiguous: "${left}" or "${right}" matched several places`);
    }
  }

  // ---- 2. station claims ----------------------------------------------------
  const stationTexts = [
    ...mentions.filter((m) => m.kind === "STATION").map((m) => m.text),
    ...(options.extraStationMentions ?? []),
  ];
  const stationMatches = stationTexts
    .map((t) => matchStationText(t, aliasIndex))
    .filter((m) => m.stationIds.length > 0);

  const lineTexts = [
    ...mentions.filter((m) => m.kind === "LINE").map((m) => m.text),
    ...(options.extraLineMentions ?? []),
  ];
  const lineIds = [
    ...new Set(
      lineTexts
        .map((t) => aliasIndex.byAlias.get(normalizeName(t))?.lineId)
        .filter((x): x is LineId => !!x && isCanonicalLineId(x)),
    ),
  ].sort();

  if (stationMatches.length > 0) {
    // A named line narrows interchange platforms to that line.
    let ids = [...new Set(stationMatches.flatMap((m) => m.stationIds))].sort();
    if (lineIds.length > 0) {
      const narrowed = ids.filter((id) => (index.stationById.get(id)?.lineIds ?? []).some((l) => lineIds.includes(l)));
      if (narrowed.length > 0) ids = narrowed;
    }
    const places = [
      ...new Set(ids.map((id) => aliasIndex.placeByStation.get(id)?.key).filter((x): x is string => !!x)),
    ].sort();
    matchedNames.push(...stationMatches.map((m) => m.normalized));

    if (places.length === 1) {
      const segments = segmentsAtStations(index, ids);
      reasons.push(
        `station "${stationMatches.map((m) => m.normalized).join('", "')}" resolved to one place (${ids.join(", ")})`,
      );
      return {
        resolution: "RESOLVED",
        strategy: "STATION",
        stationIds: ids,
        lineIds: [...new Set(ids.flatMap((id) => index.stationById.get(id)?.lineIds ?? []))]
          .filter(isCanonicalLineId)
          .sort(),
        mentionedLineIds: lineIds,
        segmentIds: segments,
        unresolvedCandidates: [],
        locationConfidence: Math.min(...stationMatches.map((m) => m.score)),
        reasons,
        matchedNames,
      };
    }

    const candidates = places.map((p) => {
      const place = aliasIndex.places.find((x) => x.key === p);
      return { name: place?.name ?? p, stationIds: place?.stationIds ?? [] };
    });
    const candidateSegments = [...new Set(candidates.flatMap((c) => segmentsAtStations(index, c.stationIds)))].sort();
    reasons.push(
      `"${stationMatches.map((m) => m.normalized).join('", "')}" matches ${places.length} distinct places — refusing to pick one`,
    );
    return {
      resolution: "UNRESOLVED",
      strategy: "STATION",
      stationIds: [],
      lineIds: [...new Set(ids.flatMap((id) => index.stationById.get(id)?.lineIds ?? []))]
        .filter(isCanonicalLineId)
        .sort(),
      mentionedLineIds: lineIds,
      segmentIds: [],
      unresolvedCandidates: candidateSegments,
      locationConfidence: 0.3,
      reasons,
      matchedNames,
      ambiguity: {
        candidates,
        reason: `ambiguous station name: ${places.length} distinct places matched`,
      },
    };
  }

  // ---- 3. line-only claims --------------------------------------------------
  if (lineIds.length > 0) {
    const candidates = lineIds.flatMap((l) => (index.segmentsByLine.get(l) ?? []).map((s) => s.id)).sort();
    reasons.push(
      `line-level claim (${lineIds.join(", ")}) identifies no segment; all ${candidates.length} candidate segments listed`,
    );
    return {
      resolution: "UNRESOLVED",
      strategy: "LINE",
      stationIds: [],
      lineIds,
      mentionedLineIds: lineIds,
      segmentIds: [],
      unresolvedCandidates: candidates,
      locationConfidence: 0.25,
      reasons,
      matchedNames,
      ambiguity: {
        candidates: lineIds.map((l) => ({
          name: `line ${l}`,
          stationIds: (index.segmentsByLine.get(l) ?? []).map((s) => s.fromStationId).slice(0, 1),
        })),
        reason: "line-wide claim; segment not identified",
      },
    };
  }

  // ---- 4. nothing -----------------------------------------------------------
  const hasRoad = mentions.some((m) => m.kind === "ROAD");
  reasons.push(hasRoad ? "road claim with no matching rail station" : "no locatable station or line in the text");
  return {
    resolution: "UNRESOLVED",
    strategy: "NONE",
    stationIds: [],
    lineIds: [],
    mentionedLineIds: [],
    segmentIds: [],
    unresolvedCandidates: [],
    locationConfidence: 0,
    reasons,
    matchedNames,
  };
}
