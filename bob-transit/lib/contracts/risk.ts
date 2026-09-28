/**
 * FROZEN CONTRACT — do not modify.
 *
 * Risk model contracts. The risk penalty is the mechanism by which a confirmed
 * disruption changes a route recommendation, so its signature is fixed here and
 * implemented by S4.
 */

import type { IssueType, Severity } from "./signal";
import type { SegmentId } from "./network";

/** Probability in [0,1] that a segment is currently degraded. */
export interface SegmentRisk {
  segmentId: SegmentId;
  /** Fused probability of degradation. */
  degradationProbability: number;
  /** Confidence in `degradationProbability` itself, in [0,1]. */
  confidence: number;
  severity: Severity;
  issueType: IssueType;
  /** Number of distinct sources contributing. */
  sourceCount: number;
  lastUpdated: string;
  /** True when read from cache while offline. UI must show reduced confidence. */
  stale: boolean;
}

/**
 * The risk overlay shown on the map and consulted by the router.
 * `asOf` + `stalenessMinutes` exist so the UI can render
 * "as of HH:MM, N min ago" and never present stale data as live.
 */
export interface RiskOverlay {
  generatedAt: string;
  asOf: string;
  stalenessMinutes: number;
  isStale: boolean;
  source: "live" | "cache";
  segments: SegmentRisk[];
}

export interface RiskPenaltyInput {
  segmentId: SegmentId;
  severity: Severity;
  /** Confidence that the disruption is real, in [0,1]. */
  confidence: number;
  issueType: IssueType;
  /** Local seconds-after-midnight of the traversal being priced. */
  atTime: number;
  /** True when the signal is known to still be ongoing. */
  isOngoing: boolean;
}

export interface RiskPenalty {
  segmentId: SegmentId;
  /** Extra seconds added to the segment's traversal cost. */
  penaltySeconds: number;
  /** Multiplier applied to scheduled run time (1.0 = unaffected). */
  multiplier: number;
  /** Echoed for explainability in the Source Inspector. */
  confidence: number;
  severity: Severity;
  /** Human-readable justification, surfaced in the UI. */
  reason: string;
}

/**
 * The risk-penalty function. S4 owns the implementation; S1's CSA router calls it
 * through this signature only, which is what lets the two be built in parallel.
 *
 * Contract requirements (enforced by tests):
 *  - Deterministic and pure: same input => same output, no I/O.
 *  - Monotonic in `confidence` for fixed severity.
 *  - Monotonic in `severity` for fixed confidence.
 *  - `multiplier >= 1` always; a healthy segment returns penalty 0 / multiplier 1.
 */
export type RiskPenaltyFn = (input: RiskPenaltyInput) => RiskPenalty;

/** Severity -> base multiplier applied to scheduled run time before confidence scaling. */
export const SEVERITY_BASE_MULTIPLIER: Record<Severity, number> = {
  INFO: 1.0,
  MINOR: 1.15,
  MAJOR: 1.6,
  SEVERE: 2.75,
};

/** Issue types that stop trains outright are priced more harshly than slow ones. */
export const ISSUE_TYPE_SEVERITY_WEIGHT: Record<IssueType, number> = {
  TRACK_FAULT: 1.0,
  SIGNAL_FAULT: 0.95,
  VEHICLE_BREAKDOWN: 0.9,
  ELEVATOR_FAULT: 0.35,
  DOOR_FAULT: 0.8,
  CROWDING: 0.55,
  DELAY: 0.6,
  ROAD_BLOCKED: 0.7,
  WEATHER: 0.75,
  UNKNOWN: 0.5,
};

/**
 * Above this confidence the router must not recommend the segment unless no
 * alternative exists (Impact agent rule). Shared constant so router and agent agree.
 */
export const AVOID_SEGMENT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Above this confidence a segment is treated as materially risky when ranking
 * reliability, even if it is not hard-avoided.
 */
export const MATERIAL_RISK_CONFIDENCE_THRESHOLD = 0.4;
