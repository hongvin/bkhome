/**
 * Arrival distribution / P90.
 *
 * ============================================================================
 * ORCHESTRATOR RULING (single canonical arrival model)
 * ============================================================================
 * There is exactly ONE arrival-window implementation in this codebase:
 *
 *     lib/routing/reliability.ts :: computeArrivalWindow
 *
 * It is re-exported below so that everything under `lib/risk/**` and
 * `lib/agents/impact/**` speaks the same type and the same numbers. An earlier
 * revision of this file contained a second, independent model (a moment-matched
 * log-normal over a per-segment two-component log-normal mixture). That model is
 * GONE from the live path. Two windows meant the P90 the rider sees could differ
 * from the P90 that drove the ranking, which is a correctness bug, not a style
 * question.
 *
 * The canonical model, stated:
 *
 *     D ~ Normal(mu, sigma^2) clipped at 0, where
 *       mu    = sum of RiskPenalty.penaltySeconds over the itinerary's segments
 *               (i.e. exactly the output of lib/risk/penalty.ts; 0 when healthy)
 *       sigma^2 = (0.5*mu)^2 + (25 + 10*sqrt(segmentCount))^2
 *                 \________/   \___________________________/
 *                  risk spread     residual schedule jitter
 *       p90   = mean + 1.2816*sigma
 *       p50   = mean
 *       p10   = scheduledArrival + max(0, mu - 0.8*sigma)
 *
 * The residual-jitter term is why P90 > mean even on a completely healthy
 * itinerary: dwell overruns, platform crowding and signalling margin exist
 * whether or not a signal has been filed. That gap IS the product, so it is never
 * allowed to collapse to zero.
 *
 * WHAT THIS MODULE STILL OWNS
 * ---------------------------
 *   - the `meanToP90GapSeconds` accessor (the gap is stored on the window, but
 *     this is the single named way to read it);
 *   - `impliedExpectedDelaySeconds`, the audit check that the mean the rider sees
 *     really is `scheduled + mu`;
 *   - the model description string the UI and the prompt file quote.
 *
 * MODEL PROPOSAL, NOT SHIPPED (recorded so the insight is not lost)
 * ----------------------------------------------------------------
 * The deleted model was: each segment contributes an independent non-negative
 * delay drawn from a two-component log-normal mixture — healthy baseline jitter
 * vs a degraded branch whose mean is exactly `excessMultiplier x runSeconds`
 * (the same quantity the penalty function charges) — and the total delay is
 * summarised by a log-normal fitted by the method of moments. Its advantages over
 * a clipped Normal are (a) travel-time delay is genuinely right-skewed and
 * non-negative, so a symmetric Normal over-states early arrival; (b) the
 * dispersion is derived from the disruption's severity rather than a fixed
 * 0.5*mu rule; (c) it composes per segment, so a long itinerary with one bad
 * segment is priced differently from a short one with the same total mu.
 * It was validated as strictly monotone in degradation probability and in
 * confidence (see `tests/risk/arrival.test.ts`). It is deliberately NOT live:
 * shipping it requires replacing the canonical model, not running beside it.
 */

import type { ArrivalWindow } from "@/lib/contracts";

export {
  computeArrivalWindow,
  P90_Z,
  P10_Z,
  BASE_JITTER_SECONDS,
  PER_SEGMENT_JITTER_SECONDS,
} from "@/lib/routing/reliability";
export type { ArrivalDistributionInput } from "@/lib/routing/reliability";

export const ARRIVAL_MODEL_DESCRIPTION =
  "Normal(mu, sigma^2) delay clipped at zero, where mu is the sum of the risk penalties " +
  "(severity x confidence x issueTypeWeight) and sigma^2 = (0.5*mu)^2 + " +
  "(25 + 10*sqrt(segmentCount))^2. P90 = mean + 1.2816*sigma; the mean is shown beside it; " +
  "meanToP90GapSeconds is stored explicitly because the gap IS the product.";

/** `p90 - mean`, read from a window. The gap IS the product, so it has a name. */
export function meanToP90GapSeconds(window: ArrivalWindow): number {
  return window.p90Seconds - window.meanSeconds;
}

/**
 * The delay the canonical window implies: `mean - scheduledArrival`. Used as an
 * audit check so the mean the rider sees can never drift from `scheduled + mu`.
 */
export function impliedExpectedDelaySeconds(
  window: ArrivalWindow,
  scheduledArrivalSeconds: number,
): number {
  return Math.max(0, window.meanSeconds - scheduledArrivalSeconds);
}
