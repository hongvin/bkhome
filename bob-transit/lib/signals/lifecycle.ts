/**
 * Signal lifecycle and source precedence.
 *
 * Status is a function of evidence class, not of elapsed time. The rules are
 * written down here because they are the difference between "the operator has
 * confirmed this" and "three people on Twitter think so".
 */

import type { DisruptionSignal, IssueType, SignalStatus } from "@/lib/contracts";

import type { CalibrationInput } from "./calibration";

/**
 * Issue types that describe the same underlying incident for identity purposes.
 * A DELAY report and a SIGNAL_FAULT report on one segment 20 minutes apart are
 * almost always the same event; an ELEVATOR_FAULT there is not.
 */
export const ISSUE_FAMILIES: Readonly<Record<IssueType, string>> = {
  TRACK_FAULT: "INFRASTRUCTURE",
  SIGNAL_FAULT: "INFRASTRUCTURE",
  VEHICLE_BREAKDOWN: "INFRASTRUCTURE",
  DOOR_FAULT: "INFRASTRUCTURE",
  ELEVATOR_FAULT: "FACILITY",
  CROWDING: "SERVICE",
  DELAY: "SERVICE",
  ROAD_BLOCKED: "EXTERNAL",
  WEATHER: "EXTERNAL",
  UNKNOWN: "UNKNOWN",
};

/** Location part of a signal's identity. Unresolved signals are keyed by line. */
export function locationIdentityKey(signal: DisruptionSignal): string {
  if (signal.segmentIds.length > 0) return signal.segmentIds.join("|");
  if (signal.lineIds.length > 0) return `LINE:${signal.lineIds.join("|")}`;
  if (signal.stationIds.length > 0) return `STN:${signal.stationIds.join("|")}`;
  return `NONE:${ISSUE_FAMILIES[signal.issueType]}`;
}

/**
 * Identity of an incident across pipeline runs. Deliberately excludes the
 * window so that a later report of the same thing updates one signal instead of
 * creating a second one.
 */
export function signalIdentityKey(signal: DisruptionSignal): string {
  return `${ISSUE_FAMILIES[signal.issueType]}|${locationIdentityKey(signal)}`;
}

export interface StatusInput {
  confidenceValue: number;
  hasOfficialStatement: boolean;
  /** An official source says service has been restored. */
  recovery: boolean;
  /** The signal was filtered out as junk before it ever became a signal. */
  rejected?: boolean;
}

/**
 * Status from evidence:
 *  - an official statement is a CONFIRMATION and outranks any amount of social,
 *  - a recovery notice CLEARS,
 *  - otherwise the calibrated value decides between CANDIDATE and REPORTED.
 */
export function deriveStatus(input: StatusInput): SignalStatus {
  if (input.rejected) return "REJECTED";
  if (input.recovery) return "CLEARED";
  if (input.hasOfficialStatement) return "CONFIRMED";
  return input.confidenceValue >= 0.4 ? "REPORTED" : "CANDIDATE";
}

const STATUS_RANK: Readonly<Record<SignalStatus, number>> = {
  REJECTED: 0,
  CLEARED: 1,
  CANDIDATE: 2,
  REPORTED: 3,
  CONFIRMED: 4,
};

/**
 * Source precedence when a new batch touches an existing signal.
 *
 * Invariants:
 *  - official confirmation is never undone by more social chatter,
 *  - a CLEARED signal stays cleared unless genuinely new evidence arrives,
 *  - a REJECTED signal is only reopened by an official statement.
 */
export function mergeStatus(previous: SignalStatus, incoming: SignalStatus): SignalStatus {
  if (previous === "CONFIRMED") {
    // Only an explicit recovery may downgrade a confirmed incident.
    return incoming === "CLEARED" ? "CLEARED" : "CONFIRMED";
  }
  if (previous === "CLEARED") {
    // Reopening requires new evidence, i.e. anything above CANDIDATE.
    return incoming === "REJECTED" ? "CLEARED" : STATUS_RANK[incoming] >= STATUS_RANK.REPORTED ? incoming : "CLEARED";
  }
  if (previous === "REJECTED") {
    return incoming === "CONFIRMED" ? "CONFIRMED" : "REJECTED";
  }
  return STATUS_RANK[incoming] >= STATUS_RANK[previous] ? incoming : previous;
}

/** Minutes between first sighting and public operator acknowledgement. */
export function leadTimeMinutes(
  firstSeenAt: string,
  operatorNotifiedAt: string | null,
): number | null {
  if (!operatorNotifiedAt) return null;
  const delta = Date.parse(operatorNotifiedAt) - Date.parse(firstSeenAt);
  if (!Number.isFinite(delta)) return null;
  return Math.round((delta / 60_000) * 10) / 10;
}

/** Evidence counts carried on the VERIFY provenance hop so a merge can re-derive them. */
export interface EvidenceSummary {
  socialAuthors: string[];
  officialStatementCount: number;
  realtimeObservationCount: number;
  operatorNotifiedAt: string | null;
  rejectedSourceIds: string[];
  /**
   * The non-count half of the calibration input the verifier used (quality
   * multipliers, recency, unresolved, denial, offline). Stored so the store can
   * re-derive a merged score with the same calibrator instead of inventing one.
   */
  calibrationInput: Omit<
    CalibrationInput,
    "socialDistinctAuthors" | "officialStatementCount" | "realtimeObservationCount"
  > | null;
}

export const VERIFY_HOP_DATA_KEY = "evidenceSummary";

function readCalibrationInput(
  value: unknown,
): EvidenceSummary["calibrationInput"] {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof r[k] === "number" ? (r[k] as number) : undefined;
  const bool = (k: string): boolean | undefined =>
    typeof r[k] === "boolean" ? (r[k] as boolean) : undefined;
  return {
    socialQuality: num("socialQuality"),
    officialQuality: num("officialQuality"),
    realtimeQuality: num("realtimeQuality"),
    newestSocialAgeMinutes:
      r.newestSocialAgeMinutes === null ? null : num("newestSocialAgeMinutes"),
    windowMinutes: num("windowMinutes"),
    unresolved: bool("unresolved"),
    officialDenial: bool("officialDenial"),
    degradedByOfflineCache: bool("degradedByOfflineCache"),
  };
}

/** Read the evidence summary the verifier attached to the VERIFY hop. */
export function readEvidenceSummary(signal: DisruptionSignal): EvidenceSummary | null {
  const hop = signal.provenance.find((h) => h.hop === "VERIFY");
  const raw = hop?.data?.[VERIFY_HOP_DATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    socialAuthors: Array.isArray(r.socialAuthors)
      ? r.socialAuthors.filter((x): x is string => typeof x === "string")
      : [],
    officialStatementCount:
      typeof r.officialStatementCount === "number" ? r.officialStatementCount : 0,
    realtimeObservationCount:
      typeof r.realtimeObservationCount === "number" ? r.realtimeObservationCount : 0,
    operatorNotifiedAt: typeof r.operatorNotifiedAt === "string" ? r.operatorNotifiedAt : null,
    rejectedSourceIds: Array.isArray(r.rejectedSourceIds)
      ? r.rejectedSourceIds.filter((x): x is string => typeof x === "string")
      : [],
    calibrationInput: readCalibrationInput(r.calibrationInput),
  };
}
