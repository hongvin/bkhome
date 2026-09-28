/**
 * Itinerary-level reliability scoring and the arrival-time distribution.
 *
 * ============================ STATED DISTRIBUTION ============================
 * Total arrival delay D is modelled as a Normal(μ, σ²) variable clipped at 0:
 *
 *   μ = expectedDelaySeconds = Σ penaltySeconds over the itinerary's segments
 *       (supplied by S4's RiskPenaltyFn; 0 on a healthy network)
 *
 *   σ² = (0.5·μ)²  +  (25 + 10·√segmentCount)²
 *        \_______/     \______________________/
 *        risk spread    unmodelled schedule jitter
 *
 * The second term is why P90 always sits above the mean even when nothing is
 * flagged: the Klang Valley network has residual schedule noise (dwell overruns,
 * platform crowding, signalling margin) that no static feed captures. That gap
 * IS the product, so it is never allowed to collapse to zero.
 *
 * Quantiles use the standard normal z-scores:
 *   p90 = mean + 1.2816σ        (z at 0.90)
 *   p50 = mean
 *   p10 = mean − 0.80σ, floored at the scheduled arrival (a train cannot
 *         arrive before its timetable)
 *   mean = scheduledArrival + μ
 *
 * NOTE: this is a deliberately simple, documented model, not a calibrated one.
 * It is deterministic and monotonic in risk, which is what the ranking and the
 * tests require. S4 owns the risk-penalty maths that feeds μ.
 * ============================================================================
 */

import type { ArrivalWindow, ReliabilityBadge } from "@/lib/contracts";

export const P90_Z = 1.2816;
export const P10_Z = 0.8;
export const BASE_JITTER_SECONDS = 25;
export const PER_SEGMENT_JITTER_SECONDS = 10;

/** Weights of the reliability score. Documented so the ranking is auditable. */
export const RELIABILITY_WEIGHTS = Object.freeze({
  /** Max over segments of degradationProbability x confidence. */
  riskExposure: 0.55,
  /** expectedDelay / (totalDuration + expectedDelay). */
  delayShare: 0.3,
  /** min(1, transfers / 4) — each interchange is a chance to miss a connection. */
  transferLoad: 0.1,
});

export interface ArrivalDistributionInput {
  scheduledArrivalSeconds: number;
  expectedDelaySeconds: number;
  segmentCount: number;
}

export function computeArrivalWindow(input: ArrivalDistributionInput): ArrivalWindow {
  const mu = Math.max(0, input.expectedDelaySeconds);
  const jitter = BASE_JITTER_SECONDS + PER_SEGMENT_JITTER_SECONDS * Math.sqrt(Math.max(1, input.segmentCount));
  const sigma = Math.sqrt((0.5 * mu) ** 2 + jitter ** 2);
  const meanSeconds = input.scheduledArrivalSeconds + mu;
  const p90Seconds = meanSeconds + P90_Z * sigma;
  const p10Seconds = input.scheduledArrivalSeconds + Math.max(0, mu - P10_Z * sigma);
  return {
    p10Seconds,
    p50Seconds: meanSeconds,
    p90Seconds,
    meanSeconds,
    meanToP90GapSeconds: p90Seconds - meanSeconds,
  };
}

export interface ReliabilityInput {
  /** Highest degradationProbability on the itinerary, 0..1. */
  maxDegradationProbability: number;
  /** Max over segments of degradationProbability x confidence, 0..1. */
  riskExposure: number;
  expectedDelaySeconds: number;
  totalDurationSeconds: number;
  transferCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * PROVISIONAL / ROUTER-INTERNAL. Do not render this number.
 *
 * `lib/risk/rank.ts` (S4) owns the CANONICAL user-visible reliability score; the
 * Impact agent overwrites `Itinerary.reliabilityScore` with it before anything
 * reaches the API or the UI. This function exists only so path generation and
 * candidate ranking inside the router have a monotone, deterministic ordering
 * key. It deliberately does NOT import `lib/risk/**`: S4's arrival model imports
 * this module, so a back-import would be a cycle.
 *
 * 0..1, higher is better. Primary sort key per the product thesis.
 */
export function computeReliabilityScore(input: ReliabilityInput): number {
  const delayShare = clamp01(
    input.expectedDelaySeconds /
      Math.max(1, input.totalDurationSeconds + input.expectedDelaySeconds),
  );
  const transferLoad = clamp01(input.transferCount / 4);
  const score =
    1 -
    RELIABILITY_WEIGHTS.riskExposure * clamp01(input.riskExposure) -
    RELIABILITY_WEIGHTS.delayShare * delayShare -
    RELIABILITY_WEIGHTS.transferLoad * transferLoad;
  return clamp01(score);
}

/**
 * PROVISIONAL / ROUTER-INTERNAL, paired with `computeReliabilityScore`. The
 * canonical badge comes from `lib/risk/rank.ts` (S4). Thresholds here are
 * deliberately coarse so the router can order candidates; they are not the
 * calibrated bands the UI shows.
 */
export function badgeForScore(score: number): ReliabilityBadge {
  if (score >= 0.9) return "VERY_RELIABLE";
  if (score >= 0.75) return "RELIABLE";
  if (score >= 0.55) return "UNCERTAIN";
  if (score >= 0.35) return "AT_RISK";
  return "AVOID";
}

export interface RankExplanationInput {
  rank: number;
  total: number;
  reliabilityScore: number;
  badge: ReliabilityBadge;
  p90Seconds: number;
  totalDurationSeconds: number;
  transferCount: number;
  lineLabels: string[];
  riskySegmentCount: number;
  maxDegradationProbability: number;
  expectedDelaySeconds: number;
  /** Present only for rank > 1. */
  topPickDurationSeconds: number;
  topPickReliabilityScore: number;
}

function minutes(seconds: number): number {
  return Math.max(0, Math.round(seconds / 60));
}

function percent(value: number): number {
  return Math.round(value * 100);
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
function ordinal(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

/** `HH:MM` for seconds after local midnight, wrapping past midnight. */
function clock(seconds: number): string {
  const day = 24 * 3600;
  const s = ((Math.round(seconds) % day) + day) % day;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * A real, specific sentence explaining the rank. Every clause is derived from
 * this itinerary's own numbers; there are no placeholders.
 */
export function explainRank(input: RankExplanationInput): string {
  const duration = minutes(input.totalDurationSeconds);
  const p90 = clock(input.p90Seconds);
  const reliability = percent(input.reliabilityScore);
  const via =
    input.lineLabels.length === 0
      ? "the rail network"
      : input.lineLabels.length === 1
        ? input.lineLabels[0]
        : `${input.lineLabels.slice(0, -1).join(", ")} then ${input.lineLabels[input.lineLabels.length - 1]}`;
  const transferText =
    input.transferCount === 0
      ? "no transfers"
      : input.transferCount === 1
        ? "1 transfer"
        : `${input.transferCount} transfers`;
  // Only mention delay when a penalty function actually priced one; with a bare
  // riskLookup the router knows a segment is risky but has no seconds for it.
  const delayClause =
    input.expectedDelaySeconds > 0
      ? `, ~${minutes(input.expectedDelaySeconds)} min expected delay`
      : "";

  if (input.rank === 1) {
    if (input.riskySegmentCount > 0) {
      return (
        `Ranked ${ordinal(input.rank)} of ${input.total}: the best available option at ${reliability}% (${input.badge}) — ` +
        `P90 arrival ${p90}, ${duration} min door-to-door via ${via} with ${transferText}, but it still crosses ` +
        `${input.riskySegmentCount} flagged segment${input.riskySegmentCount === 1 ? "" : "s"} ` +
        `(up to ${percent(input.maxDegradationProbability)}% modelled disruption probability` +
        `${delayClause}) because no healthier alternative was found within the transfer limit.`
      );
    }
    return (
      `Ranked ${ordinal(input.rank)} of ${input.total}: ${reliability}% reliability (${input.badge}) — ` +
      `P90 arrival ${p90}, ${duration} min door-to-door via ${via} with ${transferText}, ` +
      `and no segment on it is currently flagged.`
    );
  }

  const delta = input.topPickDurationSeconds - input.totalDurationSeconds;
  const fasterBy = minutes(delta);
  const slowerBy = minutes(-delta);
  if (input.riskySegmentCount > 0) {
    const speedClause =
      fasterBy > 0
        ? `${fasterBy} min faster than the top pick, but `
        : slowerBy > 0
          ? `${slowerBy} min slower than the top pick and `
          : `about the same duration as the top pick, but `;
    return (
      `Ranked ${ordinal(input.rank)} of ${input.total}: ${speedClause}it crosses ` +
      `${input.riskySegmentCount} flagged segment${input.riskySegmentCount === 1 ? "" : "s"} ` +
      `(up to ${percent(input.maxDegradationProbability)}% disruption probability${delayClause}), ` +
      `so it scores ${reliability}% (${input.badge}) against ${percent(input.topPickReliabilityScore)}% for the top pick.`
    );
  }

  const slowerClause = slowerBy > 0 ? `${slowerBy} min slower` : "about the same duration";
  return (
    `Ranked ${ordinal(input.rank)} of ${input.total}: healthy at ${reliability}% reliability (${input.badge}) via ${via}, ` +
    `but ${slowerClause} door-to-door than the top pick.`
  );
}
