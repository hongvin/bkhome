/**
 * Reliability scoring and RELIABILITY-FIRST re-ranking.
 *
 * This is the product thesis in code. A router returns itineraries ordered by
 * time; this module throws that order away and rebuilds it:
 *
 *     1. SAFETY   — an itinerary that crosses a segment above
 *                   AVOID_SEGMENT_CONFIDENCE_THRESHOLD (0.7) ranks below every
 *                   itinerary that does not, no matter how fast it is.
 *     2. RELIABILITY — `reliabilityScore`, 0..1, higher is better.
 *     3. DURATION — the mean journey time, only ever used as a tie-break.
 *
 * An itinerary that is six minutes faster but crosses a materially risky segment
 * therefore loses to the slower safe one. That is the point of the app, and it is
 * asserted directly in `tests/risk/rank.test.ts`.
 *
 * HOW THE RELIABILITY SCORE IS BUILT (and why it is not a vibe)
 * ------------------------------------------------------------
 * Per traversal of a segment carrying risk `r`:
 *
 *     consequenceWeight = ((SEVERITY_BASE_MULTIPLIER[r.severity] - 1)
 *                          / (SEVERITY_BASE_MULTIPLIER.SEVERE - 1))
 *                         x ISSUE_TYPE_SEVERITY_WEIGHT[r.issueType]
 *
 *     hazard = clamp01(r.degradationProbability * consequenceWeight
 *                      + (r.confidence > MATERIAL_RISK_CONFIDENCE_THRESHOLD
 *                           ? MATERIAL_RISK_SCORE_PENALTY : 0))
 *
 *     journeyHazard = 1 - PROD(1 - hazard_i)          // at least one bites
 *     transferFactor = 1 / (1 + TRANSFER_HAZARD * transfers)
 *     reliabilityScore = clamp01((1 - journeyHazard) * transferFactor)
 *
 * Three things are deliberate here:
 *   - `consequenceWeight` reuses the FROZEN severity/issue constants, normalised
 *     so that SEVERE + TRACK_FAULT = 1.0. The score and the penalty function can
 *     therefore never disagree about how bad a fault is.
 *   - The noisy-OR is the right combination for "the chance that at least one of
 *     these independent segments goes wrong"; summing probabilities would exceed
 *     1 on a long itinerary.
 *   - Crossing the FROZEN material-risk threshold costs a flat
 *     MATERIAL_RISK_SCORE_PENALTY on top. That is not a probabilistic term and is
 *     not pretending to be one: the contract says a segment above 0.4 confidence
 *     "is treated as materially risky when ranking reliability", so the score
 *     applies an explicit, auditable discount for it.
 *
 * Transfers are charged because every interchange is an extra failure point
 * (missed connection, no through service), not because they are slow.
 *
 * ONE ARRIVAL MODEL
 * -----------------
 * Per the orchestrator ruling, `lib/routing/reliability.ts::computeArrivalWindow`
 * is the single canonical arrival model. This module CONSUMES `itinerary.arrival`
 * and never recomputes it: the P90 the rider sees must be the P90 that drove the
 * ranking. `expectedDelaySeconds` is read back from the itinerary, where it is the
 * router's sum of our own `RiskPenalty.penaltySeconds` — the same mu the canonical
 * window was built from.
 *
 * TIME IS INJECTED. Nothing here reads the wall clock.
 */

import type {
  DisruptionSignal,
  GroundTransportFallback,
  Itinerary,
  LatLng,
  ReliabilityBadge,
  RiskOverlay,
  RouteAdvisory,
  SegmentId,
  SegmentRisk,
  SegmentRiskLookup,
  StationId,
} from "@/lib/contracts";
import {
  AVOID_SEGMENT_CONFIDENCE_THRESHOLD,
  ISSUE_TYPE_SEVERITY_WEIGHT,
  MATERIAL_RISK_CONFIDENCE_THRESHOLD,
  SEVERITY_BASE_MULTIPLIER,
} from "@/lib/contracts";
import { estimateGroundTransportFallback } from "./ground";
import { isAvoidConfidence, isMaterialRisk } from "./penalty";

/* ------------------------------------------------------------------ *
 * Scoring constants
 * ------------------------------------------------------------------ */

/**
 * Reliability points lost for crossing a segment above the material-risk
 * confidence threshold. Caps a single-material-segment itinerary at 0.70
 * (UNCERTAIN), which is the intended product behaviour.
 */
export const MATERIAL_RISK_SCORE_PENALTY = 0.3;

/** Extra failure points charged per interchange. */
export const TRANSFER_HAZARD = 0.08;

/** Badge boundaries, descending. */
export const BADGE_THRESHOLDS = {
  VERY_RELIABLE: 0.9,
  RELIABLE: 0.75,
  UNCERTAIN: 0.55,
  AT_RISK: 0.35,
} as const;

/** Default rail time used for the fallback estimate when no itinerary exists. */
export const DEFAULT_FALLBACK_RAIL_SECONDS = 1800;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Normalised consequence of a disruption, in [0,1]. SEVERE + TRACK_FAULT = 1. */
export function consequenceWeight(severity: SegmentRisk["severity"], issueType: SegmentRisk["issueType"]): number {
  const maxExcess = SEVERITY_BASE_MULTIPLIER.SEVERE - 1;
  const severityFactor = (SEVERITY_BASE_MULTIPLIER[severity] - 1) / maxExcess;
  return clamp01(severityFactor * ISSUE_TYPE_SEVERITY_WEIGHT[issueType]);
}

export function reliabilityBadgeFor(
  score: number,
  crossesAvoidThreshold: boolean,
): ReliabilityBadge {
  if (crossesAvoidThreshold) return "AVOID";
  if (score >= BADGE_THRESHOLDS.VERY_RELIABLE) return "VERY_RELIABLE";
  if (score >= BADGE_THRESHOLDS.RELIABLE) return "RELIABLE";
  if (score >= BADGE_THRESHOLDS.UNCERTAIN) return "UNCERTAIN";
  if (score >= BADGE_THRESHOLDS.AT_RISK) return "AT_RISK";
  return "AVOID";
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

interface SegmentTraversal {
  segmentId: SegmentId;
}

/**
 * Every RIDE-segment traversal in the itinerary. A segment ridden twice is
 * counted twice, because the rider really does take the risk twice.
 */
function rideSegmentTraversals(itinerary: Itinerary): SegmentTraversal[] {
  const traversals: SegmentTraversal[] = [];
  for (const leg of itinerary.legs) {
    if (leg.kind !== "RIDE") continue;
    for (const segmentId of leg.segmentIds ?? []) {
      traversals.push({ segmentId });
    }
  }
  return traversals;
}

export interface ItineraryAssessment {
  itinerary: Itinerary;
  reliabilityScore: number;
  reliabilityBadge: ReliabilityBadge;
  riskySegmentIds: SegmentId[];
  maxDegradationProbability: number;
  expectedDelaySeconds: number;
  crossesAvoidThreshold: boolean;
  /** True when this itinerary may be recommended. */
  safe: boolean;
  /** The single worst segment by probability x consequence, if any. */
  worstRisk: SegmentRisk | undefined;
  worstSegmentId: SegmentId | undefined;
}

/**
 * Score one itinerary's RELIABILITY. Pure: it reads only its arguments.
 *
 * The arrival window is NOT computed here. Per the orchestrator ruling there is
 * one canonical arrival model (`lib/routing/reliability.ts`), the router already
 * ran it, and `itinerary.arrival` is what the rider sees. Ranking must therefore
 * consume that window, never produce a rival one.
 */
export function assessItinerary(
  itinerary: Itinerary,
  riskLookup?: SegmentRiskLookup,
): ItineraryAssessment {
  const traversals = rideSegmentTraversals(itinerary);
  const riskySegmentIds = new Set<SegmentId>();

  let hazardProduct = 1;
  let maxDegradationProbability = 0;
  let crossesAvoidThreshold = false;
  let worstRisk: SegmentRisk | undefined;
  let worstScore = -1;

  for (const traversal of traversals) {
    const risk = riskLookup?.(traversal.segmentId);
    if (!risk) continue;

    const consequence = consequenceWeight(risk.severity, risk.issueType);
    const material = isMaterialRisk(risk.confidence) || isMaterialRisk(risk.degradationProbability);
    if (material) riskySegmentIds.add(risk.segmentId);
    if (isAvoidConfidence(risk.confidence)) crossesAvoidThreshold = true;

    const hazard = clamp01(
      risk.degradationProbability * consequence +
        (material ? MATERIAL_RISK_SCORE_PENALTY : 0),
    );
    hazardProduct *= 1 - hazard;

    if (risk.degradationProbability > maxDegradationProbability) {
      maxDegradationProbability = risk.degradationProbability;
    }
    const severityWeighted = risk.degradationProbability * consequence;
    if (severityWeighted > worstScore) {
      worstScore = severityWeighted;
      worstRisk = risk;
    }
  }

  const journeyHazard = 1 - hazardProduct;
  const transferCount = itinerary.legs.filter((leg) => leg.kind === "TRANSFER").length;
  const transferFactor = 1 / (1 + TRANSFER_HAZARD * Math.max(0, transferCount));
  const reliabilityScore = clamp01((1 - journeyHazard) * transferFactor);
  const reliabilityBadge = reliabilityBadgeFor(reliabilityScore, crossesAvoidThreshold);
  const safe = !crossesAvoidThreshold && reliabilityScore >= BADGE_THRESHOLDS.AT_RISK;

  return {
    itinerary,
    reliabilityScore,
    reliabilityBadge,
    riskySegmentIds: [...riskySegmentIds].sort(),
    maxDegradationProbability,
    // The canonical window's mean is `scheduled + mu`, and mu is the router's sum
    // of our own `RiskPenalty.penaltySeconds`. Reading it back keeps the displayed
    // expected delay and the displayed mean the same number by construction.
    expectedDelaySeconds: Math.max(0, itinerary.expectedDelaySeconds),
    crossesAvoidThreshold,
    safe,
    worstRisk,
    worstSegmentId: worstRisk?.segmentId,
  };
}

/* ------------------------------------------------------------------ *
 * Explanations
 * ------------------------------------------------------------------ */

function minutes(seconds: number): string {
  return (seconds / 60).toFixed(1);
}

function pct(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function riskClause(assessment: ItineraryAssessment): string {
  if (!assessment.worstRisk) return "no reported disruption on any segment";
  const r = assessment.worstRisk;
  return (
    `crosses ${assessment.riskySegmentIds.length || 1} materially risky segment(s); worst is ` +
    `${r.segmentId} (${r.severity} ${r.issueType}, ${pct(r.confidence)} confidence, ` +
    `${pct(r.degradationProbability)} degradation), expected +${minutes(
      assessment.expectedDelaySeconds,
    )} min of delay`
  );
}

function whyThisRank(
  assessment: ItineraryAssessment,
  rank: number,
  total: number,
  top: ItineraryAssessment,
  fastestDurationSeconds: number,
): string {
  const score = assessment.reliabilityScore.toFixed(2);
  const durationMin = minutes(assessment.itinerary.totalDurationSeconds);

  if (rank === 1) {
    const slowerThanFastest = assessment.itinerary.totalDurationSeconds - fastestDurationSeconds;
    const trade =
      slowerThanFastest > 0
        ? ` It is ${minutes(slowerThanFastest)} min slower than the fastest option; that is the trade reliability-first ranking makes.`
        : " It is also the fastest option.";
    const unsafeNote = assessment.crossesAvoidThreshold
      ? ` It crosses a segment above the ${Math.round(
          AVOID_SEGMENT_CONFIDENCE_THRESHOLD * 100,
        )}% confidence threshold and no candidate avoids it, so it is not recommended.`
      : "";
    return `Ranked 1 of ${total}: reliability ${score} (${assessment.reliabilityBadge}) — ${riskClause(
      assessment,
    )}. ${durationMin} min door to door, ${assessment.itinerary.transferCount} transfer(s).${trade}${unsafeNote}`;
  }

  const fasterThanTop =
    top.itinerary.totalDurationSeconds - assessment.itinerary.totalDurationSeconds;
  const speedNote =
    fasterThanTop > 0
      ? ` It is ${minutes(fasterThanTop)} min faster than the top option but less reliable, so it ranks below it.`
      : "";
  const unsafeNote = assessment.crossesAvoidThreshold
    ? ` It crosses a segment above the ${Math.round(
        AVOID_SEGMENT_CONFIDENCE_THRESHOLD * 100,
      )}% confidence threshold, so it ranks below every safe option.`
    : "";

  return `Ranked ${rank} of ${total}: reliability ${score} (${
    assessment.reliabilityBadge
  }) against ${top.reliabilityScore.toFixed(2)} for the top option — ${riskClause(
    assessment,
  )}.${speedNote}${unsafeNote}`;
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

export interface RankItinerariesOptions {
  /** Candidate itineraries from the router. Reliability fields are recomputed. */
  itineraries: readonly Itinerary[];
  riskLookup?: SegmentRiskLookup;
  overlay?: RiskOverlay;
  signals?: readonly DisruptionSignal[];
  /** Injected "now", ISO-8601. Never read from the clock. */
  nowIso: string;
  originStationId?: StationId;
  destinationStationId?: StationId;
  origin?: LatLng;
  destination?: LatLng;
  /** Local seconds after midnight used for the fallback traffic regime. */
  atTime?: number;
  computedOffline?: boolean;
  /** Ids of UNRESOLVED signals, surfaced in `whyThisCouldBeWrong`. */
  unresolvedSignalIds?: readonly string[];
  /** Rail time to assume for the fallback when no itinerary exists, seconds. */
  fallbackRailSeconds?: number;
}

export interface RankingResult {
  itineraries: Itinerary[];
  recommendedItineraryId: string | null;
  noSafeAlternative: boolean;
  fallback: GroundTransportFallback | null;
  whyThisCouldBeWrong: string;
  consideredSignals: RouteAdvisory["consideredSignals"];
  computedOffline: boolean;
  riskAsOf: string;
  /** Full assessments, for the Source Inspector. Keyed by itinerary id. */
  assessments: ReadonlyMap<string, ItineraryAssessment>;
}

function sumScheduledSeconds(itinerary: Itinerary): number {
  return itinerary.legs.reduce((total, leg) => total + Math.max(0, leg.scheduledSeconds), 0);
}

function countLines(itinerary: Itinerary): number {
  const lines = new Set<string>();
  for (const leg of itinerary.legs) {
    if (leg.kind === "RIDE" && leg.lineId) lines.add(leg.lineId);
  }
  return lines.size;
}

function countTransfers(itinerary: Itinerary): number {
  return itinerary.legs.filter((leg) => leg.kind === "TRANSFER").length;
}

/**
 * Re-rank itineraries reliability-first and produce everything the advisory needs.
 */
export function rankItineraries(options: RankItinerariesOptions): RankingResult {
  const { itineraries, riskLookup, overlay, nowIso } = options;

  const assessments = new Map<string, ItineraryAssessment>();
  for (const itinerary of itineraries) {
    assessments.set(itinerary.id, assessItinerary(itinerary, riskLookup));
  }

  // The arrival window is the router's canonical one and is CONSUMED, never
  // recomputed: `Itinerary.arrival` is what flows to the UI, so it must also be
  // what the ranking was computed against.
  const enriched: ItineraryAssessment[] = [];
  for (const assessment of assessments.values()) {
    const itinerary = assessment.itinerary;
    enriched.push({
      ...assessment,
      itinerary: {
        ...itinerary,
        totalDurationSeconds: itinerary.arrival.meanSeconds - itinerary.departureTime,
        transferCount: countTransfers(itinerary),
        lineCount: countLines(itinerary),
      },
    });
  }

  const sorted = [...enriched].sort((a, b) => {
    if (a.safe !== b.safe) return a.safe ? -1 : 1;
    if (b.reliabilityScore !== a.reliabilityScore) return b.reliabilityScore - a.reliabilityScore;
    if (a.itinerary.totalDurationSeconds !== b.itinerary.totalDurationSeconds) {
      return a.itinerary.totalDurationSeconds - b.itinerary.totalDurationSeconds;
    }
    return a.itinerary.id < b.itinerary.id ? -1 : a.itinerary.id > b.itinerary.id ? 1 : 0;
  });

  const top = sorted[0];
  const ranked: Itinerary[] = sorted.map((assessment, index) => {
    const withRank: Itinerary = {
      ...assessment.itinerary,
      reliabilityScore: assessment.reliabilityScore,
      reliabilityBadge: assessment.reliabilityBadge,
      riskySegmentIds: assessment.riskySegmentIds,
      maxDegradationProbability: assessment.maxDegradationProbability,
      expectedDelaySeconds: assessment.expectedDelaySeconds,
      rank: index + 1,
      whyThisRank: "",
    };
    return withRank;
  });

  // whyThisRank needs the final ranking, so fill it in a second pass.
  const fastestDurationSeconds = Math.min(
    ...sorted.map((assessment) => assessment.itinerary.totalDurationSeconds),
  );
  for (let index = 0; index < ranked.length; index += 1) {
    const assessment = sorted[index];
    ranked[index] = {
      ...ranked[index],
      whyThisRank: whyThisRank(
        { ...assessment, itinerary: ranked[index] },
        index + 1,
        ranked.length,
        { ...top, itinerary: ranked[0] },
        fastestDurationSeconds,
      ),
    };
  }

  const safeRanked = sorted.filter((assessment) => assessment.safe);
  const noSafeAlternative = safeRanked.length === 0;
  const recommendedItineraryId = noSafeAlternative ? null : safeRanked[0].itinerary.id;

  const originStationId =
    options.originStationId ?? ranked[0]?.legs[0]?.fromStationId ?? "UNKNOWN_ORIGIN";
  const destinationStationId =
    options.destinationStationId ??
    ranked[0]?.legs[ranked[0].legs.length - 1]?.toStationId ??
    "UNKNOWN_DESTINATION";

  const fallback = noSafeAlternative
    ? estimateGroundTransportFallback({
        originStationId,
        destinationStationId,
        railScheduledSeconds:
          options.fallbackRailSeconds ??
          (ranked.length > 0 ? sumScheduledSeconds(ranked[0]) : DEFAULT_FALLBACK_RAIL_SECONDS),
        origin: options.origin,
        destination: options.destination,
        atTime:
          options.atTime ??
          (ranked.length > 0 ? ranked[0].departureTime : undefined),
      })
    : null;

  const unresolvedSignalIds = options.unresolvedSignalIds ?? [];
  const candidateSegments = new Set<SegmentId>();
  for (const itinerary of ranked) {
    for (const leg of itinerary.legs) {
      for (const segmentId of leg.segmentIds ?? []) candidateSegments.add(segmentId);
    }
  }

  const consideredSignals = (options.signals ?? [])
    .filter((signal) => {
      if (signal.segmentIds.length === 0) return true; // unresolved: still explains risk
      return signal.segmentIds.some((segmentId) => candidateSegments.has(segmentId));
    })
    .map((signal) => ({
      signalId: signal.id,
      confidence: signal.confidence.value,
      severity: signal.severity,
      segmentIds: [...signal.segmentIds],
    }))
    .sort((a, b) => (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));

  const finalAssessments = new Map<string, ItineraryAssessment>();
  for (let index = 0; index < ranked.length; index += 1) {
    finalAssessments.set(ranked[index].id, { ...sorted[index], itinerary: ranked[index] });
  }

  return {
    itineraries: ranked,
    recommendedItineraryId,
    noSafeAlternative,
    fallback,
    whyThisCouldBeWrong: buildWhyThisCouldBeWrong({
      ranked,
      assessments: finalAssessments,
      noSafeAlternative,
      overlay,
      unresolvedSignalIds,
    }),
    consideredSignals,
    computedOffline: options.computedOffline ?? overlay?.source === "cache",
    riskAsOf: overlay?.asOf ?? nowIso,
    assessments: finalAssessments,
  };
}

/* ------------------------------------------------------------------ *
 * "The single most likely reason this is wrong"
 * ------------------------------------------------------------------ */

export interface WhyThisCouldBeWrongInput {
  ranked: readonly Itinerary[];
  assessments: ReadonlyMap<string, ItineraryAssessment>;
  noSafeAlternative: boolean;
  overlay?: RiskOverlay;
  unresolvedSignalIds: readonly string[];
}

/**
 * Exactly one sentence, naming the SINGLE most likely failure mode of this
 * recommendation. Ordered by how likely each failure actually is, so the sentence
 * is always about the dominant one rather than a list.
 */
export function buildWhyThisCouldBeWrong(input: WhyThisCouldBeWrongInput): string {
  const { ranked, assessments, noSafeAlternative, overlay, unresolvedSignalIds } = input;

  if (ranked.length === 0) {
    return (
      "The most likely reason this is wrong is that we found no rail itinerary at all, " +
      "so the road estimate may be ignoring a service that is in fact running."
    );
  }

  if (noSafeAlternative) {
    return (
      `Every rail option crosses a segment above the ${Math.round(
        AVOID_SEGMENT_CONFIDENCE_THRESHOLD * 100,
      )}% confidence threshold, so the most likely reason this is wrong is that the ` +
      "disruption clears sooner than the road fallback assumes."
    );
  }

  if (overlay?.isStale) {
    return (
      `Risk data is ${overlay.stalenessMinutes} minutes old (as of ${overlay.asOf}), so the most ` +
      "likely reason this is wrong is that a disruption was cleared or newly reported after that snapshot."
    );
  }

  if (unresolvedSignalIds.length > 0) {
    const n = unresolvedSignalIds.length;
    return (
      `${n} signal${n === 1 ? "" : "s"} could not be tied to a specific segment, so the most likely ` +
      "reason this is wrong is that one of those unresolved disruptions is sitting on the recommended line."
    );
  }

  const recommended = ranked[0];
  const assessment = assessments.get(recommended.id);
  const fastest = [...ranked].sort(
    (a, b) => a.totalDurationSeconds - b.totalDurationSeconds,
  )[0];

  if (assessment?.worstRisk) {
    const r = assessment.worstRisk;
    return (
      `The most likely reason this is wrong is that the ${r.severity} ${r.issueType} on ` +
      `${r.segmentId} is worse than the ${pct(r.confidence)} confidence suggests, which would make ` +
      `the ${fastest.id} option the better choice after all.`
    );
  }

  const line = recommended.legs.find((leg) => leg.kind === "RIDE" && leg.lineId)?.lineId ?? "the line";
  return (
    `The most likely reason this is wrong is that no signal has reached us yet for ${line}, so an ` +
    `unreported disruption on it would make the ${fastest.id} option the better choice.`
  );
}
