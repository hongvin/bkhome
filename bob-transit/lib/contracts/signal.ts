/**
 * FROZEN CONTRACT — do not modify.
 *
 * The DisruptionSignal is the central artefact of the product. It flows
 * ingest -> verify -> impact -> advisory, and the UI renders it directly.
 * No subagent may change these shapes; if a module needs a change it stops
 * and reports instead.
 */

import type { LineId, SegmentId, StationId } from "./network";

/** Closed enum — the Verifier must pick from exactly these. */
export const ISSUE_TYPES = [
  "TRACK_FAULT",
  "SIGNAL_FAULT",
  "VEHICLE_BREAKDOWN",
  "ELEVATOR_FAULT",
  "DOOR_FAULT",
  "CROWDING",
  "DELAY",
  "ROAD_BLOCKED",
  "WEATHER",
  "UNKNOWN",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/** Closed enum. Severity drives the risk penalty magnitude. */
export const SEVERITIES = ["INFO", "MINOR", "MAJOR", "SEVERE"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Source precedence. Order matters and is load-bearing:
 * OFFICIAL_STATEMENT is high-precision/high-latency (confirmation).
 * SOCIAL is low-precision/low-latency (early warning).
 * The product's core value is the delta between them.
 */
export const SOURCE_CLASSES = [
  "OFFICIAL_STATEMENT",
  "OFFICIAL_REALTIME",
  "SOCIAL",
  "INTERNAL",
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

export type Resolution = "RESOLVED" | "UNRESOLVED";

export type SignalStatus =
  | "CANDIDATE"
  | "REPORTED"
  | "CONFIRMED"
  | "CLEARED"
  | "REJECTED";

export type SupportedLanguage = "en" | "ms" | "zh" | "ta" | "unknown";

export interface SourceRef {
  id: string;
  sourceClass: SourceClass;
  url?: string;
  /** Stable identity of the poster. Distinct authors — never repost volume — drive social confidence. */
  authorId?: string;
  authorHandle?: string;
  title?: string;
  /** Raw source text. Bahasa Malaysia, English, or mixed. */
  rawText: string;
  publishedAt: string;
  retrievedAt: string;
  language: SupportedLanguage;
  /** sha256 of rawText, for dedupe and replay. */
  contentHash: string;
}

export interface ConfidenceFactor {
  name: string;
  /** Weight applied to this factor before normalisation. */
  weight: number;
  /** This factor's signed contribution to the final value. */
  contribution: number;
  note: string;
}

export type ConfidenceBand =
  | "VERY_LOW"
  | "LOW"
  | "MODERATE"
  | "HIGH"
  | "VERY_HIGH";

export interface ConfidenceScore {
  /** Calibrated probability in [0,1] that the segment is genuinely degraded. */
  value: number;
  /** Identifier of the calibration table used, so a score is reproducible. */
  calibrationVersion: string;
  factors: ConfidenceFactor[];
  band: ConfidenceBand;
  /**
   * True when this score was computed from cached state because the device was
   * offline. The UI MUST reduce displayed confidence and say so.
   */
  degradedByOfflineCache: boolean;
}

export function confidenceBand(value: number): ConfidenceBand {
  if (value >= 0.85) return "VERY_HIGH";
  if (value >= 0.65) return "HIGH";
  if (value >= 0.4) return "MODERATE";
  if (value >= 0.2) return "LOW";
  return "VERY_LOW";
}

/** One hop of the audit trail. A3 requires confidence to be visible at each step. */
export interface SignalProvenanceHop {
  hop: "INGEST" | "VERIFY" | "IMPACT" | "ADVISORY";
  at: string;
  confidence: number;
  summary: string;
  data?: Record<string, unknown>;
}

export interface DisruptionSignal {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: SignalStatus;

  /** Empty when `resolution` is UNRESOLVED. */
  segmentIds: SegmentId[];
  stationIds: StationId[];
  lineIds: LineId[];
  resolution: Resolution;
  /** Candidate segments when the location could not be disambiguated. Never silently pick one. */
  unresolvedCandidates?: SegmentId[];

  issueType: IssueType;
  severity: Severity;
  confidence: ConfidenceScore;

  /** When our pipeline first saw evidence. */
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * When the OPERATOR publicly acknowledged it. Null until an official source
   * arrives. `leadTimeMinutes` is derived from this and is the headline metric.
   */
  operatorNotifiedAt: string | null;
  /** firstSeenAt -> operatorNotifiedAt, in minutes. Null while unconfirmed. */
  leadTimeMinutes: number | null;

  corroboratingSources: {
    official: number;
    /** DISTINCT authors only. Reposts must not inflate this. */
    socialDistinctAuthors: number;
    realtimeObservations: number;
  };

  sources: SourceRef[];
  /** Max 2 sentences. Must cite which signals drove the score. */
  reasoning: string;
  wouldAHumanCheckThis: boolean;

  window: {
    startsAt: string;
    endsAt: string | null;
  };

  provenance: SignalProvenanceHop[];
}

export function isActiveAt(signal: DisruptionSignal, at: Date): boolean {
  const start = Date.parse(signal.window.startsAt);
  const end = signal.window.endsAt ? Date.parse(signal.window.endsAt) : Infinity;
  const t = at.getTime();
  return t >= start && t <= end;
}
