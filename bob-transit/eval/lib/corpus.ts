/**
 * Builds the NON-OFFICIAL evidence corpus the pipeline is scored against.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SYNTHETIC — READ THIS BEFORE QUOTING ANY NUMBER FROM THE EVAL
 * ---------------------------------------------------------------------------
 * myrapid.com.my is the OPERATOR. Every document in the archive is an official
 * statement, so the archive contains zero non-official evidence: no tweets, no
 * PULSE observations, no station PA logs. Without non-official evidence there is
 * no `firstSeenAt`, and without `firstSeenAt` there is no lead time.
 *
 * So the corpus is synthesised, deterministically, from the labelled incidents.
 * It is a MODEL, not a measurement. Every parameter below is an assumption about
 * how fast a disruption becomes visible to a commuter-driven ingest, and each is
 * stated with its rationale so a reviewer can change it and re-run.
 *
 * The one thing that is NOT assumed is the anchor: `onsetAt` is read out of the
 * operator's own statement ("berlaku pada jam 8.36 pagi"), and `publishedAt` is
 * the operator's own PDF timestamp. The gap between them — the operator's
 * acknowledgement latency — is real, document-derived data. The synthetic part
 * is only how much of that gap our pipeline could have captured.
 *
 * Corpus layout per incident:
 *   e0  SOCIAL            onset + delta                 (always)
 *   e1  SOCIAL            onset + delta + 4 min         (p = severity table)
 *   e2  SOCIAL            onset + delta + 11 min        (p = severity table)
 *   e3  SOCIAL            onset + delta + 19 min        (p = severity table)
 *   e4  OFFICIAL_REALTIME onset + delta + 31 min        (p = severity table)
 *
 * `delta` (minutes from disruption onset to the first public observation) is
 * drawn uniformly from [2, 9] — a passenger on the platform posts within a
 * couple of minutes; the range covers tunnel/poor-signal conditions.
 *
 * Text is written in the register the real corpus uses, and names the line and
 * the station the same way a commuter would, so the pipeline has to do real
 * parsing to recover them.
 */

import type { IssueType, Severity, SourceClass } from "@/lib/contracts";
import type { LabelledCorpus, LabelledIncident } from "./label";
import { localDate } from "./parse";
import { rng, type Rng } from "./rng";
import { stationIndex } from "./stations";
import { shortHash } from "./text";

export interface CorpusEvidence {
  id: string;
  /** sha256-derived id of the labelled incident, or null for a decoy. */
  incidentId: string | null;
  /** True for false-alarm chatter with no corresponding operator statement. */
  isDecoy: boolean;
  sourceClass: SourceClass;
  /** DISTINCT authors only; identical text from a second author is a repost. */
  authorId: string;
  authorHandle: string;
  rawText: string;
  publishedAt: string;
  language: "ms" | "en";
  contentHash: string;
}

export interface EvidenceCorpus {
  version: string;
  method: string;
  assumptions: Record<string, string>;
  counts: {
    evidence: number;
    incidentsCovered: number;
    incidentsSkipped: number;
    decoys: number;
    decoyEvidence: number;
    reposts: number;
  };
  evidence: CorpusEvidence[];
}

// ---------------------------------------------------------------------------
// Assumption tables
// ---------------------------------------------------------------------------

/** Minutes from onset to the first public observation. Uniform over [2, 9]. */
export const FIRST_OBSERVATION_DELTA = { min: 2, max: 9 } as const;

/** Follow-up observation offsets, in minutes after the first one. */
export const FOLLOW_UP_OFFSETS = [4, 11, 19, 31] as const;

/**
 * Probability of each follow-up existing, by severity. Severe stoppages get
 * posted about repeatedly; a minor delay usually gets one post or none.
 */
export const FOLLOW_UP_PROBABILITY: Record<Severity, readonly [number, number, number, number]> = {
  SEVERE: [0.9, 0.8, 0.65, 0.55],
  MAJOR: [0.75, 0.6, 0.4, 0.4],
  MINOR: [0.5, 0.3, 0.15, 0.2],
  INFO: [0.4, 0.2, 0.1, 0.15],
};

/** Probability that a cluster contains one repost (identical text, new author). */
export const REPOST_PROBABILITY = 0.5;

/** How many decoy clusters (false-alarm chatter) to inject. */
export const DECOY_COUNT = 12;
export const DECOY_SEVERITY_MIX: Severity[] = [
  "MINOR", "MINOR", "MINOR", "MINOR", "MINOR", "MINOR",
  "MAJOR", "MAJOR", "MAJOR", "MAJOR",
  "SEVERE", "SEVERE",
];

// ---------------------------------------------------------------------------
// Malay evidence text
// ---------------------------------------------------------------------------

const LINE_DISPLAY: Record<string, string> = {
  KJ: "Laluan Kelana Jaya",
  KGL: "MRT Laluan Kajang",
  PYL: "MRT Laluan Putrajaya",
  AG: "Laluan Ampang",
  PH: "Laluan Sri Petaling",
  MR: "Monorel",
  BRT: "BRT Laluan Sunway",
  SA: "Laluan Shah Alam",
};

/**
 * A natural Malay phrase for each frozen issue type, so the pipeline can
 * actually recover the issue from the text. Decoys use the same vocabulary.
 */
const ISSUE_PHRASE: Record<IssueType, string> = {
  VEHICLE_BREAKDOWN: "tren terkandas",
  SIGNAL_FAULT: "gangguan sistem semboyan",
  TRACK_FAULT: "kerosakan landasan",
  ELEVATOR_FAULT: "lif dan eskalator rosak",
  DOOR_FAULT: "pintu tren rosak",
  CROWDING: "kesesakan teruk",
  DELAY: "kelewatan jadual perjalanan",
  ROAD_BLOCKED: "pencerobohan landasan",
  WEATHER: "cuaca buruk",
  UNKNOWN: "gangguan perkhidmatan",
};

const SOCIAL_TEMPLATES: Array<(p: Parts) => string> = [
  (p) => `Tren ${p.line} tersangkut kat Stesen ${p.station}, ada ${p.issue}. Dah ${p.mins} minit tak bergerak. ${p.complaint}`,
  (p) => `Ada ${p.issue} di Stesen ${p.station}. ${p.line} memang teruk hari ini. ${p.complaint}`,
  (p) => `${p.line}: ${p.issue} di Stesen ${p.station}. ${p.complaint} #rapidkl`,
  (p) => `Stesen ${p.station} sekarang sesak sebab ${p.issue} kat ${p.line}. ${p.complaint}`,
  (p) => `Apa jadi ${p.line}? Kat Stesen ${p.station} ada ${p.issue}, dah ${p.mins} minit. ${p.complaint}`,
  (p) => `Amaran: ${p.issue} pada ${p.line} berhampiran Stesen ${p.station}. ${p.complaint}`,
];

const REALTIME_TEMPLATES: Array<(parts: Parts) => string> = [
  (p) => `[PULSE] ${p.issue} dilaporkan pada ${p.line} di Stesen ${p.station}. Kelewatan ${p.mins} minit.`,
  (p) => `[PULSE] Gangguan perkhidmatan ${p.line}: ${p.issue} dikesan di Stesen ${p.station}.`,
  (p) => `[Stesen] Pengumuman: ${p.issue} pada ${p.line} di Stesen ${p.station}. Sila guna perkhidmatan alternatif.`,
];

interface Parts {
  line: string;
  station: string;
  issue: string;
  mins: number;
  complaint: string;
}

const COMPLAINTS = [
  "Takde pengumuman langsung.",
  "Dah lambat nak pergi kerja.",
  "Penumpang makin ramai.",
  "Harap cepat pulih.",
  "Kena cari jalan lain ni.",
  "Sesiapa tahu apa jadi?",
];

function lineDisplay(lineId: string | undefined): string {
  if (!lineId) return "LRT";
  return LINE_DISPLAY[lineId] ?? lineId;
}

/** Human-readable station name for the evidence text, from the GTFS fixture. */
function stationDisplay(stationId: string | undefined): string {
  if (!stationId) return "KL Sentral";
  const entry = stationIndex().entries.find((e) => e.stopId === stationId);
  if (!entry) return stationId.replace(/^KTM_/, "").replace(/_/g, " ");
  return entry.name.split(" - ")[0]!.trim();
}

function isoAddMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function makeEvidence(
  seedKey: string,
  incidentId: string | null,
  isDecoy: boolean,
  sourceClass: SourceClass,
  authorIndex: number,
  rawText: string,
  publishedAt: string,
): CorpusEvidence {
  const authorId = `${sourceClass === "SOCIAL" ? "social" : "rt"}-${shortHash(`${seedKey}|author|${authorIndex}`).slice(0, 10)}`;
  const id = `ev-${shortHash(`${seedKey}|${sourceClass}|${authorIndex}|${publishedAt}`).slice(0, 16)}`;
  return {
    id,
    incidentId,
    isDecoy,
    sourceClass,
    authorId,
    authorHandle: `@${authorId}`,
    rawText,
    publishedAt,
    language: "ms",
    contentHash: shortHash(rawText),
  };
}

/** Build the evidence cluster for one incident (or one decoy). */
function buildCluster(
  seedKey: string,
  incidentId: string | null,
  isDecoy: boolean,
  onsetAt: string,
  lineIds: string[],
  stationIds: string[],
  issueType: IssueType,
  severity: Severity,
): CorpusEvidence[] {
  const r: Rng = rng(seedKey);
  const line = lineDisplay(lineIds.length > 0 ? lineIds[r.int(0, lineIds.length - 1)] : undefined);
  const station = stationDisplay(
    stationIds.length > 0 ? stationIds[r.int(0, stationIds.length - 1)] : undefined,
  );
  const issue = ISSUE_PHRASE[issueType];
  const baseMins = r.int(3, 25);
  const complaint = r.pick(COMPLAINTS);

  const delta = r.int(FIRST_OBSERVATION_DELTA.min, FIRST_OBSERVATION_DELTA.max);
  const probs = FOLLOW_UP_PROBABILITY[severity];
  const out: CorpusEvidence[] = [];

  const partsFor = (authorIndex: number): Parts => ({
    line,
    station,
    issue,
    mins: baseMins + authorIndex * 2,
    complaint,
  });

  const firstText = SOCIAL_TEMPLATES[0]!(partsFor(0));
  out.push(
    makeEvidence(seedKey, incidentId, isDecoy, "SOCIAL", 0, firstText, isoAddMinutes(onsetAt, delta)),
  );

  for (let i = 0; i < FOLLOW_UP_OFFSETS.length; i++) {
    if (!r.chance(probs[i]!)) continue;
    const isRealtime = i === FOLLOW_UP_OFFSETS.length - 1;
    const authorIndex = i + 1;
    const text = isRealtime
      ? REALTIME_TEMPLATES[authorIndex % REALTIME_TEMPLATES.length]!(partsFor(authorIndex))
      : SOCIAL_TEMPLATES[authorIndex % SOCIAL_TEMPLATES.length]!(partsFor(authorIndex));
    out.push(
      makeEvidence(
        seedKey,
        incidentId,
        isDecoy,
        isRealtime ? "OFFICIAL_REALTIME" : "SOCIAL",
        authorIndex,
        text,
        isoAddMinutes(onsetAt, delta + FOLLOW_UP_OFFSETS[i]!),
      ),
    );
  }

  // One repost: identical text, different author. The pipeline must dedupe it
  // by content hash and NOT count it as an extra corroborating author.
  if (r.chance(REPOST_PROBABILITY)) {
    out.push(
      makeEvidence(
        seedKey,
        incidentId,
        isDecoy,
        "SOCIAL",
        90,
        firstText,
        isoAddMinutes(onsetAt, delta + 2),
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Corpus construction
// ---------------------------------------------------------------------------

/**
 * Incidents that can enter the LEAD-TIME sample: a clock time taken from the
 * document, an operator acknowledgement inside one day, and no contradiction
 * between the two. Others still count for precision, recall and coverage.
 */
export function isLeadTimeEligible(incident: LabelledIncident): boolean {
  return (
    incident.onsetBasis === "explicit_time" &&
    incident.operatorLatencyMinutes !== null &&
    incident.operatorLatencyMinutes >= 0 &&
    incident.operatorLatencyMinutes <= 24 * 60 &&
    !incident.onsetAfterPublication
  );
}

interface DecoySlot {
  lineId: string;
  stationId: string;
  day: string;
  issueType: IssueType;
}

const DECOY_ISSUES: IssueType[] = [
  "DELAY", "CROWDING", "VEHICLE_BREAKDOWN", "SIGNAL_FAULT", "TRACK_FAULT", "DOOR_FAULT",
];

function pickDecoySlots(corpus: LabelledCorpus, count: number): DecoySlot[] {
  const index = stationIndex();
  const used = new Set(
    corpus.incidents.flatMap((i) => i.stationIds.map((s) => `${localDate(i.publishedAt)}|${s}`)),
  );
  const byLine = new Map<string, string[]>();
  for (const e of index.entries) {
    if (!e.lineId || e.lineId === "KTM") continue;
    const list = byLine.get(e.lineId) ?? [];
    list.push(e.stopId);
    byLine.set(e.lineId, list);
  }
  const lines = [...byLine.keys()].sort();
  const r = rng("bob-transit|decoy-slots|v1");
  const slots: DecoySlot[] = [];
  let guard = 0;
  while (slots.length < count && guard < count * 500) {
    guard++;
    const lineId = r.pick(lines);
    const stationId = r.pick(byLine.get(lineId)!);
    const day = `202${r.int(1, 4)}-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`;
    const key = `${day}|${stationId}`;
    if (used.has(key)) continue;
    used.add(key);
    slots.push({ lineId, stationId, day, issueType: r.pick(DECOY_ISSUES) });
  }
  return slots;
}

export function buildEvidenceCorpus(corpus: LabelledCorpus): EvidenceCorpus {
  const evidence: CorpusEvidence[] = [];
  let covered = 0;
  let skipped = 0;

  for (const incident of corpus.incidents) {
    const seedKey = `bob-transit|incident|${incident.contentId}`;
    const delta = rng(seedKey).int(FIRST_OBSERVATION_DELTA.min, FIRST_OBSERVATION_DELTA.max);
    const firstObservationAt = Date.parse(incident.onsetAt) + delta * 60_000;
    // The first observation must land before the operator publishes, otherwise
    // the "evidence" would be reporting something the operator already said.
    //
    // Evidence is generated for EVERY incident regardless of how precise the
    // onset anchor is. An earlier version only generated evidence where the body
    // stated a clock time, which silently capped recall at 20/41 — a property of
    // the corpus, not of the pipeline. Precision and recall must see all of them.
    if (Number.isNaN(firstObservationAt) || firstObservationAt >= Date.parse(incident.publishedAt)) {
      skipped++;
      continue;
    }
    covered++;
    evidence.push(
      ...buildCluster(
        seedKey,
        incident.contentId,
        false,
        incident.onsetAt,
        incident.lineIds,
        incident.stationIds,
        incident.issueType,
        incident.severity,
      ),
    );
  }

  const slots = pickDecoySlots(corpus, DECOY_COUNT);
  for (const [i, slot] of slots.entries()) {
    const severity = DECOY_SEVERITY_MIX[i % DECOY_SEVERITY_MIX.length]!;
    const onsetAt = new Date(Date.parse(`${slot.day}T12:00:00+08:00`)).toISOString();
    evidence.push(
      ...buildCluster(
        `bob-transit|decoy|${i}|${slot.day}|${slot.stationId}`,
        null,
        true,
        onsetAt,
        [slot.lineId],
        [slot.stationId],
        slot.issueType,
        severity,
      ),
    );
  }

  evidence.sort((a, b) =>
    a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : 1,
  );

  const firstTexts = new Map<string, number>();
  for (const e of evidence) firstTexts.set(e.contentHash, (firstTexts.get(e.contentHash) ?? 0) + 1);

  return {
    version: "1.0.0",
    method:
      "Deterministic synthetic non-official evidence, seeded by sha256(incident.contentId). " +
      "Anchored on the operator's own stated onset time; see `assumptions`.",
    assumptions: {
      firstObservationDeltaMinutes: `uniform integer in [${FIRST_OBSERVATION_DELTA.min}, ${FIRST_OBSERVATION_DELTA.max}], from onset to the first public observation`,
      followUpOffsetsMinutes: FOLLOW_UP_OFFSETS.join(", "),
      followUpProbabilityBySeverity: JSON.stringify(FOLLOW_UP_PROBABILITY),
      repostProbability: String(REPOST_PROBABILITY),
      decoyCount: String(DECOY_COUNT),
      decoyMeaning:
        "False-alarm chatter clusters with no corresponding operator statement; they exist so precision is not trivially 1.0.",
      rng: "mulberry32 seeded with the first 4 bytes of sha256(seedKey); see eval/lib/rng.ts",
      notAMeasurement:
        "This corpus models how fast a disruption becomes visible. It is NOT observed social data, and precision/recall/lead-time derived from it are model outputs, not field measurements.",
    },
    counts: {
      evidence: evidence.length,
      incidentsCovered: covered,
      incidentsSkipped: skipped,
      decoys: slots.length,
      decoyEvidence: evidence.filter((e) => e.isDecoy).length,
      reposts: [...firstTexts.values()].filter((n) => n > 1).length,
    },
    evidence,
  };
}
