/**
 * Impact agent — the deterministic rule engine that turns a confirmed disruption
 * plus a set of candidate itineraries into a `RouteAdvisory`.
 *
 * The readable specification for this agent is `lib/agents/impact/prompt.md`.
 * This file is the implementation of that specification; the two must agree.
 * There is no LLM call here and no API key: the prompt is the spec, the code is
 * the agent.
 *
 * The whole module is pure with respect to the outside world: `nowIso` is
 * injected, the risk overlay is injected, and nothing reads the clock, the disk
 * or the network. Same inputs => byte-identical advisory.
 *
 * It delegates the actual ranking to `lib/risk/rank.ts` so there is exactly ONE
 * implementation of "reliability first, duration second" in the codebase.
 */

import type {
  DisruptionSignal,
  Itinerary,
  LatLng,
  RouteAdvisory,
  SegmentRiskLookup,
  StationId,
} from "@/lib/contracts";
import { rankItineraries } from "@/lib/risk/rank";
import type { RiskOverlayDiagnostics } from "@/lib/risk/overlay";
import type { RiskOverlay } from "@/lib/contracts";

export interface ImpactAgentInput {
  originStationId: StationId;
  destinationStationId: StationId;
  /** Candidate itineraries from the router. Reliability fields are recomputed. */
  itineraries: readonly Itinerary[];
  riskLookup?: SegmentRiskLookup;
  overlay?: RiskOverlay;
  /** Output of `buildRiskOverlayWithDiagnostics`; supplies unresolved signal ids. */
  overlayDiagnostics?: RiskOverlayDiagnostics;
  signals?: readonly DisruptionSignal[];
  /** Injected "now", ISO-8601. The agent never reads the wall clock. */
  nowIso: string;
  origin?: LatLng;
  destination?: LatLng;
  /** Local seconds after midnight, for the fallback traffic regime. */
  atTime?: number;
  computedOffline?: boolean;
  advisoryId?: string;
}

/** Deterministic advisory id: same query at the same instant => same id. */
export function makeAdvisoryId(
  originStationId: StationId,
  destinationStationId: StationId,
  nowIso: string,
): string {
  return `adv:${originStationId}->${destinationStationId}@${nowIso}`;
}

/**
 * Run the Impact agent.
 *
 * Rules applied, in order (see prompt.md §3–§6):
 *   - rank by RELIABILITY first, duration second;
 *   - report P90 with the mean alongside;
 *   - price a degraded segment proportionally to severity x confidence;
 *   - never recommend a segment above 0.7 confidence unless no alternative
 *     exists, in which case say so and give a ground-transport fallback;
 *   - state the single most likely reason the recommendation is wrong.
 */
export function runImpactAgent(input: ImpactAgentInput): RouteAdvisory {
  const ranking = rankItineraries({
    itineraries: input.itineraries,
    riskLookup: input.riskLookup,
    overlay: input.overlay,
    signals: input.signals,
    nowIso: input.nowIso,
    originStationId: input.originStationId,
    destinationStationId: input.destinationStationId,
    origin: input.origin,
    destination: input.destination,
    atTime: input.atTime,
    computedOffline: input.computedOffline,
    unresolvedSignalIds: input.overlayDiagnostics?.unresolvedSignalIds,
  });

  return {
    id: input.advisoryId ?? makeAdvisoryId(input.originStationId, input.destinationStationId, input.nowIso),
    generatedAt: input.nowIso,
    originStationId: input.originStationId,
    destinationStationId: input.destinationStationId,
    itineraries: ranking.itineraries,
    recommendedItineraryId: ranking.recommendedItineraryId,
    noSafeAlternative: ranking.noSafeAlternative,
    fallback: ranking.fallback,
    whyThisCouldBeWrong: ranking.whyThisCouldBeWrong,
    consideredSignals: ranking.consideredSignals,
    computedOffline: ranking.computedOffline,
    riskAsOf: ranking.riskAsOf,
  };
}

/* ------------------------------------------------------------------ *
 * Presentation helpers (used by the UI and asserted in tests)
 * ------------------------------------------------------------------ */

/** Seconds after local midnight -> "HH:MM". Pure. */
export function formatClockTime(secondsAfterMidnight: number): string {
  const total = Math.max(0, Math.round(secondsAfterMidnight));
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The advisory as the UI should speak it: P90 first, mean beside it, then the
 * rank justification, then the honest caveat. One string per line.
 */
export function describeAdvisory(advisory: RouteAdvisory): string[] {
  const lines: string[] = [];
  const recommended = advisory.itineraries.find((it) => it.id === advisory.recommendedItineraryId);

  if (!recommended) {
    lines.push(
      `No safe rail option from ${advisory.originStationId} to ${advisory.destinationStationId}.`,
    );
  } else {
    const a = recommended.arrival;
    lines.push(
      `Recommended: ${recommended.id} — arrive by ${formatClockTime(a.p90Seconds)} (P90), ` +
        `typically ${formatClockTime(a.meanSeconds)} (mean); ` +
        `plan for ${Math.round(a.meanToP90GapSeconds / 60)} min of slack. ` +
        `Reliability ${recommended.reliabilityScore.toFixed(2)} (${recommended.reliabilityBadge}).`,
    );
    lines.push(recommended.whyThisRank);
  }

  if (advisory.noSafeAlternative && advisory.fallback) {
    lines.push(
      `No rail itinerary avoids a segment above 70% confidence. ` +
        `${advisory.fallback.description} — about ` +
        `${Math.round(advisory.fallback.estimatedDurationSeconds / 60)} min.`,
    );
  }

  lines.push(`Why this could be wrong: ${advisory.whyThisCouldBeWrong}`);

  if (advisory.computedOffline) {
    lines.push(`Computed offline from cached risk as of ${advisory.riskAsOf}.`);
  }

  return lines;
}
