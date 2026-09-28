/**
 * Reliability-first ranking — the product thesis, encoded as a pure function.
 *
 * The router (S1) already returns ranked itineraries, but the UI re-ranks
 * defensively through this module so the interface can never present a
 * speed-first order, even if an upstream change regresses. One definition of
 * "reliable" is shared by the mock router and the view.
 *
 * Pure: no I/O, no clock, no React. Directly unit-tested in tests/ui/ranking.test.ts.
 */
import type {
  Itinerary,
  ReliabilityBadge,
  SegmentRisk,
  SegmentRiskLookup,
  Severity,
} from "@/lib/contracts";
import {
  AVOID_SEGMENT_CONFIDENCE_THRESHOLD,
  MATERIAL_RISK_CONFIDENCE_THRESHOLD,
} from "@/lib/contracts";

import type { TranslationKey } from "@/lib/i18n";

/** Weights of the reliability score. Exported so tests can reason about them. */
export const RELIABILITY_WEIGHTS = {
  /** Cost of the single riskiest segment on the itinerary. */
  maxRisk: 0.62,
  /** Cost of expected delay, normalised by journey length. */
  expectedDelay: 0.3,
  /** Small penalty per transfer, capped at 3. */
  transfer: 0.04,
  /** Floor used to normalise the delay ratio so short trips are not over-penalised. */
  delayNormaliserSeconds: 600,
} as const;

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface ReliabilityInput {
  maxDegradationProbability: number;
  expectedDelaySeconds: number;
  totalDurationSeconds: number;
  transferCount: number;
}

/**
 * 1.0 = nothing known against it, 0.0 = certainly degraded.
 * Monotonically decreasing in risk, delay and transfers.
 */
export function computeReliabilityScore(input: ReliabilityInput): number {
  const riskTerm = RELIABILITY_WEIGHTS.maxRisk * clamp01(input.maxDegradationProbability);
  const denominator = Math.max(
    RELIABILITY_WEIGHTS.delayNormaliserSeconds,
    input.totalDurationSeconds,
  );
  const delayRatio = clamp01(input.expectedDelaySeconds / denominator);
  const delayTerm = RELIABILITY_WEIGHTS.expectedDelay * delayRatio;
  const transferTerm = RELIABILITY_WEIGHTS.transfer * Math.min(input.transferCount, 3);
  return Number(clamp01(1 - riskTerm - delayTerm - transferTerm).toFixed(4));
}

/**
 * Badge thresholds. `AVOID` is forced whenever a segment is above the shared
 * `AVOID_SEGMENT_CONFIDENCE_THRESHOLD`, regardless of how good the score looks —
 * the router must not recommend a segment it has effectively confirmed broken.
 */
export function badgeFor(
  score: number,
  maxDegradationProbability: number,
): ReliabilityBadge {
  if (maxDegradationProbability >= AVOID_SEGMENT_CONFIDENCE_THRESHOLD) return "AVOID";
  if (score >= 0.85) return "VERY_RELIABLE";
  if (score >= 0.7) return "RELIABLE";
  if (score >= 0.5) return "UNCERTAIN";
  if (score >= 0.3) return "AT_RISK";
  return "AVOID";
}

export function isMaterialRisk(risk: SegmentRisk | undefined): boolean {
  return risk !== undefined && risk.degradationProbability >= MATERIAL_RISK_CONFIDENCE_THRESHOLD;
}

/**
 * Total order used for ranking. Reliability first; duration only breaks ties.
 * Never sorts by raw speed.
 */
export function compareByReliability(a: Itinerary, b: Itinerary): number {
  if (b.reliabilityScore !== a.reliabilityScore) {
    return b.reliabilityScore - a.reliabilityScore;
  }
  if (a.arrival.p90Seconds !== b.arrival.p90Seconds) {
    return a.arrival.p90Seconds - b.arrival.p90Seconds;
  }
  if (a.totalDurationSeconds !== b.totalDurationSeconds) {
    return a.totalDurationSeconds - b.totalDurationSeconds;
  }
  if (a.transferCount !== b.transferCount) return a.transferCount - b.transferCount;
  return a.id.localeCompare(b.id);
}

/** Returns a new array, ranked and with `rank` rewritten 1..n. */
export function rankItineraries<T extends Itinerary>(itineraries: readonly T[]): T[] {
  return [...itineraries]
    .sort(compareByReliability)
    .map((itinerary, index) => ({ ...itinerary, rank: index + 1 }));
}

/** The fastest itinerary by P90 arrival — used to explain why it is NOT first. */
export function fastestByP90(itineraries: readonly Itinerary[]): Itinerary | null {
  let best: Itinerary | null = null;
  for (const itinerary of itineraries) {
    if (!best || itinerary.arrival.p90Seconds < best.arrival.p90Seconds) best = itinerary;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Plain-language explanation of a rank, localised through the i18n t() */
/* ------------------------------------------------------------------ */

export interface ReasonFragment {
  key: TranslationKey;
  params?: Record<string, string | number>;
}

export interface RankExplanation {
  /** The headline sentence. */
  headline: ReasonFragment;
  /** Supporting evidence lines, shown under the headline. */
  details: ReasonFragment[];
}

export interface ExplainOptions {
  /** All ranked itineraries, so the explanation can compare against the fastest. */
  all: readonly Itinerary[];
  riskLookup?: SegmentRiskLookup;
  fastest?: Itinerary | null;
}

/**
 * The riskiest segment this itinerary actually rides.
 *
 * Scans EVERY ride segment, not just `riskySegmentIds`: that field is restricted
 * to material risk (>= MATERIAL_RISK_CONFIDENCE_THRESHOLD) by the contract, but
 * a minor signal still belongs in the explanation. Saying "no known disruption"
 * about a route that carries a 31%-confidence delay would be dishonest.
 */
function worstRiskOn(
  itinerary: Itinerary,
  riskLookup: SegmentRiskLookup | undefined,
): SegmentRisk | undefined {
  if (!riskLookup) return undefined;
  let worst: SegmentRisk | undefined;
  for (const leg of itinerary.legs) {
    for (const segmentId of leg.segmentIds) {
      const risk = riskLookup(segmentId);
      if (!risk) continue;
      if (!worst || risk.degradationProbability > worst.degradationProbability) worst = risk;
    }
  }
  return worst;
}

function severityKey(severity: Severity): TranslationKey {
  return `severity.${severity}` as TranslationKey;
}

/**
 * Why this itinerary sits at this rank, in plain language.
 *
 * The contract also carries `itinerary.whyThisRank` as an English string from
 * the router; the UI prefers this localised composition and falls back to the
 * contract string only if this returns nothing useful.
 */
export function explainRank(
  itinerary: Itinerary,
  options: ExplainOptions,
): RankExplanation {
  const { all, riskLookup } = options;
  const fastest =
    options.fastest === undefined ? fastestByP90(all) : options.fastest;
  const worst = worstRiskOn(itinerary, riskLookup);
  const details: ReasonFragment[] = [];

  if (worst) {
    details.push({
      key: "why.riskOnBoard",
      params: {
        severity: severityKey(worst.severity),
        issue: `issue.${worst.issueType}`,
        pct: Math.round(worst.degradationProbability * 100),
      },
    });
  }
  if (itinerary.expectedDelaySeconds >= 60) {
    details.push({
      key: "why.delayAdded",
      params: { min: Math.round(itinerary.expectedDelaySeconds / 60) },
    });
  }
  if (fastest && fastest.id !== itinerary.id) {
    const delta = Math.round(
      (itinerary.arrival.p90Seconds - fastest.arrival.p90Seconds) / 60,
    );
    if (delta > 0) details.push({ key: "why.slowerThanFastest", params: { delta } });
  } else if (fastest && fastest.id === itinerary.id) {
    details.push({ key: "why.fastestOption" });
  }

  if (itinerary.rank === 1) {
    if (fastest && fastest.id !== itinerary.id) {
      // The headline case: the top option is NOT the quickest, and the reason
      // is a disruption on the route that is.
      const fastestWorst = fastest ? worstRiskOn(fastest, riskLookup) : undefined;
      if (fastestWorst) {
        details.unshift({
          key: "why.avoidsTheDisruption",
          params: {
            severity: severityKey(fastestWorst.severity),
            issue: `issue.${fastestWorst.issueType}`,
          },
        });
      }
      return {
        headline: {
          key: "why.saferThanFaster",
          params: {
            delta: Math.max(
              1,
              Math.round((itinerary.arrival.p90Seconds - fastest.arrival.p90Seconds) / 60),
            ),
          },
        },
        details,
      };
    }
    if (!worst) {
      return { headline: { key: "why.clean" }, details };
    }
    return {
      headline: { key: "why.mostReliable", params: { count: all.length } },
      details,
    };
  }

  if (worst) {
    return {
      headline: {
        key: "why.lowerRisk",
        params: {
          severity: severityKey(worst.severity),
          issue: `issue.${worst.issueType}`,
          pct: Math.round(worst.degradationProbability * 100),
        },
      },
      details,
    };
  }

  return {
    headline: {
      key: "why.lowerScore",
      params: { rank: itinerary.rank },
    },
    details,
  };
}
