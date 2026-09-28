/**
 * Arrival distribution / P90 — the headline number of the product.
 *
 * THE STATED DISTRIBUTION
 * =======================
 * We do NOT report a single expected arrival. We report a distribution summary
 * and lead with P90, because a commuter planning a trip cares about "the time I
 * will actually arrive with 90% confidence", not the average.
 *
 * Model, stated precisely:
 *
 *   1. The journey's scheduled duration `S` is deterministic: it is the sum of
 *      the itinerary's scheduled leg times with no disruption applied. Trains on
 *      this network do not run early, so `S` is the floor of the arrival time.
 *
 *   2. Every RIDE segment contributes an independent non-negative delay `d_i`.
 *      `d_i` is a two-component MIXTURE OF LOG-NORMALS:
 *
 *         with probability (1 - p_i):  d_i ~ LogNormal(mean = H, log-sd = h)
 *         with probability      p_i :  d_i ~ LogNormal(mean = M_i, log-sd = g)
 *
 *      where
 *         p_i = SegmentRisk.degradationProbability (the fused probability that
 *               this segment is degraded),
 *         M_i = excessMultiplier(severity, issueType, confidence) * runSeconds,
 *               i.e. exactly the run-time excess the risk penalty charges at full
 *               confidence, scaled down by the confidence weight,
 *         H, h = baseline run-time jitter on a healthy segment.
 *
 *      Independence across segments is an explicit, stated assumption: the
 *      signal pipeline attributes a disruption to specific directional segments,
 *      so a single incident is priced once, on the segments it actually affects.
 *
 *   3. Total delay `D = sum(d_i)` is summarised by a single LOG-NORMAL fitted by
 *      the METHOD OF MOMENTS to the exact mean and variance of the mixture in
 *      (2). `E[D]` and `Var(D)` are computed exactly (independence => the
 *      variance of the sum is the sum of the variances, and each mixture's
 *      moments follow from the law of total variance); only the *shape* of the
 *      tail is approximated by the log-normal.
 *
 * WHY LOG-NORMAL (and not a normal, or a raw simulation)
 * -----------------------------------------------------
 *   - Delay is non-negative and strongly right-skewed. A normal model would put
 *     probability mass on arriving before the scheduled time and would let
 *     `p90 - mean = 1.2816 * sigma` be small even when the tail is fat.
 *   - Log-normal (equivalently, a normal in log-time) is the standard parametric
 *     travel-time-reliability distribution; its median is below its mean, which
 *     is exactly the observed behaviour of transit arrival times.
 *   - It gives P90 > mean *by construction*, and the gap grows monotonically with
 *     both the mean and the dispersion of the underlying delay. The product's
 *     core claim — "a riskier segment produces a bigger P90 - mean gap" — is a
 *     property of the model, not a fudge factor.
 *   - It is closed-form and fully deterministic: no sampling, no seed, no
 *     convergence, no machine-precision drift between runs. A Monte-Carlo
 *     alternative would be defensible too, but it would make the demo output
 *     depend on a PRNG for no accuracy gain we can justify at this scope.
 *
 * Approximation boundary, stated honestly: for a journey with several degraded
 * segments the true mixture is mildly multi-modal and the moment-matched
 * log-normal is a smooth stand-in. It reproduces the exact mean and variance, so
 * the *magnitude* of the gap is right; the *shape* between the modes is an
 * approximation. `MAX_TOTAL_LOG_SIGMA` caps the fitted log-sd at 1.2 so the fit
 * stays in the region where P90 >= mean and the gap increases with dispersion.
 */

import type { ArrivalWindow, IssueType, Severity } from "@/lib/contracts";
import { excessMultiplier } from "./penalty";

/* ------------------------------------------------------------------ *
 * Model constants (single place to tune; all values are stated priors)
 * ------------------------------------------------------------------ */

/** Mean extra delay on a healthy segment, seconds. Engineering prior. */
export const HEALTHY_DELAY_MEAN_SECONDS = 8;
/** Log-sd of the healthy-segment delay. CV = sqrt(e^0.36 - 1) ~= 0.66. */
export const HEALTHY_DELAY_LOG_SIGMA = 0.6;
/**
 * Log-sd of the degraded-segment delay. CV ~= 0.95: a disrupted segment's delay
 * is much more dispersed than its mean suggests (some trains crawl, some stop).
 * This is deliberately high; it is what keeps the P90 gap increasing as the
 * degradation probability rises rather than collapsing as the mean dominates.
 */
export const DEGRADED_DELAY_LOG_SIGMA = 0.8;
/** Cap on the fitted total log-sd. Keeps P90 >= mean and the gap monotone. */
export const MAX_TOTAL_LOG_SIGMA = 1.2;
/** 90th percentile of the standard normal. */
export const Z90 = 1.2815515655446004;
/** Below this total mean delay the window collapses to a point. */
const DEGENERATE_MEAN_EPSILON = 1e-9;

export const ARRIVAL_MODEL_DESCRIPTION =
  "Scheduled time + sum of independent per-segment delays; each segment delay is a " +
  "two-component log-normal mixture (healthy jitter vs degraded excess, weighted by the " +
  "segment's degradation probability); the total delay is reported via a moment-matched " +
  "log-normal. P90 leads, the mean is shown beside it.";

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

export interface SegmentDelayInput {
  segmentId: string;
  /** Scheduled in-vehicle run time with no disruption, seconds. */
  scheduledRunSeconds: number;
  /** Fused probability that this segment is degraded, in [0,1]. */
  degradationProbability: number;
  /** Confidence in that probability, in [0,1]. Scales the degraded branch. */
  confidence?: number;
  severity?: Severity;
  issueType?: IssueType;
  /** True when the disruption is known to still be ongoing. Defaults to true. */
  isOngoing?: boolean;
  /** Local seconds after midnight at which the segment is traversed. */
  atTime?: number;
}

export interface ArrivalWindowInput {
  /** Absolute departure time, seconds after local midnight. */
  departureTime: number;
  /** Deterministic scheduled journey time (all legs, no disruption), seconds. */
  scheduledDurationSeconds: number;
  /** RIDE segments only; waits and transfers belong in `scheduledDurationSeconds`. */
  segments: readonly SegmentDelayInput[];
}

export interface SegmentDelayMoments {
  segmentId: string;
  /** Probability used for the degraded branch, in [0,1]. */
  probability: number;
  /** Mean delay of the healthy branch, seconds. */
  healthyMeanSeconds: number;
  /** Mean delay of the degraded branch, seconds. */
  degradedMeanSeconds: number;
  /** Mixture mean delay, seconds. */
  meanSeconds: number;
  /** Mixture variance of the delay, seconds^2. */
  varianceSeconds2: number;
}

export interface DelayMoments {
  meanSeconds: number;
  varianceSeconds2: number;
  standardDeviationSeconds: number;
  /** Per-segment breakdown, for the Source Inspector. */
  segments: SegmentDelayMoments[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Second moment of a log-normal given its mean and log-sd. */
function logNormalSecondMoment(mean: number, logSigma: number): number {
  return mean * mean * Math.exp(logSigma * logSigma);
}

/**
 * Exact mean and variance of the total delay implied by the segment mixture.
 * Pure, deterministic, and independent of the log-normal summary — this is what
 * the summary is fitted to, and what the tests assert against.
 */
export function computeDelayMoments(segments: readonly SegmentDelayInput[]): DelayMoments {
  const perSegment: SegmentDelayMoments[] = [];
  let mean = 0;
  let variance = 0;

  for (const segment of segments) {
    const p = clamp01(segment.degradationProbability);
    const runSeconds = Math.max(0, segment.scheduledRunSeconds);
    const severity: Severity = segment.severity ?? "MINOR";
    const issueType: IssueType = segment.issueType ?? "UNKNOWN";
    const confidence = segment.confidence ?? 1;
    const isOngoing = segment.isOngoing ?? true;
    const atTime = segment.atTime ?? -1;

    const degradedMean = excessMultiplier({
      severity,
      issueType,
      confidence,
      atTime,
      isOngoing,
    }) * runSeconds;

    const healthyMean = runSeconds > 0 ? HEALTHY_DELAY_MEAN_SECONDS : 0;

    const mixtureMean = (1 - p) * healthyMean + p * degradedMean;
    const mixtureSecondMoment =
      (1 - p) * logNormalSecondMoment(healthyMean, HEALTHY_DELAY_LOG_SIGMA) +
      p * logNormalSecondMoment(degradedMean, DEGRADED_DELAY_LOG_SIGMA);
    const mixtureVariance = Math.max(0, mixtureSecondMoment - mixtureMean * mixtureMean);

    mean += mixtureMean;
    variance += mixtureVariance;

    perSegment.push({
      segmentId: segment.segmentId,
      probability: p,
      healthyMeanSeconds: healthyMean,
      degradedMeanSeconds: degradedMean,
      meanSeconds: mixtureMean,
      varianceSeconds2: mixtureVariance,
    });
  }

  return {
    meanSeconds: mean,
    varianceSeconds2: variance,
    standardDeviationSeconds: Math.sqrt(variance),
    segments: perSegment,
  };
}

/** Parameters of the moment-matched total log-normal for a given delay mean/variance. */
export function fitLogNormal(meanSeconds: number, varianceSeconds2: number): {
  mu: number;
  sigma: number;
  fitted: boolean;
} {
  if (!(meanSeconds > DEGENERATE_MEAN_EPSILON) || !(varianceSeconds2 > 0)) {
    return { mu: 0, sigma: 0, fitted: false };
  }
  const rawSigmaSq = Math.log(1 + varianceSeconds2 / (meanSeconds * meanSeconds));
  const sigma = Math.min(Math.sqrt(Math.max(0, rawSigmaSq)), MAX_TOTAL_LOG_SIGMA);
  // Recompute mu from the (possibly capped) sigma so the fitted distribution's
  // mean stays exactly `meanSeconds`.
  const mu = Math.log(meanSeconds) - (sigma * sigma) / 2;
  return { mu, sigma, fitted: true };
}

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

/**
 * Compute the absolute arrival window for a journey.
 *
 * Returns absolute times (seconds after local midnight), matching the frozen
 * `Itinerary.arrival` contract: `ArrivalWindow.p90Seconds` is the headline, and
 * `meanToP90GapSeconds` is stored explicitly because the gap IS the product.
 */
export function computeArrivalWindow(input: ArrivalWindowInput): ArrivalWindow {
  const scheduled = Math.max(0, input.scheduledDurationSeconds);
  const base = input.departureTime + scheduled;
  const moments = computeDelayMoments(input.segments);
  const { mu, sigma, fitted } = fitLogNormal(moments.meanSeconds, moments.varianceSeconds2);

  if (!fitted) {
    // No reported risk anywhere: the scheduled time is the answer, with no spread.
    return {
      p10Seconds: base,
      p50Seconds: base,
      p90Seconds: base,
      meanSeconds: base,
      meanToP90GapSeconds: 0,
    };
  }

  const p10 = base + Math.exp(mu - Z90 * sigma);
  const p50 = base + Math.exp(mu);
  const p90 = base + Math.exp(mu + Z90 * sigma);
  const mean = base + moments.meanSeconds;

  return {
    p10Seconds: p10,
    p50Seconds: p50,
    p90Seconds: p90,
    meanSeconds: mean,
    meanToP90GapSeconds: p90 - mean,
  };
}

/**
 * Convenience: the P90-minus-mean gap alone, for the "does risk widen the tail?"
 * question. Exported because it is the product metric and it should be easy to
 * assert on and to chart.
 */
export function meanToP90GapSeconds(input: ArrivalWindowInput): number {
  return computeArrivalWindow(input).meanToP90GapSeconds;
}
