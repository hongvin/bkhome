/**
 * Reliability-first ranking — the product thesis.
 *
 * The acceptance requirement: given itineraries where the FASTEST is RISKIER,
 * the SAFER one must rank first. Nothing here may sort by raw speed.
 */
import { describe, expect, it } from "vitest";

import type { ArrivalWindow, Itinerary, ReliabilityBadge, SegmentRisk } from "@/lib/contracts";
import { AVOID_SEGMENT_CONFIDENCE_THRESHOLD } from "@/lib/contracts";
import {
  RELIABILITY_WEIGHTS,
  badgeFor,
  compareByReliability,
  computeReliabilityScore,
  explainRank,
  fastestByP90,
  rankItineraries,
} from "@/components/lib/ranking";

function windowFrom(p90: number, mean: number): ArrivalWindow {
  return {
    p10Seconds: mean - 60,
    p50Seconds: mean,
    p90Seconds: p90,
    meanSeconds: mean,
    meanToP90GapSeconds: p90 - mean,
  };
}

interface MakeOptions {
  id: string;
  meanSeconds: number;
  p90Seconds: number;
  score: number;
  badge?: ReliabilityBadge;
  maxRisk?: number;
  delay?: number;
  transfers?: number;
  /** Segments on `riskySegmentIds` (material risk only). */
  risky?: string[];
  /** Every ride segment the itinerary touches, so the explanation can scan them. */
  segments?: string[];
}

function makeItinerary(options: MakeOptions): Itinerary {
  const segments = options.segments ?? options.risky ?? [];
  return {
    id: options.id,
    legs:
      segments.length === 0
        ? []
        : [
            {
              kind: "RIDE",
              lineId: "KJ",
              fromStationId: "KJ15",
              toStationId: "KG35",
              departureTime: 8 * 3600,
              arrivalTime: 8 * 3600 + options.meanSeconds,
              segmentIds: segments,
              scheduledSeconds: options.meanSeconds,
              penalties: [],
              addedDelaySeconds: options.delay ?? 0,
            },
          ],
    arrival: windowFrom(options.p90Seconds, options.meanSeconds),
    departureTime: 8 * 3600,
    totalDurationSeconds: options.meanSeconds,
    transferCount: options.transfers ?? 1,
    lineCount: 2,
    reliabilityScore: options.score,
    reliabilityBadge: options.badge ?? "RELIABLE",
    riskySegmentIds: options.risky ?? [],
    maxDegradationProbability: options.maxRisk ?? 0,
    expectedDelaySeconds: options.delay ?? 0,
    rank: 0,
    whyThisRank: "",
  };
}

/** The demo shape: option A is 6 minutes faster but crosses a severe fault. */
const FAST_AND_RISKY = makeItinerary({
  id: "fast-risky",
  meanSeconds: 3126,
  p90Seconds: 3400,
  score: 0.36,
  badge: "AVOID",
  maxRisk: 0.82,
  delay: 258,
  transfers: 1,
  risky: ["KGL:KG17->KG18A"],
  segments: ["KGL:KG16->KG17", "KGL:KG17->KG18A"],
});

const SLOWER_BUT_SAFE = makeItinerary({
  id: "slow-safe",
  meanSeconds: 3293,
  p90Seconds: 3560,
  score: 0.73,
  badge: "RELIABLE",
  maxRisk: 0.31,
  delay: 2,
  transfers: 2,
  risky: ["AG:AG9->AG10"],
  segments: ["AG:AG9->AG10"],
});

describe("reliability-first ordering", () => {
  it("ranks the safer-but-slower option first", () => {
    const ranked = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]);
    expect(ranked[0]?.id).toBe("slow-safe");
    expect(ranked[1]?.id).toBe("fast-risky");
  });

  it("does not sort by raw speed even when the fast option is much faster", () => {
    const veryFast = makeItinerary({
      id: "very-fast",
      meanSeconds: 600,
      p90Seconds: 660,
      score: 0.2,
      maxRisk: 0.9,
    });
    const ranked = rankItineraries([veryFast, SLOWER_BUT_SAFE]);
    expect(ranked[0]?.id).toBe("slow-safe");
  });

  it("rewrites rank as a 1-based position", () => {
    const ranked = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]);
    expect(ranked.map((i) => i.rank)).toEqual([1, 2]);
  });

  it("is a total order: antisymmetric and stable across permutations", () => {
    const a = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]).map((i) => i.id);
    const b = rankItineraries([SLOWER_BUT_SAFE, FAST_AND_RISKY]).map((i) => i.id);
    expect(a).toEqual(b);
    expect(compareByReliability(FAST_AND_RISKY, SLOWER_BUT_SAFE)).toBeGreaterThan(0);
    expect(compareByReliability(SLOWER_BUT_SAFE, FAST_AND_RISKY)).toBeLessThan(0);
    expect(compareByReliability(FAST_AND_RISKY, FAST_AND_RISKY)).toBe(0);
  });

  it("breaks a reliability tie on P90, then on mean duration — never the reverse", () => {
    const slow = makeItinerary({ id: "slow", meanSeconds: 3000, p90Seconds: 3600, score: 0.7 });
    const quick = makeItinerary({ id: "quick", meanSeconds: 3100, p90Seconds: 3400, score: 0.7 });
    expect(rankItineraries([slow, quick])[0]?.id).toBe("quick");

    const sameP90Longer = makeItinerary({
      id: "same-p90-longer",
      meanSeconds: 3500,
      p90Seconds: 3600,
      score: 0.7,
    });
    const sameP90Shorter = makeItinerary({
      id: "same-p90-shorter",
      meanSeconds: 3000,
      p90Seconds: 3600,
      score: 0.7,
    });
    expect(rankItineraries([sameP90Longer, sameP90Shorter])[0]?.id).toBe("same-p90-shorter");
  });

  it("does not mutate its input", () => {
    const input = [FAST_AND_RISKY, SLOWER_BUT_SAFE];
    rankItineraries(input);
    expect(input[0]?.rank).toBe(0);
    expect(input.map((i) => i.id)).toEqual(["fast-risky", "slow-safe"]);
  });

  it("finds the fastest option by P90, which is NOT the top-ranked one here", () => {
    const ranked = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]);
    const fastest = fastestByP90(ranked);
    expect(fastest?.id).toBe("fast-risky");
    expect(ranked[0]?.id).not.toBe(fastest?.id);
  });
});

describe("reliability score", () => {
  it("is 1 for a clean, fast, direct trip", () => {
    expect(
      computeReliabilityScore({
        maxDegradationProbability: 0,
        expectedDelaySeconds: 0,
        totalDurationSeconds: 1800,
        transferCount: 0,
      }),
    ).toBe(1);
  });

  it("decreases monotonically with risk", () => {
    const base = {
      expectedDelaySeconds: 0,
      totalDurationSeconds: 1800,
      transferCount: 0,
    };
    let previous = Number.POSITIVE_INFINITY;
    for (const risk of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const score = computeReliabilityScore({ ...base, maxDegradationProbability: risk });
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });

  it("decreases monotonically with expected delay", () => {
    const base = {
      maxDegradationProbability: 0,
      totalDurationSeconds: 1800,
      transferCount: 0,
    };
    expect(
      computeReliabilityScore({ ...base, expectedDelaySeconds: 600 }),
    ).toBeLessThan(computeReliabilityScore({ ...base, expectedDelaySeconds: 0 }));
  });

  it("applies the documented risk weight to a fully-degraded segment", () => {
    const score = computeReliabilityScore({
      maxDegradationProbability: 1,
      expectedDelaySeconds: 0,
      totalDurationSeconds: 100_000,
      transferCount: 0,
    });
    expect(score).toBeCloseTo(1 - RELIABILITY_WEIGHTS.maxRisk, 4);
  });

  it("stays inside [0,1]", () => {
    const score = computeReliabilityScore({
      maxDegradationProbability: 1,
      expectedDelaySeconds: 100_000,
      totalDurationSeconds: 60,
      transferCount: 5,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe("badges", () => {
  it("forces AVOID above the shared avoid threshold, however good the score looks", () => {
    expect(badgeFor(0.99, AVOID_SEGMENT_CONFIDENCE_THRESHOLD + 0.01)).toBe("AVOID");
  });

  it("maps score bands in order", () => {
    expect(badgeFor(0.9, 0)).toBe("VERY_RELIABLE");
    expect(badgeFor(0.75, 0)).toBe("RELIABLE");
    expect(badgeFor(0.6, 0)).toBe("UNCERTAIN");
    expect(badgeFor(0.35, 0)).toBe("AT_RISK");
    expect(badgeFor(0.1, 0)).toBe("AVOID");
  });
});

describe("rank explanations", () => {
  const riskBySegment = new Map<string, SegmentRisk>([
    [
      "KGL:KG17->KG18A",
      {
        segmentId: "KGL:KG17->KG18A",
        degradationProbability: 0.82,
        confidence: 0.8,
        severity: "SEVERE",
        issueType: "TRACK_FAULT",
        sourceCount: 10,
        lastUpdated: "2025-03-17T00:00:00+08:00",
        stale: false,
      },
    ],
    [
      "AG:AG9->AG10",
      {
        segmentId: "AG:AG9->AG10",
        degradationProbability: 0.31,
        confidence: 0.45,
        severity: "MINOR",
        issueType: "DELAY",
        sourceCount: 4,
        lastUpdated: "2025-03-17T00:00:00+08:00",
        stale: false,
      },
    ],
  ]);

  it("explains the top option as slower-but-safer when it is not the fastest", () => {
    const ranked = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]);
    const top = ranked[0];
    expect(top).toBeDefined();
    if (!top) return;
    const explanation = explainRank(top, {
      all: ranked,
      riskLookup: (id) => riskBySegment.get(id),
    });
    expect(explanation.headline.key).toBe("why.saferThanFaster");
    expect(explanation.headline.params?.delta).toBeGreaterThan(0);
  });

  it("names the severity and issue type of the risk it carries", () => {
    const ranked = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]);
    const top = ranked[0];
    if (!top) throw new Error("expected a top itinerary");
    const explanation = explainRank(top, {
      all: ranked,
      riskLookup: (id) => riskBySegment.get(id),
    });
    const riskDetail = explanation.details.find((d) => d.key === "why.riskOnBoard");
    expect(riskDetail).toBeDefined();
    expect(riskDetail?.params?.severity).toBe("severity.MINOR");
    expect(riskDetail?.params?.pct).toBe(31);
  });

  it("explains a lower-ranked option by the risk it crosses", () => {
    const ranked = rankItineraries([FAST_AND_RISKY, SLOWER_BUT_SAFE]);
    const last = ranked[ranked.length - 1];
    if (!last) throw new Error("expected a last itinerary");
    const explanation = explainRank(last, {
      all: ranked,
      riskLookup: (id) => riskBySegment.get(id),
    });
    expect(explanation.headline.key).toBe("why.lowerRisk");
  });

  it("says a clean top option is clean", () => {
    const clean = makeItinerary({ id: "clean", meanSeconds: 1000, p90Seconds: 1100, score: 0.95 });
    const ranked = rankItineraries([clean]);
    const explanation = explainRank(ranked[0]!, { all: ranked });
    expect(explanation.headline.key).toBe("why.clean");
  });
});
