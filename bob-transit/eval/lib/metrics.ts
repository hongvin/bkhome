/**
 * Scoring: match emitted signals against the labelled ground truth and compute
 * precision, recall, coverage and median lead time.
 *
 * All definitions are stated here explicitly because the headline number is
 * sensitive to them, and a reviewer must be able to re-derive every figure.
 */

import type { EvalSignal } from "./pipeline";
import type { LabelledIncident } from "./label";

/** Two observations further apart than this are not the same incident. */
export const MATCH_WINDOW_MINUTES = 360;

export interface MatchPair {
  signalId: string;
  incidentId: string;
  /** |signal.firstSeenAt - incident.onsetAt|, minutes. */
  offsetMinutes: number;
}

export interface MatchResult {
  truePositives: MatchPair[];
  falsePositives: EvalSignal[];
  falseNegatives: LabelledIncident[];
  /** Incidents that got at least one signal naming their line, matched or not. */
  coveredIncidentIds: string[];
  precision: number;
  recall: number;
  coverage: number;
  f1: number;
}

function intersects(a: string[], b: string[]): boolean {
  return a.some((x) => b.includes(x));
}

/**
 * Full match — line AND issue AND station AND time. This is what "recall" means:
 * the pipeline did not merely notice something, it identified the right
 * disruption.
 */
export function signalsMatch(signal: EvalSignal, incident: LabelledIncident): boolean {
  if (!intersects(signal.lineIds, incident.lineIds)) return false;
  if (signal.issueType !== incident.issueType) return false;
  if (
    signal.stationIds.length > 0 &&
    incident.stationIds.length > 0 &&
    !intersects(signal.stationIds, incident.stationIds)
  ) {
    return false;
  }
  const offset = Math.abs(
    (Date.parse(signal.firstSeenAt) - Date.parse(incident.onsetAt)) / 60000,
  );
  return offset <= MATCH_WINDOW_MINUTES;
}

/**
 * Coverage match — the signal is about the incident's line AND falls inside the
 * incident's time window, but the issue type and exact station are NOT required.
 * This is deliberately weaker than `signalsMatch` so coverage answers "did the
 * pipeline notice something on the right line at the right time", while recall
 * answers "did it identify the right disruption".
 *
 * Line-only matching was tried first and was useless: with 8 lines, the 12 decoy
 * clusters covered every line and coverage sat at a meaningless 100%.
 */
export function signalsCover(signal: EvalSignal, incident: LabelledIncident): boolean {
  if (!intersects(signal.lineIds, incident.lineIds)) return false;
  const offset = Math.abs(
    (Date.parse(signal.firstSeenAt) - Date.parse(incident.onsetAt)) / 60000,
  );
  return offset <= MATCH_WINDOW_MINUTES;
}

export function matchSignals(
  signals: EvalSignal[],
  incidents: LabelledIncident[],
): MatchResult {
  // Greedy one-to-one assignment: for each signal, take the closest unmatched
  // incident. Signals and incidents are pre-sorted, so this is deterministic.
  const claimed = new Set<string>();
  const truePositives: MatchPair[] = [];
  const falsePositives: EvalSignal[] = [];

  for (const signal of signals) {
    const candidates = incidents
      .filter((i) => !claimed.has(i.contentId) && signalsMatch(signal, i))
      .map((i) => ({
        incident: i,
        offset: Math.abs((Date.parse(signal.firstSeenAt) - Date.parse(i.onsetAt)) / 60000),
      }))
      .sort((a, b) => a.offset - b.offset || (a.incident.contentId < b.incident.contentId ? -1 : 1));

    const best = candidates[0];
    if (!best) {
      falsePositives.push(signal);
      continue;
    }
    claimed.add(best.incident.contentId);
    truePositives.push({
      signalId: signal.id,
      incidentId: best.incident.contentId,
      offsetMinutes: Math.round(best.offset * 1000) / 1000,
    });
  }

  const falseNegatives = incidents.filter((i) => !claimed.has(i.contentId));
  const coveredIncidentIds = incidents
    .filter((i) => signals.some((s) => signalsCover(s, i)))
    .map((i) => i.contentId);

  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    coveredIncidentIds,
    precision,
    recall,
    coverage: incidents.length === 0 ? 0 : coveredIncidentIds.length / incidents.length,
    f1,
  };
}


// ---------------------------------------------------------------------------
// Event-level collapse
// ---------------------------------------------------------------------------

/**
 * Collapse a statement-level match to one unit per real-world event.
 *
 * The archive contains several statements about the same disruption (an initial
 * report, follow-ups, bus-bridging updates, restoration notices). Counting each
 * as a separate incident answers "did we flag every press release", which is not
 * the product question. This collapses them to "did we flag the disruption".
 *
 * A signal that matched any statement of an event counts as a match for that
 * event; false positives are unchanged.
 */
export function collapseToEvents(
  matches: MatchResult,
  signals: EvalSignal[],
  incidents: LabelledIncident[],
): MatchResult {
  const parentOf = new Map<string, string>();
  const parentByFilename = new Map(incidents.map((i) => [i.filename, i.contentId]));
  for (const i of incidents) {
    const parent = i.sameEventAs ? parentByFilename.get(i.sameEventAs) : undefined;
    parentOf.set(i.contentId, parent ?? i.contentId);
  }
  const events = incidents.filter((i) => !i.sameEventAs);
  const signalById = new Map(signals.map((s) => [s.id, s]));

  const byEvent = new Map<string, MatchPair>();
  for (const pair of matches.truePositives) {
    const eventId = parentOf.get(pair.incidentId) ?? pair.incidentId;
    if (!byEvent.has(eventId)) byEvent.set(eventId, { ...pair, incidentId: eventId });
  }
  const truePositives = [...byEvent.values()].sort((a, b) =>
    a.incidentId < b.incidentId ? -1 : 1,
  );

  const matchedEventIds = new Set(truePositives.map((p) => p.incidentId));
  const falseNegatives = events.filter((i) => !matchedEventIds.has(i.contentId));

  // A signal is a false positive only when it matches no statement at all.
  const falsePositives = matches.falsePositives;

  const coveredIncidentIds = events
    .filter((i) => {
      const members = incidents.filter((x) => (parentOf.get(x.contentId) ?? x.contentId) === i.contentId);
      return members.some((m) => signals.some((s) => signalsCover(s, m)));
    })
    .map((i) => i.contentId);

  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  void signalById;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    coveredIncidentIds,
    precision,
    recall,
    coverage: events.length === 0 ? 0 : coveredIncidentIds.length / events.length,
    f1,
  };
}

// ---------------------------------------------------------------------------
// Lead time
// ---------------------------------------------------------------------------

export interface LeadTimeSample {
  incidentId: string;
  headline: string;
  lineIds: string[];
  /** Operator's own PDF timestamp. */
  operatorNotifiedAt: string;
  /** Our pipeline's earliest evidence for this incident. */
  firstSeenAt: string;
  /** Onset read out of the operator's statement. */
  onsetAt: string;
  /** operatorNotifiedAt - firstSeenAt, minutes. The headline metric. */
  leadTimeMinutes: number;
  /** operatorNotifiedAt - onsetAt, minutes. Document-anchored, assumption-free. */
  operatorLatencyMinutes: number;
}

export interface LeadTimeResult {
  sample: LeadTimeSample[];
  medianLeadTimeMinutes: number | null;
  medianOperatorLatencyMinutes: number | null;
  /** Median if our ingest were instantaneous (delta = 0). Upper bound. */
  medianUpperBoundMinutes: number | null;
  minLeadTimeMinutes: number | null;
  maxLeadTimeMinutes: number | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Lead time for one incident = `operatorNotifiedAt - firstSeenAt`, where
 * `firstSeenAt` is the timestamp of the earliest evidence the pipeline actually
 * clustered for that incident. Positive means we were first.
 */
export function computeLeadTime(
  signals: EvalSignal[],
  incidents: LabelledIncident[],
  matches: MatchResult,
  isEligible: (incident: LabelledIncident) => boolean,
): LeadTimeResult {
  const byContentId = new Map(incidents.map((i) => [i.contentId, i]));
  const signalById = new Map(signals.map((s) => [s.id, s]));
  const sample: LeadTimeSample[] = [];

  for (const pair of matches.truePositives) {
    const incident = byContentId.get(pair.incidentId);
    const signal = signalById.get(pair.signalId);
    if (!incident || !signal) continue;
    if (!isEligible(incident)) continue;
    if (incident.operatorLatencyMinutes === null) continue;

    const lead = (Date.parse(incident.publishedAt) - Date.parse(signal.firstSeenAt)) / 60000;
    if (lead < 0) continue; // the operator was already public; not a lead
    sample.push({
      incidentId: incident.contentId,
      headline: incident.headline,
      lineIds: incident.lineIds,
      operatorNotifiedAt: incident.publishedAt,
      firstSeenAt: signal.firstSeenAt,
      onsetAt: incident.onsetAt,
      leadTimeMinutes: Math.round(lead * 1000) / 1000,
      operatorLatencyMinutes: incident.operatorLatencyMinutes,
    });
  }

  sample.sort((a, b) => a.leadTimeMinutes - b.leadTimeMinutes || (a.incidentId < b.incidentId ? -1 : 1));

  const leads = sample.map((s) => s.leadTimeMinutes);
  const latencies = sample.map((s) => s.operatorLatencyMinutes);

  return {
    sample,
    medianLeadTimeMinutes: median(leads),
    medianOperatorLatencyMinutes: median(latencies),
    // With an instantaneous ingest, lead time would equal the operator's own
    // acknowledgement latency. That is the ceiling this corpus can support.
    medianUpperBoundMinutes: median(latencies),
    minLeadTimeMinutes: leads.length > 0 ? Math.min(...leads) : null,
    maxLeadTimeMinutes: leads.length > 0 ? Math.max(...leads) : null,
  };
}
