/**
 * Risk penalty — the implementation of the frozen `RiskPenaltyFn` contract.
 *
 * PRODUCT ROLE
 * ------------
 * This is the single place where "a disruption was reported" becomes "this
 * segment costs more". The router (S1) prices every candidate segment through
 * this function; the Impact agent (this module's sibling) ranks itineraries on
 * the result. Nothing here may touch the network, the clock, or a random source:
 * the whole demo must be replayable byte-for-byte.
 *
 * THE MODEL (no flat penalty)
 * ---------------------------
 *   multiplier = 1 + (SEVERITY_BASE_MULTIPLIER[severity] - 1)
 *                   * ISSUE_TYPE_SEVERITY_WEIGHT[issueType]
 *                   * confidenceWeight(effectiveConfidence)
 *
 * where `effectiveConfidence` folds in three real-world modifiers:
 *
 *   1. PERSISTENCE (`isOngoing`). A signal that is known to still be ongoing is
 *      priced at full strength; one whose persistence is unconfirmed is priced at
 *      NOT_ONGOING_CONFIDENCE_DAMPING. Without this, a stale-but-uncleared
 *      report would keep costing the same as a live fault.
 *   2. TIME OF DAY (`atTime`). A fixed service failure is worse at 08:00 than at
 *      11:00 because the spare capacity that absorbs it is gone. Demand-sensitive
 *      issue types therefore get PEAK_DEMAND_FACTOR during the peaks.
 *   3. CONFIDENCE SHAPE (`confidenceWeight`). This is deliberately convex and
 *      kinked at the two FROZEN thresholds, so the shape of the curve is tied to
 *      the constants the rest of the system already agrees on:
 *
 *         w(0.00) = 0.00   nothing reported, nothing priced
 *         w(0.40) = 0.40   MATERIAL_RISK_CONFIDENCE_THRESHOLD
 *         w(0.70) = 0.80   AVOID_SEGMENT_CONFIDENCE_THRESHOLD
 *         w(1.00) = 1.35   a confirmed disruption costs 1.35x the base excess
 *
 *      A low-confidence rumour is therefore cheap; a confirmed fault is more than
 *      proportionally expensive. w is continuous and strictly increasing, which is
 *      what gives the function its monotonicity in `confidence`.
 *
 * `penaltySeconds` is `(multiplier - 1) * segmentRunSeconds`. The frozen
 * `RiskPenaltyInput` does not carry the segment's scheduled run time, so the
 * default uses NOMINAL_SEGMENT_RUN_SECONDS (120 s — the true median inter-station
 * run time in `data/gtfs-static/rapid-rail-kl/stop_times.txt`, measured over 1074
 * segment traversals). `createRiskPenaltyFn` lets the router inject the real
 * per-segment run time when it has the graph; the *multiplier* is independent of
 * run time and therefore identical either way.
 *
 * Verified data facts used above (from the committed GTFS fixture, not the web):
 *   - median inter-station scheduled run time: 120 s (mean 134.3 s, p90 207 s)
 *   - peak headways: KJ 240 s, AG/PH 180 s, KGL 360 s (see lib/risk/headway.ts)
 */

import type {
  IssueType,
  RiskPenalty,
  RiskPenaltyFn,
  RiskPenaltyInput,
  SegmentId,
  Severity,
} from "@/lib/contracts";
import {
  AVOID_SEGMENT_CONFIDENCE_THRESHOLD,
  ISSUE_TYPE_SEVERITY_WEIGHT,
  MATERIAL_RISK_CONFIDENCE_THRESHOLD,
  SEVERITY_BASE_MULTIPLIER,
} from "@/lib/contracts";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * Median scheduled inter-station run time across the real Klang Valley rail
 * feed: 120 s. Measured from `stop_times.txt` (1074 segment traversals,
 * p25 = 100 s, p75 = 155 s). Used only to turn the dimensionless multiplier into
 * seconds when the caller has no graph to hand.
 */
export const NOMINAL_SEGMENT_RUN_SECONDS = 120;

/** Seconds after local midnight. Klang Valley AM and PM peaks. */
export const PEAK_WINDOWS: ReadonlyArray<{ readonly startSeconds: number; readonly endSeconds: number }> = [
  { startSeconds: 7 * 3600, endSeconds: 9 * 3600 + 1800 }, // 07:00 – 09:30
  { startSeconds: 17 * 3600, endSeconds: 19 * 3600 + 1800 }, // 17:00 – 19:30
];

/**
 * Issue types whose *consequence* is amplified by demand. A door fault at 08:00
 * cascades through a full train; at 11:00 it costs one dwell. A track fault is
 * capacity-limiting regardless of the hour, so it is deliberately absent.
 */
export const PEAK_DEMAND_ISSUE_TYPES: ReadonlyArray<IssueType> = [
  "CROWDING",
  "DELAY",
  "DOOR_FAULT",
  "VEHICLE_BREAKDOWN",
];

/** Multiplier applied to effective confidence during a peak window. */
export const PEAK_DEMAND_FACTOR = 1.15;

/**
 * Damping applied when the signal is NOT known to be ongoing. This is a prior on
 * persistence, not a claim that the disruption is over: an unconfirmed-persistence
 * fault still costs 50% of a live one.
 */
export const NOT_ONGOING_CONFIDENCE_DAMPING = 0.5;

/**
 * Confidence-weight curve knots. Index 0 is the raw confidence, index 1 the
 * weight. Kinks sit exactly on the two frozen thresholds.
 */
const CONFIDENCE_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [MATERIAL_RISK_CONFIDENCE_THRESHOLD, MATERIAL_RISK_CONFIDENCE_THRESHOLD],
  [AVOID_SEGMENT_CONFIDENCE_THRESHOLD, 0.8],
  [1, 1.35],
];

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function isPeakWindow(atTime: number): boolean {
  return PEAK_WINDOWS.some((w) => atTime >= w.startSeconds && atTime < w.endSeconds);
}

export function isMaterialRisk(confidence: number): boolean {
  return confidence > MATERIAL_RISK_CONFIDENCE_THRESHOLD;
}

export function isAvoidConfidence(confidence: number): boolean {
  return confidence >= AVOID_SEGMENT_CONFIDENCE_THRESHOLD;
}

/**
 * Piecewise-linear, continuous, strictly increasing map from raw confidence to
 * the weight applied to the severity excess. Kinks at 0.4 and 0.7 tie the curve
 * to the frozen thresholds. Deterministic and total for any real input.
 */
export function confidenceWeight(confidence: number): number {
  const c = clamp01(confidence);
  for (let i = 1; i < CONFIDENCE_KNOTS.length; i += 1) {
    const [x0, y0] = CONFIDENCE_KNOTS[i - 1];
    const [x1, y1] = CONFIDENCE_KNOTS[i];
    if (c <= x1) {
      const t = (c - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return CONFIDENCE_KNOTS[CONFIDENCE_KNOTS.length - 1][1];
}

/** `confidence` after persistence damping and the peak-demand modifier. */
export function effectiveConfidence(input: {
  confidence: number;
  issueType: IssueType;
  atTime: number;
  isOngoing: boolean;
}): number {
  const persistence = input.isOngoing ? 1 : NOT_ONGOING_CONFIDENCE_DAMPING;
  const demand =
    isPeakWindow(input.atTime) && PEAK_DEMAND_ISSUE_TYPES.includes(input.issueType)
      ? PEAK_DEMAND_FACTOR
      : 1;
  return clamp01(clamp01(input.confidence) * persistence * demand);
}

/**
 * The dimensionless excess over 1.0 that this disruption adds to the scheduled
 * run time. Zero for a healthy segment, non-decreasing in `confidence` for fixed
 * `severity`, and non-decreasing in `severity` for fixed `confidence`.
 */
export function excessMultiplier(input: {
  severity: Severity;
  issueType: IssueType;
  confidence: number;
  atTime: number;
  isOngoing: boolean;
}): number {
  const severityExcess = SEVERITY_BASE_MULTIPLIER[input.severity] - 1;
  const issueWeight = ISSUE_TYPE_SEVERITY_WEIGHT[input.issueType];
  const weight = confidenceWeight(
    effectiveConfidence({
      confidence: input.confidence,
      issueType: input.issueType,
      atTime: input.atTime,
      isOngoing: input.isOngoing,
    }),
  );
  return severityExcess * issueWeight * weight;
}

/* ------------------------------------------------------------------ *
 * Reason string (Source Inspector)
 * ------------------------------------------------------------------ */

export function formatPenaltyReason(args: {
  segmentId: SegmentId;
  severity: Severity;
  issueType: IssueType;
  confidence: number;
  multiplier: number;
  penaltySeconds: number;
  runSeconds: number;
  isOngoing: boolean;
  atTime: number;
}): string {
  const pct = Math.round(clamp01(args.confidence) * 100);
  const ongoing = args.isOngoing ? "ongoing" : "persistence unconfirmed";
  const peak = isPeakWindow(args.atTime) ? " during the peak" : "";

  if (SEVERITY_BASE_MULTIPLIER[args.severity] === 1 || args.penaltySeconds === 0) {
    return (
      `${args.severity} ${args.issueType} on ${args.segmentId}: ` +
      `no run-time cost added (multiplier 1.00, +0 s). ` +
      `Reported at ${pct}% confidence, ${ongoing}${peak}.`
    );
  }

  let threshold = "";
  if (isAvoidConfidence(args.confidence)) {
    threshold =
      `; above the ${Math.round(AVOID_SEGMENT_CONFIDENCE_THRESHOLD * 100)}% avoid threshold — ` +
      `the router must not recommend this segment unless no alternative exists`;
  } else if (isMaterialRisk(args.confidence)) {
    threshold =
      `; above the ${Math.round(MATERIAL_RISK_CONFIDENCE_THRESHOLD * 100)}% material-risk threshold — ` +
      `counts against reliability`;
  }

  return (
    `${args.severity} ${args.issueType} on ${args.segmentId}: ${pct}% confidence, ${ongoing}${peak} ` +
    `→ scheduled run x${args.multiplier.toFixed(2)} (+${args.penaltySeconds} s on a ${args.runSeconds} s segment)` +
    threshold
  );
}

/* ------------------------------------------------------------------ *
 * The function itself
 * ------------------------------------------------------------------ */

/** Resolve the scheduled run time to price against. */
function resolveRunSeconds(
  segmentId: SegmentId,
  referenceSegmentSeconds: number,
  segmentSeconds?: ReadonlyMap<SegmentId, number> | Record<SegmentId, number>,
): number {
  if (segmentSeconds !== undefined) {
    const looked =
      segmentSeconds instanceof Map
        ? segmentSeconds.get(segmentId)
        : (segmentSeconds as Record<SegmentId, number>)[segmentId];
    if (typeof looked === "number" && Number.isFinite(looked) && looked > 0) return looked;
  }
  return referenceSegmentSeconds;
}

export interface RiskPenaltyOptions {
  /**
   * Run time used when the segment's own scheduled run time is unknown.
   * Defaults to the measured GTFS median, NOMINAL_SEGMENT_RUN_SECONDS.
   */
  referenceSegmentSeconds?: number;
  /** Per-segment scheduled run times, e.g. built from `TransitGraph.segments`. */
  segmentSeconds?: ReadonlyMap<SegmentId, number> | Record<SegmentId, number>;
}

/**
 * Build a `RiskPenaltyFn` bound to a particular graph's segment run times.
 * The returned function is pure and deterministic; the map is read-only.
 */
export function createRiskPenaltyFn(options: RiskPenaltyOptions = {}): RiskPenaltyFn {
  const reference = options.referenceSegmentSeconds ?? NOMINAL_SEGMENT_RUN_SECONDS;
  const { segmentSeconds } = options;

  return (input: RiskPenaltyInput): RiskPenalty => {
    const runSeconds = resolveRunSeconds(input.segmentId, reference, segmentSeconds);
    const excess = excessMultiplier(input);
    const multiplier = 1 + excess;
    const penaltySeconds = Math.round(excess * runSeconds);

    return {
      segmentId: input.segmentId,
      penaltySeconds,
      multiplier,
      confidence: clamp01(input.confidence),
      severity: input.severity,
      reason: formatPenaltyReason({
        segmentId: input.segmentId,
        severity: input.severity,
        issueType: input.issueType,
        confidence: input.confidence,
        multiplier,
        penaltySeconds,
        runSeconds,
        isOngoing: input.isOngoing,
        atTime: input.atTime,
      }),
    };
  };
}

/**
 * Default penalty function: the measured GTFS median segment run time, no graph.
 * Identical to `createRiskPenaltyFn()`; exported directly because the frozen
 * `PlanJourneysOptions.riskPenalty` accepts a bare function.
 */
export const riskPenalty: RiskPenaltyFn = createRiskPenaltyFn();
