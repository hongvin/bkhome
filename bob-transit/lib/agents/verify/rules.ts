/**
 * The Verifier's decision tables.
 *
 * These encode source precedence. They are deliberately small, explicit and
 * testable, because every one of them is a claim about how much a class of
 * evidence is worth — and getting that wrong is how the product invents a
 * breakdown that is not happening.
 */

import type { IssueType, Severity, SourceClass } from "@/lib/contracts";

import type { IngestCandidate, RealtimeObservationKind } from "@/lib/signals/types";

/**
 * How much an individual record of each class moves the issue-type vote.
 * OFFICIAL_STATEMENT is high-precision (confirmation); OFFICIAL_REALTIME is
 * position-only so it votes weakly; INTERNAL never votes.
 */
export const SOURCE_EVIDENCE_WEIGHT: Readonly<Record<SourceClass, number>> = {
  OFFICIAL_STATEMENT: 3,
  OFFICIAL_REALTIME: 1.5,
  SOCIAL: 1,
  INTERNAL: 0,
};

/** Floor severity for an issue type when the text carries no explicit cue. */
export const DEFAULT_SEVERITY: Readonly<Record<IssueType, Severity>> = {
  TRACK_FAULT: "MAJOR",
  SIGNAL_FAULT: "MAJOR",
  VEHICLE_BREAKDOWN: "MINOR",
  ELEVATOR_FAULT: "MINOR",
  DOOR_FAULT: "MINOR",
  CROWDING: "MINOR",
  DELAY: "MINOR",
  ROAD_BLOCKED: "MINOR",
  WEATHER: "MAJOR",
  UNKNOWN: "INFO",
};

/** Tie-break order: earlier means more specific. */
export const ISSUE_SPECIFICITY: readonly IssueType[] = [
  "TRACK_FAULT",
  "SIGNAL_FAULT",
  "VEHICLE_BREAKDOWN",
  "DOOR_FAULT",
  "ELEVATOR_FAULT",
  "WEATHER",
  "ROAD_BLOCKED",
  "CROWDING",
  "DELAY",
  "UNKNOWN",
];

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  INFO: 0,
  MINOR: 1,
  MAJOR: 2,
  SEVERE: 3,
};

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Realtime telemetry is trusted for POSITION, not for HEALTH.
 *
 *  - VEHICLE_STALLED: a stalled vehicle is weak evidence of a service fault.
 *  - PLATFORM_CROWD: an actual sensor reading of crowding.
 *  - VEHICLE_ABSENT:  returns null — the absence of a vehicle is NOT evidence of
 *    a fault, and must contribute nothing (not a penalty either).
 *  - SERVICE_NORMAL:  returns null — this is a denial, handled separately.
 */
export function issueTypeFromObservation(kind: RealtimeObservationKind): IssueType | null {
  switch (kind) {
    case "VEHICLE_STALLED":
      return "VEHICLE_BREAKDOWN";
    case "PLATFORM_CROWD":
      return "CROWDING";
    case "VEHICLE_ABSENT":
    case "SERVICE_NORMAL":
      return null;
  }
}

/** True when an observation contributes positive evidence at all. */
export function observationCountsAsEvidence(kind: RealtimeObservationKind | undefined): boolean {
  return kind === "VEHICLE_STALLED" || kind === "PLATFORM_CROWD";
}

export interface StalenessVerdict {
  stale: boolean;
  reason: string;
}

/**
 * Time checks. A report is rejected when it is outside the current incident
 * window, or when it explicitly references an older event and does not say the
 * problem is ongoing.
 */
export function checkStaleness(
  candidate: IngestCandidate,
  nowMs: number,
  windowMinutes: number,
): StalenessVerdict {
  const published = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(published)) {
    return { stale: true, reason: `unparseable publishedAt "${candidate.publishedAt}"` };
  }
  if (published > nowMs + 5 * 60_000) {
    return { stale: true, reason: "published after the reference instant" };
  }
  const ageMinutes = (nowMs - published) / 60_000;
  if (ageMinutes > windowMinutes) {
    return {
      stale: true,
      reason: `published ${Math.round(ageMinutes)} min before the reference instant, outside the ${windowMinutes} min window`,
    };
  }
  if (candidate.claimedTime.historical && !candidate.claimedTime.ongoing) {
    return {
      stale: true,
      reason:
        `references an event ${candidate.claimedTime.daysAgo ?? "?"} day(s) old ` +
        `("${candidate.claimedTime.raw ?? "past reference"}") and does not say it is ongoing`,
    };
  }
  return { stale: false, reason: "" };
}

export interface IssueVote {
  issueType: IssueType;
  weight: number;
  tally: Array<{ issueType: IssueType; weight: number }>;
}

/** Weighted vote across the surviving evidence. Ties go to the more specific type. */
export function pickIssueType(votes: Map<IssueType, number>): IssueVote {
  const tally = [...votes.entries()]
    .map(([issueType, weight]) => ({ issueType, weight }))
    .sort((a, b) => b.weight - a.weight || ISSUE_SPECIFICITY.indexOf(a.issueType) - ISSUE_SPECIFICITY.indexOf(b.issueType));
  if (tally.length === 0) return { issueType: "UNKNOWN", weight: 0, tally: [] };
  return { issueType: tally[0].issueType, weight: tally[0].weight, tally };
}

/** The weight one candidate casts in the issue-type vote. */
export function issueVoteWeight(candidate: IngestCandidate): number {
  const base = SOURCE_EVIDENCE_WEIGHT[candidate.sourceClass];
  if (base === 0) return 0;
  const confidence = candidate.observation
    ? 0.8
    : candidate.parse.issueType === "UNKNOWN"
      ? 0.2
      : 0.4 + 0.6 * candidate.parse.issueTypeConfidence;
  const quality = candidate.sourceClass === "SOCIAL" ? candidate.authenticity.qualityMultiplier : 1;
  return base * confidence * quality;
}

/** Severity is the strongest explicit cue, floored by the issue type's default. */
export function pickSeverity(candidates: IngestCandidate[], issueType: IssueType): Severity {
  let observed: Severity = "INFO";
  for (const c of candidates) observed = maxSeverity(observed, c.parse.severity);
  return maxSeverity(observed, DEFAULT_SEVERITY[issueType]);
}

/**
 * How specific an official statement is about this cluster. A statement that
 * resolves to the same segments (or at least the same line) is a direct
 * confirmation; a vague one is worth less.
 */
export function officialQualityFor(
  officialSegments: string[],
  officialLines: string[],
  clusterSegments: string[],
  clusterLines: string[],
): number {
  if (officialSegments.some((s) => clusterSegments.includes(s))) return 1;
  if (officialLines.some((l) => clusterLines.includes(l))) return 0.8;
  return 0.6;
}
