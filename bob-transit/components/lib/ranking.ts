/**
 * Reliability-first ranking — the product thesis, encoded as a pure function.
 *
 * WHO OWNS WHAT (read this before changing anything here):
 *  - S4's `lib/risk/rank.ts` is the canonical reliability score and badge, and
 *    S1's `lib/routing/reliability.ts` score is router-internal/provisional.
 *    The API returns the Impact agent's advisory, so **the UI renders
 *    `advisory.itineraries` in the order the advisory gives them and does not
 *    re-sort them.** `RouteResults.tsx` maps over the array as-is.
 *  - `rankItineraries` below exists for the ROUTER side (the mock router that
 *    stands in for S1/S4 today, and S1 itself), and as the pure function the
 *    acceptance criterion "the safer route ranks above the faster risky one" is
 *    proved against. No component calls it.
 *
 * Pure: no I/O, no clock, no React. Directly unit-tested in tests/ui/ranking.test.ts.
 */
import type {
  IssueType,
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

/** The quickest itinerary by MEAN duration — what a naive app would show first. */
export function fastestByMean(itineraries: readonly Itinerary[]): Itinerary | null {
  let best: Itinerary | null = null;
  for (const itinerary of itineraries) {
    if (!best || itinerary.totalDurationSeconds < best.totalDurationSeconds) best = itinerary;
  }
  return best;
}

/** The fastest itinerary by P90 arrival. Used as the ranking tie-break. */
export function fastestByP90(itineraries: readonly Itinerary[]): Itinerary | null {
  let best: Itinerary | null = null;
  for (const itinerary of itineraries) {
    if (!best || itinerary.arrival.p90Seconds < best.arrival.p90Seconds) best = itinerary;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Plain-language explanation of a rank                                */
/* ------------------------------------------------------------------ */

/**
 * Explanations are rendered to FINAL STRINGS here, through a `t` function passed
 * in by the caller. That is deliberate: an earlier design returned i18n keys
 * plus params, and the params themselves contained keys (`severity.SEVERE`),
 * which leaked untranslated into the UI. Resolving in one place makes that
 * impossible.
 */
export type ExplainTranslate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

const SEVERITY_KEY: Record<Severity, TranslationKey> = {
  INFO: "severity.INFO",
  MINOR: "severity.MINOR",
  MAJOR: "severity.MAJOR",
  SEVERE: "severity.SEVERE",
};

const ISSUE_KEY: Record<IssueType, TranslationKey> = {
  TRACK_FAULT: "issue.TRACK_FAULT",
  SIGNAL_FAULT: "issue.SIGNAL_FAULT",
  VEHICLE_BREAKDOWN: "issue.VEHICLE_BREAKDOWN",
  ELEVATOR_FAULT: "issue.ELEVATOR_FAULT",
  DOOR_FAULT: "issue.DOOR_FAULT",
  CROWDING: "issue.CROWDING",
  DELAY: "issue.DELAY",
  ROAD_BLOCKED: "issue.ROAD_BLOCKED",
  WEATHER: "issue.WEATHER",
  UNKNOWN: "issue.UNKNOWN",
};

export interface RankExplanation {
  /** The headline sentence, already localised. */
  headline: string;
  /** Supporting evidence lines, already localised. */
  details: string[];
}

export interface ExplainOptions {
  /** All ranked itineraries, so the explanation can compare against the fastest. */
  all: readonly Itinerary[];
  riskLookup?: SegmentRiskLookup;
  /** Defaults to `fastestByMean(all)`. */
  fastest?: Itinerary | null;
  /** Locale-bound translator. */
  t: ExplainTranslate;
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

/**
 * Why this itinerary sits at this rank, in plain language.
 *
 * The contract also carries `itinerary.whyThisRank` as an English string from
 * the router. The UI composes its own localised version and only falls back to
 * the contract string if this produces nothing.
 */
export function explainRank(
  itinerary: Itinerary,
  options: ExplainOptions,
): RankExplanation {
  const { all, riskLookup, t } = options;
  const fastest = options.fastest === undefined ? fastestByMean(all) : options.fastest;
  const worst = worstRiskOn(itinerary, riskLookup);
  const details: string[] = [];

  if (worst) {
    details.push(
      t("why.riskOnBoard", {
        severity: t(SEVERITY_KEY[worst.severity]),
        issue: t(ISSUE_KEY[worst.issueType]),
        pct: Math.round(worst.degradationProbability * 100),
      }),
    );
  }
  if (itinerary.expectedDelaySeconds >= 60) {
    details.push(
      t("why.delayAdded", { min: Math.round(itinerary.expectedDelaySeconds / 60) }),
    );
  }
  if (fastest && fastest.id !== itinerary.id) {
    const delta = Math.round(
      (itinerary.totalDurationSeconds - fastest.totalDurationSeconds) / 60,
    );
    if (delta > 0) details.push(t("why.slowerThanFastest", { delta }));
  }

  if (itinerary.rank === 1) {
    if (fastest && fastest.id !== itinerary.id) {
      // The headline case: the top option is NOT the quickest, and the reason is
      // a disruption on the route that is.
      const fastestWorst = worstRiskOn(fastest, riskLookup);
      if (fastestWorst) {
        details.unshift(
          t("why.avoidsTheDisruption", {
            severity: t(SEVERITY_KEY[fastestWorst.severity]),
            issue: t(ISSUE_KEY[fastestWorst.issueType]),
          }),
        );
      }
      return {
        headline: t("why.saferThanFaster", {
          delta: Math.max(
            1,
            Math.round(
              (itinerary.totalDurationSeconds - fastest.totalDurationSeconds) / 60,
            ),
          ),
        }),
        details,
      };
    }
    if (!worst) return { headline: t("why.clean"), details };
    return { headline: t("why.mostReliable", { count: all.length }), details };
  }

  if (worst) {
    return {
      headline: t("why.lowerRisk", {
        severity: t(SEVERITY_KEY[worst.severity]),
        issue: t(ISSUE_KEY[worst.issueType]),
        pct: Math.round(worst.degradationProbability * 100),
      }),
      details,
    };
  }

  return { headline: t("why.lowerScore", { rank: itinerary.rank }), details };
}
