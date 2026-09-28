/**
 * Rule-based parser for myrapid.com.my media statements (Bahasa Malaysia).
 *
 * The rules were written by reading the actual 165-document archived corpus,
 * not by guessing. Everything here is a pure function of its inputs so the
 * labelled ground truth is reproducible byte-for-byte.
 */

import type { ExtractedDoc } from "./extract";
import type { IssueType, Severity } from "@/lib/contracts";
import {
  BOILERPLATE,
  DISRUPTION_MARKERS,
  ISSUE_PRIORITY,
  ISSUE_RULES,
  LINE_RULES,
  PLANNED_MARKERS,
  SEVERITY_RULES,
  STRONG_NON_INCIDENT_MARKERS,
  WEAK_NON_INCIDENT_MARKERS,
} from "./lexicon";
import {
  resolveStation,
  type StationIndex,
  type StationMatch,
} from "./stations";
import { clip, fold, slug, upper } from "./text";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocKind =
  | "INCIDENT"
  | "PLANNED_SERVICE_CHANGE"
  | "NON_INCIDENT"
  | "UNREADABLE";

export type TimeRole = "onset" | "restore" | "schedule" | "unknown";

export interface TimeMention {
  /** Seconds after local (Asia/Kuala_Lumpur) midnight. */
  secondsOfDay: number;
  /** The matched surface form, e.g. "8.36 pagi". */
  surface: string;
  role: TimeRole;
  /** Character offset of the match in the folded text. */
  index: number;
  /** ±90 chars of context, for the audit trail. */
  context: string;
}

export interface DateAnchor {
  /** ISO date (YYYY-MM-DD) in Asia/Kuala_Lumpur local time. */
  date: string;
  surface: string;
  index: number;
  kind: "explicit" | "dateline" | "relative_yesterday" | "relative_today";
}

export interface OnsetEstimate {
  /** ISO-8601 UTC instant the disruption is inferred to have begun. */
  at: string;
  /** How the instant was derived, so the assumption is auditable. */
  basis: "explicit_time" | "date_only" | "dateline_only" | "none";
  evidence: string;
  role: TimeRole;
}

export interface ParsedStatement {
  filename: string;
  kind: DocKind;
  kindReason: string;
  headline: string;
  lineIds: string[];
  stations: StationMatch[];
  stationIds: string[];
  issueType: IssueType;
  issueScores: Array<{ issueType: IssueType; score: number }>;
  severity: Severity;
  severityScore: number;
  /** Operator's own artefact timestamp, from the PDF CreationDate. */
  publishedAt: string;
  publishedAtSource: "pdf_creation_date";
  /** Date printed in the body dateline ("KUALA LUMPUR, 27 Januari 2023"). */
  bodyDateline: string | null;
  /** True when the body dateline and the PDF date differ by >= 1 local day. */
  datelineDisagrees: boolean;
  onset: OnsetEstimate;
  timeMentions: TimeMention[];
  textLength: number;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export function extractLineIds(text: string): string[] {
  const u = upper(text);
  const out: string[] = [];
  for (const rule of LINE_RULES) {
    if (rule.pattern.test(u)) {
      for (const id of rule.lineIds) if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

/**
 * Matches "Stesen <Name>" with an optional mode word and up to four following
 * capitalised tokens. The trailing-token limit is what keeps "Stesen LRT
 * Taman Jaya dan Stesen LRT Taman Bahagia" from becoming one giant name.
 */
const STATION_CAPTURE =
  /Stesen\s+(?:(?:LRT|MRT|Monorel|BRT|KTM)\s+)?([A-Za-z][A-Za-z'\/.\-]*(?:\s+(?:[A-Za-z][A-Za-z'\/.\-]*|[0-9]+)){0,4})/g;

/** Trailing conjunctions/prepositions that are not part of a station name. */
const TRAILING_JUNK =
  /\s+(?:dan|di|ke|yang|untuk|bagi|dari|daripada|akan|telah|ini|itu|pada|serta|sahaja|berikut|menuju|menghala|sehingga|hinggalah|arah|kepada|adalah|tidak|masih|turut|juga|pula|namun|manakala|sementara|selepas|sebelum|apabila|jika|kerana|akibat|ekoran|susulan|berhampiran|berdekatan|terletak|melibatkan|terlibat)$/i;

export function extractStations(text: string, index: StationIndex): StationMatch[] {
  const folded = fold(text);
  const out: StationMatch[] = [];
  const seen = new Set<string>();
  for (const m of folded.matchAll(STATION_CAPTURE)) {
    let surface = m[1] ?? "";
    // Peel trailing junk repeatedly: "Taman Jaya dan" -> "Taman Jaya".
    for (;;) {
      const stripped = surface.replace(TRAILING_JUNK, "");
      if (stripped === surface) break;
      surface = stripped;
    }
    const resolved = resolveStation(surface, index);
    if (!resolved) continue;
    const dedupeKey = `${resolved.stationId}@${m.index}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ ...resolved, index: m.index ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issue type & severity
// ---------------------------------------------------------------------------

/**
 * Issue types that are ROOT CAUSES rather than SYMPTOMS.
 *
 * "KELEWATAN" (delay) and "KESESAKAN" (crowding) describe the *effect* of a
 * disruption; the operator's statements almost always also name the cause
 * ("GANGGUAN SISTEM SEMBOYAN", "TREN TERKANDAS", "SUIS LANDASAN"). Scoring them
 * as equal peers made DELAY win on sheer keyword volume — 8 documents were
 * misclassified that way. So a root cause suppresses the symptom types.
 */
export const ROOT_CAUSE_TYPES: IssueType[] = [
  "VEHICLE_BREAKDOWN",
  "SIGNAL_FAULT",
  "TRACK_FAULT",
  "ELEVATOR_FAULT",
  "DOOR_FAULT",
  "WEATHER",
  "ROAD_BLOCKED",
];

/** Minimum root-cause score that counts as "the statement names a cause". */
const ROOT_CAUSE_FLOOR = 3;

export function scoreIssueTypes(
  text: string,
  headline?: string,
): Array<{ issueType: IssueType; score: number }> {
  const body = upper(text);
  const head = headline ? upper(headline) : "";
  const scores = new Map<IssueType, number>();
  for (const rule of ISSUE_RULES) {
    let s = 0;
    if (rule.pattern.test(body)) s += rule.weight;
    // The headline is the operator's own one-line summary, so it counts double.
    if (head.length > 0 && rule.pattern.test(head)) s += rule.weight * 2;
    if (s > 0) scores.set(rule.issueType, (scores.get(rule.issueType) ?? 0) + s);
  }

  const rootCause = Math.max(
    0,
    ...ROOT_CAUSE_TYPES.map((t) => scores.get(t) ?? 0),
  );
  if (rootCause >= ROOT_CAUSE_FLOOR) {
    scores.delete("DELAY");
    // Crowding is only interesting on its own; alongside a named cause it is a
    // consequence, not the story.
    if ((scores.get("CROWDING") ?? 0) < 8) scores.delete("CROWDING");
  }

  const ranked = [...scores.entries()].map(([issueType, score]) => ({ issueType, score }));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return ISSUE_PRIORITY.indexOf(a.issueType) - ISSUE_PRIORITY.indexOf(b.issueType);
  });
  return ranked;
}

export function extractIssueType(text: string, headline?: string): IssueType {
  return scoreIssueTypes(text, headline)[0]?.issueType ?? "UNKNOWN";
}

export function scoreSeverity(text: string): number {
  const u = upper(text);
  let best = 0;
  let bestRank = -1;
  for (const rule of SEVERITY_RULES) {
    if (rule.pattern.test(u)) {
      const rank = ["INFO", "MINOR", "MAJOR", "SEVERE"].indexOf(rule.severity);
      const score = rank * 100 + rule.weight;
      if (score > bestRank * 100 + best) {
        best = rule.weight;
        bestRank = rank;
      }
    }
  }
  return bestRank < 0 ? 0 : bestRank * 100 + best;
}

export function extractSeverity(text: string): Severity {
  const u = upper(text);
  let best: Severity = "INFO";
  let bestRank = -1;
  let bestWeight = -1;
  for (const rule of SEVERITY_RULES) {
    if (!rule.pattern.test(u)) continue;
    const rank = ["INFO", "MINOR", "MAJOR", "SEVERE"].indexOf(rule.severity);
    if (rank > bestRank || (rank === bestRank && rule.weight > bestWeight)) {
      best = rule.severity;
      bestRank = rank;
      bestWeight = rule.weight;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const MONTHS_MS: Record<string, number> = {
  januari: 1, january: 1, jan: 1,
  februari: 2, february: 2, feb: 2,
  mac: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5, may: 5,
  jun: 6, june: 6,
  julai: 7, july: 7, jul: 7,
  ogos: 8, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, october: 10, oct: 10, okt: 10,
  november: 11, nov: 11,
  disember: 12, december: 12, dec: 12, dis: 12,
};

const MONTH_ALT = Object.keys(MONTHS_MS).join("|");
const DATE_RE = new RegExp(
  `\\b(\\d{1,2})\\s+(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`,
  "gi",
);

export interface RawDate {
  day: number;
  month: number;
  year: number | null;
  index: number;
  surface: string;
}

export function findDates(text: string): RawDate[] {
  const out: RawDate[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const month = MONTHS_MS[(m[2] ?? "").toLowerCase()];
    if (!month) continue;
    out.push({
      day: Number(m[1]),
      month,
      year: m[3] ? Number(m[3]) : null,
      index: m.index ?? 0,
      surface: m[0],
    });
  }
  return out;
}

/** Local (Asia/Kuala_Lumpur) calendar date of an ISO instant, as YYYY-MM-DD. */
export function localDate(iso: string): string {
  const t = Date.parse(iso) + 8 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Add whole days to a YYYY-MM-DD date string. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The body dateline ("KUALA LUMPUR, 27 Januari 2023"). This is the date the
 * operator says it published; the PDF CreationDate supplies the clock time.
 */
export function parseBodyDateline(
  text: string,
  fallbackYear: number,
): { date: string; surface: string } | null {
  const re = new RegExp(
    `(?:KUALA\\s+LUMPUR|SUBANG\\s+JAYA|PETALING\\s+JAYA|SHAH\\s+ALAM|PUTRAJAYA|KUANTAN|PENANG|GEORGE\\s+TOWN)\\s*,?\\s*(\\d{1,2})\\s+(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`,
    "i",
  );
  const m = re.exec(fold(text));
  if (!m) return null;
  const month = MONTHS_MS[(m[2] ?? "").toLowerCase()];
  if (!month) return null;
  const day = Number(m[1]);
  const year = m[3] ? Number(m[3]) : fallbackYear;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return null;
  return { date: iso, surface: m[0] };
}

// ---------------------------------------------------------------------------
// Times of day
// ---------------------------------------------------------------------------

const MERIDIEM = "(pagi|petang|malam|tengah\\s*hari|tengahari|tengah\\s*malam|subuh)";
/** "jam 8.36 pagi", "pukul 9:51 malam", "pada 4.24 petang" (no jam/pukul). */
const TIME_RE = new RegExp(
  `(?:(?:jam|pukul)\\s+)?\\b(\\d{1,2})[.:](\\d{2})\\s*${MERIDIEM}?`,
  "gi",
);
/** "jam 6 pagi", "pukul 5 petang" — whole hours, only with jam/pukul or meridiem. */
const HOUR_RE = new RegExp(
  `(?:jam|pukul)\\s+(\\d{1,2})\\s*${MERIDIEM}\\b`,
  "gi",
);

export function meridiemTo24(hour: number, meridiem: string | undefined): number {
  const m = (meridiem ?? "").toLowerCase().replace(/\s+/g, " ");
  const h = hour % 24;
  if (m === "tengah malam") return h === 12 ? 0 : h;
  if (m === "pagi" || m === "subuh") return h === 12 ? 0 : h;
  if (m === "tengah hari" || m === "tengahari") return h === 12 ? 12 : h < 12 ? h + 12 : h;
  if (m === "petang") return h === 12 ? 12 : h < 12 ? h + 12 : h;
  if (m === "malam") return h === 12 ? 0 : h < 12 ? h + 12 : h;
  return h;
}

const RESTORE_BEFORE =
  /PULIH|DIPULIHKAN|KEMBALI|DIBUKA\s+SEMULA|SELESAI|DIAKTIFKAN|BERJAYA\s+DIPULIHKAN|PEMULIHAN/;
const RESTORE_AFTER = /^\s*[^.;]{0,60}?\b(?:PULIH|DIPULIHKAN|DIBUKA\s+SEMULA|SELESAI)\b/;
const SCHEDULE_BEFORE =
  /WAKTU\s+OPERASI|OPERASI\s+STESEN|SETIAP\s+HARI|BEROPERASI|DIBUKA\s+KEPADA\s+PENUMPANG|JADUAL\s+OPERASI|WAKTU\s+PUNCAK|JAM\s+OPERASI/;
const ONSET_BEFORE =
  /BERLAKU|DIKESAN|DILAPORKAN|TERPUTUS|TERHENTI|MULA\b|BERMULA|SEJAK|MENGALAMI|EKORAN|AKIBAT|KEJADIAN|INSIDEN|KEMALANGAN|KEBAKARAN|DITEMUI|MENYEBABKAN|TIDAK\s+BERFUNGSI|GAGAL|TERKANDAS|MENCETUS|MELETUS|DIMULAKAN|TERJEJAS/;
const ONSET_AFTER =
  /^\s*[^.;]{0,60}?\b(?:MENYEBABKAN|MENGALAMI|TERKANDAS|TERHENTI|TERPUTUS|TIDAK\s+BERFUNGSI|TERJEJAS|GAGAL|BERGERAK\s+LEBIH\s+PERLAHAN)\b/;

function roleFor(before: string, after: string): TimeRole {
  const b = upper(before);
  const a = upper(after);
  if (RESTORE_BEFORE.test(b) || RESTORE_AFTER.test(a)) return "restore";
  if (SCHEDULE_BEFORE.test(b)) return "schedule";
  if (ONSET_BEFORE.test(b) || ONSET_AFTER.test(a)) return "onset";
  return "unknown";
}

export function extractTimeMentions(text: string): TimeMention[] {
  const folded = fold(text);
  const out: TimeMention[] = [];
  const push = (
    hour: number,
    minute: number,
    meridiem: string | undefined,
    index: number,
    surface: string,
  ) => {
    if (hour > 23 || minute > 59) return;
    const before = folded.slice(Math.max(0, index - 90), index);
    const after = folded.slice(index + surface.length, index + surface.length + 70);
    out.push({
      secondsOfDay: meridiemTo24(hour, meridiem) * 3600 + minute * 60,
      surface: surface.trim(),
      role: roleFor(before, after),
      index,
      context: clip(`${before}«${surface}»${after}`, 160),
    });
  };

  for (const m of folded.matchAll(TIME_RE)) {
    const idx = m.index ?? 0;
    // Require either an explicit jam/pukul prefix or a meridiem word, otherwise
    // "1.27 juta" and "9.51" inside prose would be read as clock times.
    const prefix = folded.slice(Math.max(0, idx - 6), idx);
    if (!/jam\s*$|pukul\s*$/i.test(prefix) && !m[3]) continue;
    push(Number(m[1]), Number(m[2]), m[3], idx, m[0]);
  }
  for (const m of folded.matchAll(HOUR_RE)) {
    const idx = m.index ?? 0;
    if (out.some((t) => Math.abs(t.index - idx) < 4)) continue;
    push(Number(m[1]), 0, m[2], idx, m[0]);
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

// ---------------------------------------------------------------------------
// Onset estimation
// ---------------------------------------------------------------------------

/**
 * Malay relative day references. These are NOT interchangeable:
 *   "semalam" / "malam tadi"  -> the previous day ("malam tadi" = last night)
 *   "pagi tadi" / "petang tadi" -> EARLIER TODAY ("petang tadi" = this afternoon)
 * Treating "petang tadi" as yesterday pushed one monorail onset back 24 hours
 * and inflated its lead time from 84 to 1525 minutes.
 */
const RELATIVE_YESTERDAY = /\b(semalam|malam\s+tadi|malam\s+semalam)\b/i;
const RELATIVE_TODAY = /\b(pagi\s+tadi|petang\s+tadi|tengah\s+hari\s+tadi|siang\s+tadi|sebentar\s+tadi|tadi)\b/i;

/**
 * Estimate when the disruption began, from the document's own words.
 *
 * Basis, in order of preference:
 *   explicit_time — an onset-role clock time, anchored to the nearest explicit
 *                   date, "semalam", or the dateline.
 *   date_only     — an explicit date with no clock time (00:00 local).
 *   dateline_only — nothing usable; the dateline date at 00:00 local.
 *
 * This is the anchor for lead time. See `docs/EVAL-METHOD.md`.
 */
export function estimateOnset(
  text: string,
  publishedAt: string,
  dateline: { date: string } | null,
  mentions: TimeMention[],
): OnsetEstimate {
  const folded = fold(text);
  const pubDate = localDate(publishedAt);
  const datelineDate = dateline?.date ?? pubDate;
  const dates = findDates(folded);

  /**
   * A statement can only describe something that has already happened, so an
   * incident date must be on or before the publication date. This is what keeps
   * "akan ditutup pada 1 April 2022" (a future plan) from being read as the
   * onset of a 14 March 2022 statement — 6 documents had exactly that bug.
   */
  const isPlausibleOnsetDate = (iso: string): boolean => {
    const t = Date.parse(`${iso}T00:00:00+08:00`);
    if (Number.isNaN(t)) return false;
    const pub = Date.parse(`${pubDate}T00:00:00+08:00`);
    const age = (pub - t) / 86400_000;
    return age >= -0.5 && age <= 60;
  };

  const anchorFor = (index: number): DateAnchor => {
    // "semalam" / "petang tadi" can appear on either side of the clock time
    // ("...berlaku pada jam 6.56 petang itu ... petang semalam"), so widen the
    // window forwards as well as backwards.
    const around = folded.slice(Math.max(0, index - 130), index + 90);
    // Yesterday is tested first so that "malam tadi" is not swallowed by the
    // bare "tadi" alternative in RELATIVE_TODAY.
    if (RELATIVE_YESTERDAY.test(around)) {
      return {
        date: addDays(pubDate, -1),
        surface: "semalam",
        index,
        kind: "relative_yesterday",
      };
    }
    if (RELATIVE_TODAY.test(around)) {
      return { date: pubDate, surface: "tadi", index, kind: "relative_today" };
    }
    const nearby = dates.filter(
      (d) => d.index < index && d.index >= Math.max(0, index - 220),
    );
    for (let i = nearby.length - 1; i >= 0; i--) {
      const d = nearby[i]!;
      const year = d.year ?? Number(pubDate.slice(0, 4));
      const iso = `${year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      if (isPlausibleOnsetDate(iso)) {
        return { date: iso, surface: d.surface, index: d.index, kind: "explicit" };
      }
    }
    return { date: datelineDate, surface: datelineDate, index, kind: "dateline" };
  };

  const onsetMentions = mentions.filter((m) => m.role === "onset");
  if (onsetMentions.length > 0) {
    // Earliest onset mention wins: the disruption began when it was first seen,
    // and later mentions are usually updates or a second incident.
    let best: { at: number; mention: TimeMention; anchor: DateAnchor } | null = null;
    for (const m of onsetMentions) {
      const anchor = anchorFor(m.index);
      // `secondsOfDay` is seconds after LOCAL midnight (Asia/Kuala_Lumpur), so
      // the day is anchored at 00:00+08:00, not 00:00Z.
      const at = Date.parse(`${anchor.date}T00:00:00+08:00`) + m.secondsOfDay * 1000;
      if (best === null || at < best.at) best = { at, mention: m, anchor };
    }
    if (best) {
      return {
        at: new Date(best.at).toISOString(),
        basis: "explicit_time",
        evidence: `${best.anchor.kind}:${best.anchor.surface} ${best.mention.surface} — ${best.mention.context}`,
        role: "onset",
      };
    }
  }

  // No usable clock time. Fall back to an explicit incident date stated in the
  // body — but never the dateline itself (that is just the publication date)
  // and never a date in the future relative to publication.
  const explicit = dates
    .filter((d) => d.year !== null)
    .map((d) => ({
      d,
      iso: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`,
    }))
    .filter((x) => x.iso !== datelineDate && isPlausibleOnsetDate(x.iso))
    .sort((a, b) => a.d.index - b.d.index)[0];
  if (explicit) {
    return {
      at: new Date(Date.parse(`${explicit.iso}T00:00:00+08:00`)).toISOString(),
      basis: "date_only",
      evidence: explicit.d.surface,
      role: "unknown",
    };
  }

  return {
    at: new Date(Date.parse(`${datelineDate}T00:00:00+08:00`)).toISOString(),
    basis: "dateline_only",
    evidence: datelineDate,
    role: "unknown",
  };
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

/**
 * The headline is the run of mostly-uppercase lines between the "SIARAN MEDIA"
 * banner and the dateline.
 *
 * The corpus extracts inconsistently: some PDFs keep one line per source line,
 * others collapse the whole first page onto a single line. So this works on the
 * character offset of the dateline rather than on line indices, and falls back
 * to the first substantive run of capitals anywhere in the header block.
 */
export function extractHeadline(text: string): string {
  const folded = fold(text);
  const dateline = new RegExp(
    `(?:KUALA\\s+LUMPUR|SUBANG\\s+JAYA|PETALING\\s+JAYA|SHAH\\s+ALAM|PUTRAJAYA)\\s*,?\\s*\\d{1,2}\\s+(${MONTH_ALT})\\b`,
    "i",
  ).exec(folded);
  const headEnd = dateline ? dateline.index : Math.min(folded.length, 900);
  let head = folded.slice(0, headEnd);

  for (const b of BOILERPLATE) head = head.replace(new RegExp(b.source, `${b.flags}g`), " ");

  const lines = head
    .split("\n")
    .flatMap((l) => l.split(/\s{3,}/))
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const scored = lines.map((l) => ({
    l,
    upperRatio: (l.match(/[A-Z]/g) ?? []).length / Math.max(1, l.replace(/[^A-Za-z]/g, "").length || 1),
  }));
  const caps = scored.filter((s) => s.upperRatio > 0.6 && s.l.length > 6);
  const joined = (caps.length > 0 ? caps : scored)
    .map((s) => s.l)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (joined.length > 0) return clip(joined, 240);

  // Header block was pure boilerplate: fall back to the first substantive
  // sentence after the dateline.
  const tail = folded.slice(headEnd);
  const firstSentence = tail.split(/(?<=[.!?])\s+/).find((s) => s.trim().length > 20);
  return clip((firstSentence ?? tail).trim(), 240);
}

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

export interface Classification {
  kind: DocKind;
  reason: string;
  disruptionScore: number;
  strongNonIncident: number;
  weakNonIncident: number;
  plannedScore: number;
}

export function classifyDocument(text: string): Classification {
  if (text.trim().length < 60) {
    return {
      kind: "UNREADABLE",
      reason: "extracted text shorter than 60 characters",
      disruptionScore: 0,
      strongNonIncident: 0,
      weakNonIncident: 0,
      plannedScore: 0,
    };
  }
  const u = upper(text);
  const disruptionScore = DISRUPTION_MARKERS.filter((r) => r.test(u)).length;
  const strongNonIncident = STRONG_NON_INCIDENT_MARKERS.filter((r) => r.test(u)).length;
  const weakNonIncident = WEAK_NON_INCIDENT_MARKERS.filter((r) => r.test(u)).length;
  const plannedScore = PLANNED_MARKERS.filter((r) => r.test(u)).length;
  const lineIds = extractLineIds(text);
  const base = { disruptionScore, strongNonIncident, weakNonIncident, plannedScore };

  if (disruptionScore === 0) {
    return { kind: "NON_INCIDENT", reason: "no disruption vocabulary present", ...base };
  }
  if (lineIds.length === 0) {
    return {
      kind: "NON_INCIDENT",
      reason: "disruption vocabulary but no identifiable rail line",
      ...base,
    };
  }
  // A single decisive non-incident marker beats any amount of disruption talk:
  // "UJIAN MENUNJUKKAN PETANDA POSITIF" mentions LRT Laluan Kelana Jaya a dozen
  // times but is a test-result announcement, not a disruption.
  if (strongNonIncident >= 1) {
    return {
      kind: "NON_INCIDENT",
      reason: `decisive non-incident marker present (${strongNonIncident})`,
      ...base,
    };
  }
  // Planned works and closures announced in advance are service changes, not
  // reliability failures — reported separately rather than forced into the set.
  if (plannedScore >= 2 && disruptionScore <= 2) {
    return {
      kind: "PLANNED_SERVICE_CHANGE",
      reason: `planned markers (${plannedScore}) dominate disruption markers (${disruptionScore})`,
      ...base,
    };
  }
  if (weakNonIncident >= 2 && weakNonIncident >= disruptionScore) {
    return {
      kind: "NON_INCIDENT",
      reason: `weak non-incident markers (${weakNonIncident}) match or exceed disruption markers (${disruptionScore})`,
      ...base,
    };
  }
  return {
    kind: "INCIDENT",
    reason: `disruption markers (${disruptionScore}) with line(s) ${lineIds.join(",")}`,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Statement parsing
// ---------------------------------------------------------------------------

export function parseStatement(doc: ExtractedDoc, index: StationIndex): ParsedStatement {
  const text = doc.text;
  const classification = classifyDocument(text);
  const publishedAt = doc.pdfCreatedAt ?? doc.pdfModifiedAt ?? "1970-01-01T00:00:00.000Z";
  const pubDate = localDate(publishedAt);
  const dateline = parseBodyDateline(text, Number(pubDate.slice(0, 4)));
  const mentions = extractTimeMentions(text);
  const onset = estimateOnset(text, publishedAt, dateline, mentions);
  const stations = extractStations(text, index);
  const lineIds = extractLineIds(text);
  const headline = extractHeadline(text);

  const datelineDisagrees =
    dateline !== null && Math.abs(Date.parse(`${dateline.date}T00:00:00Z`) - Date.parse(`${pubDate}T00:00:00Z`)) >= 86400_000;

  return {
    filename: doc.filename,
    kind: classification.kind,
    kindReason: classification.reason,
    headline,
    lineIds,
    stations,
    stationIds: [...new Set(stations.map((s) => s.stationId))],
    issueType: extractIssueType(text, headline),
    issueScores: scoreIssueTypes(text, headline),
    severity: extractSeverity(text),
    severityScore: scoreSeverity(text),
    publishedAt,
    publishedAtSource: "pdf_creation_date",
    bodyDateline: dateline?.date ?? null,
    datelineDisagrees,
    onset,
    timeMentions: mentions,
    textLength: text.length,
  };
}

export { slug };
