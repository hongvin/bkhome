/**
 * Risk pricing bridge between S4's `RiskPenaltyFn` and S1's CSA.
 *
 * The router only ever calls the frozen `RiskPenaltyFn` signature. When either
 * `riskLookup` or `riskPenalty` is absent the network is treated as healthy
 * (penalty 0, multiplier 1) so the router is never blocked on S4.
 *
 * INTEGRATION ASSUMPTION (verify with S4): `RiskPenaltyInput.confidence` is
 * "confidence that the disruption is real". `SegmentRisk` carries the fused
 * degradation probability AND a confidence in that probability, but
 * `RiskPenaltyInput` has only one slot, so the router passes their product —
 * otherwise a 5%-probability segment and a 95%-probability segment would be
 * priced identically, because the penalty function cannot see the probability.
 */

import type { RiskPenalty, RiskPenaltyFn, SegmentId, SegmentRiskLookup } from "@/lib/contracts";

export interface RiskPricing {
  readonly hasLookup: boolean;
  readonly hasPenalty: boolean;
  /** Returns null when the segment is healthy or risk pricing is unavailable. */
  penaltyFor(segmentId: SegmentId, atTimeSeconds: number): RiskPenalty | null;
}

const HEALTHY: RiskPricing = {
  hasLookup: false,
  hasPenalty: false,
  penaltyFor: () => null,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function createRiskPricing(
  riskLookup?: SegmentRiskLookup,
  riskPenalty?: RiskPenaltyFn,
): RiskPricing {
  if (!riskLookup || !riskPenalty) {
    if (!riskLookup && !riskPenalty) return HEALTHY;
    // Only one half supplied: we can score risk (lookup) but not price it, or
    // price nothing at all. Either way no time is added.
    return {
      hasLookup: Boolean(riskLookup),
      hasPenalty: Boolean(riskPenalty),
      penaltyFor: () => null,
    };
  }

  const lookup = riskLookup;
  const penaltyFn = riskPenalty;
  return {
    hasLookup: true,
    hasPenalty: true,
    penaltyFor(segmentId, atTimeSeconds) {
      const risk = lookup(segmentId);
      if (!risk || !(risk.degradationProbability > 0)) return null;
      const penalty = penaltyFn({
        segmentId,
        severity: risk.severity,
        confidence: clamp01(risk.degradationProbability * risk.confidence),
        issueType: risk.issueType,
        atTime: atTimeSeconds,
        // The lookup only returns risks that are currently in force.
        isOngoing: true,
      });
      if (!Number.isFinite(penalty.penaltySeconds) && !Number.isFinite(penalty.multiplier)) {
        return null;
      }
      if (penalty.multiplier <= 1 && penalty.penaltySeconds <= 0) return null;
      return penalty;
    },
  };
}
