import { describe, expect, it } from "vitest";
import type { Itinerary, SegmentId } from "@/lib/contracts";
import {
  BADGE_THRESHOLDS,
  MATERIAL_RISK_SCORE_PENALTY,
  assessItinerary,
  consequenceWeight,
  rankItineraries,
  reliabilityBadgeFor,
} from "@/lib/risk/rank";
import {
  NOW_ISO,
  type RideLegSpec,
  makeItinerary,
  makeLookup,
  makeSegmentId,
  makeSegmentRisk,
  makeSimpleItinerary,
} from "./fixtures";

const RISKY_SEGMENT: SegmentId = makeSegmentId("KJ", "KJ4", "KJ5");

function segmentsFor(lineId: string, count: number): SegmentId[] {
  return Array.from({ length: count }, (_, i) =>
    makeSegmentId(lineId, `${lineId}${i}`, `${lineId}${i + 1}`),
  );
}

function scheduledSeconds(itinerary: Itinerary): number {
  return itinerary.legs.reduce((total, leg) => total + leg.scheduledSeconds, 0);
}

/** The "fast but risky" candidate: 18 min scheduled, one materially risky segment. */
function fastRisky(): Itinerary {
  const segmentIds = segmentsFor("KJ", 9);
  return makeItinerary({
    id: "fast-risky",
    departureTime: 8 * 3600,
    rideLegs: [{ lineId: "KJ", segmentIds, scheduledSeconds: 9 * 120 }],
    riskLookup: makeLookup([
      makeSegmentRisk({
        segmentId: RISKY_SEGMENT,
        degradationProbability: 0.45,
        confidence: 0.45,
        severity: "MAJOR",
        issueType: "DELAY",
      }),
    ]),
    riskPenaltyOptions: { segmentSeconds: new Map(segmentIds.map((id) => [id, 120])) },
  });
}

/** The "slow but safe" candidate: 24 min scheduled, nothing flagged. */
function slowSafe(): Itinerary {
  return makeItinerary({
    id: "slow-safe",
    departureTime: 8 * 3600,
    rideLegs: [{ lineId: "KGL", segmentIds: segmentsFor("KGL", 9), scheduledSeconds: 9 * 160 }],
  });
}

const RISK_LOOKUP = makeLookup([
  makeSegmentRisk({
    segmentId: RISKY_SEGMENT,
    degradationProbability: 0.45,
    confidence: 0.45,
    severity: "MAJOR",
    issueType: "DELAY",
  }),
]);

describe("THE ACCEPTANCE SCENARIO — 6 minutes faster but riskier is the worse recommendation", () => {
  it("ranks the slower, safer itinerary first", () => {
    const result = rankItineraries({
      itineraries: [fastRisky(), slowSafe()],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });

    expect(result.itineraries.map((it) => it.id)).toEqual(["slow-safe", "fast-risky"]);

    const safe = result.itineraries[0];
    const risky = result.itineraries[1];

    const scheduledGap = scheduledSeconds(safe) - scheduledSeconds(risky);
    const meanGap = safe.totalDurationSeconds - risky.totalDurationSeconds;
    const expectedRiskyScore = 1 - (0.45 * consequenceWeight("MAJOR", "DELAY") + MATERIAL_RISK_SCORE_PENALTY);

    // Evidence for the report: the exact numbers behind the ranking decision.
    console.log(
      `[6-min scenario] scheduled gap=${scheduledGap}s  mean gap=${meanGap.toFixed(1)}s  ` +
        `risky: score=${risky.reliabilityScore.toFixed(4)} badge=${risky.reliabilityBadge} ` +
        `mean=${risky.totalDurationSeconds.toFixed(1)}s p90=${(risky.arrival.p90Seconds - risky.departureTime).toFixed(1)}s ` +
        `gap=${risky.arrival.meanToP90GapSeconds.toFixed(1)}s | ` +
        `safe: score=${safe.reliabilityScore.toFixed(4)} badge=${safe.reliabilityBadge} ` +
        `mean=${safe.totalDurationSeconds.toFixed(1)}s p90=${(safe.arrival.p90Seconds - safe.departureTime).toFixed(1)}s ` +
        `gap=${safe.arrival.meanToP90GapSeconds.toFixed(1)}s`,
    );

    // The risky route really is ~6 minutes faster, on the schedule and on the mean.
    expect(scheduledGap).toBe(360);
    expect(meanGap).toBeGreaterThan(320);
    expect(meanGap).toBeLessThan(360);

    // ...and it still loses, because reliability is the primary key.
    expect(safe.reliabilityScore).toBeCloseTo(1, 10);
    expect(safe.reliabilityBadge).toBe("VERY_RELIABLE");
    expect(risky.reliabilityScore).toBeCloseTo(expectedRiskyScore, 10);
    expect(risky.reliabilityScore).toBeLessThan(BADGE_THRESHOLDS.RELIABLE);
    expect(risky.reliabilityBadge).toBe("UNCERTAIN");
    expect(risky.maxDegradationProbability).toBe(0.45);
    expect(risky.riskySegmentIds).toContain(RISKY_SEGMENT);

    // The recommendation and the explanation both say so.
    expect(result.recommendedItineraryId).toBe("slow-safe");
    expect(risky.whyThisRank).toContain("faster");
    expect(risky.whyThisRank).toContain("less reliable");
    expect(result.noSafeAlternative).toBe(false);
    expect(result.fallback).toBeNull();
  });

  it("still wins when the safe route also carries an extra transfer", () => {
    const safeWithTransfer = makeItinerary({
      id: "slow-safe-transfer",
      departureTime: 8 * 3600,
      rideLegs: [
        { lineId: "KGL", segmentIds: segmentsFor("KGL", 5), scheduledSeconds: 5 * 160 },
        { lineId: "MR", segmentIds: segmentsFor("MR", 4), scheduledSeconds: 4 * 160 },
      ],
      transferSeconds: [240],
    });

    const result = rankItineraries({
      itineraries: [fastRisky(), safeWithTransfer],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });

    expect(result.itineraries[0].id).toBe("slow-safe-transfer");
    expect(result.itineraries[0].reliabilityScore).toBeCloseTo(1 / 1.08, 10);
    expect(result.itineraries[0].reliabilityBadge).toBe("VERY_RELIABLE");
    expect(result.recommendedItineraryId).toBe("slow-safe-transfer");
  });

  it("consumes the router's canonical arrival window instead of recomputing it", () => {
    const candidate = fastRisky();
    const canonicalArrival = { ...candidate.arrival };

    const result = rankItineraries({
      itineraries: [candidate],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });

    expect(result.itineraries[0].arrival).toEqual(canonicalArrival);
    expect(result.itineraries[0].totalDurationSeconds).toBe(
      canonicalArrival.meanSeconds - candidate.departureTime,
    );
    expect(result.itineraries[0].expectedDelaySeconds).toBe(candidate.expectedDelaySeconds);
  });
});

describe("safety is lexicographic, not a score", () => {
  it("ranks a lower-scoring SAFE itinerary above a higher-scoring unsafe one", () => {
    // The unsafe itinerary barely costs anything probabilistically (p=0.01) but its
    // confidence is above 0.7, so it is hard-avoided. The safe itinerary carries
    // six transfers, so its reliability score is genuinely worse.
    const unsafe = makeSimpleItinerary({
      id: "unsafe-high-score",
      lineId: "KJ",
      segmentCount: 9,
      perSegmentSeconds: 120,
      riskLookup: makeLookup([
        makeSegmentRisk({
          segmentId: RISKY_SEGMENT,
          degradationProbability: 0.01,
          confidence: 0.9,
          severity: "MINOR",
          issueType: "ELEVATOR_FAULT",
        }),
      ]),
    });

    const rideLegs: RideLegSpec[] = [
      { lineId: "KGL", segmentIds: segmentsFor("KGL", 9), scheduledSeconds: 9 * 200 },
      ...Array.from({ length: 6 }, (_, i) => ({
        lineId: "KGL" as const,
        segmentIds: [makeSegmentId("KGL", `KGLx${i}`, `KGLx${i + 1}`)],
        scheduledSeconds: 0,
      })),
    ];
    const safe = makeItinerary({
      id: "safe-low-score",
      departureTime: 8 * 3600,
      rideLegs,
      transferSeconds: Array.from({ length: 6 }, () => 0),
    });

    const result = rankItineraries({
      itineraries: [unsafe, safe],
      riskLookup: makeLookup([
        makeSegmentRisk({
          segmentId: RISKY_SEGMENT,
          degradationProbability: 0.01,
          confidence: 0.9,
          severity: "MINOR",
          issueType: "ELEVATOR_FAULT",
        }),
      ]),
      nowIso: NOW_ISO,
    });

    const [first, second] = result.itineraries;
    expect(first.id).toBe("safe-low-score");
    expect(second.id).toBe("unsafe-high-score");
    expect(first.reliabilityScore).toBeLessThan(second.reliabilityScore);
    expect(second.reliabilityBadge).toBe("AVOID");
    expect(result.recommendedItineraryId).toBe("safe-low-score");
    expect(result.noSafeAlternative).toBe(false);
  });
});

describe("reliability first, duration second", () => {
  it("uses duration only to break a reliability tie", () => {
    const slow = makeSimpleItinerary({ id: "slow", lineId: "KJ", segmentCount: 9, perSegmentSeconds: 140 });
    const quick = makeSimpleItinerary({ id: "quick", lineId: "KGL", segmentCount: 9, perSegmentSeconds: 110 });

    const result = rankItineraries({ itineraries: [slow, quick], nowIso: NOW_ISO });

    expect(result.itineraries.map((it) => it.id)).toEqual(["quick", "slow"]);
    expect(result.itineraries[0].reliabilityScore).toBe(result.itineraries[1].reliabilityScore);
    expect(result.itineraries[0].totalDurationSeconds).toBeLessThan(
      result.itineraries[1].totalDurationSeconds,
    );
  });

  it("charges transfers as failure points", () => {
    const direct = assessItinerary(
      makeSimpleItinerary({ id: "direct", lineId: "KJ", segmentCount: 9, perSegmentSeconds: 120 }),
    );
    const withTransfers = assessItinerary(
      makeSimpleItinerary({
        id: "transfers",
        lineId: "KJ",
        segmentCount: 9,
        perSegmentSeconds: 120,
        transferCount: 3,
      }),
    );
    expect(withTransfers.reliabilityScore).toBeLessThan(direct.reliabilityScore);
    expect(withTransfers.itinerary.transferCount).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const first = rankItineraries({
      itineraries: [fastRisky(), slowSafe()],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });
    const second = rankItineraries({
      itineraries: [fastRisky(), slowSafe()],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });
    expect(first.itineraries).toEqual(second.itineraries);
    expect(first.whyThisCouldBeWrong).toBe(second.whyThisCouldBeWrong);
  });
});

describe("badge boundaries", () => {
  it("assigns every badge at its exact boundary", () => {
    expect(reliabilityBadgeFor(1, false)).toBe("VERY_RELIABLE");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.VERY_RELIABLE, false)).toBe("VERY_RELIABLE");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.VERY_RELIABLE - 0.0001, false)).toBe("RELIABLE");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.RELIABLE, false)).toBe("RELIABLE");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.RELIABLE - 0.0001, false)).toBe("UNCERTAIN");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.UNCERTAIN, false)).toBe("UNCERTAIN");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.UNCERTAIN - 0.0001, false)).toBe("AT_RISK");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.AT_RISK, false)).toBe("AT_RISK");
    expect(reliabilityBadgeFor(BADGE_THRESHOLDS.AT_RISK - 0.0001, false)).toBe("AVOID");
    expect(reliabilityBadgeFor(0, false)).toBe("AVOID");
  });

  it("forces AVOID whenever the avoid threshold is crossed, whatever the score", () => {
    expect(reliabilityBadgeFor(1, true)).toBe("AVOID");
    expect(reliabilityBadgeFor(0.99, true)).toBe("AVOID");
  });

  it("normalises consequence so SEVERE + TRACK_FAULT is 1.0", () => {
    expect(consequenceWeight("SEVERE", "TRACK_FAULT")).toBeCloseTo(1, 10);
    expect(consequenceWeight("INFO", "TRACK_FAULT")).toBe(0);
    expect(consequenceWeight("MAJOR", "TRACK_FAULT")).toBeCloseTo(0.6 / 1.75, 10);
    expect(consequenceWeight("SEVERE", "ELEVATOR_FAULT")).toBeCloseTo(0.35, 10);
  });
});

describe("the noSafeAlternative path", () => {
  const avoidLookup = makeLookup([
    makeSegmentRisk({
      segmentId: RISKY_SEGMENT,
      degradationProbability: 0.8,
      confidence: 0.85,
      severity: "SEVERE",
      issueType: "TRACK_FAULT",
    }),
  ]);

  it("withholds the rail recommendation and provides a ground-transport fallback", () => {
    const only = makeSimpleItinerary({
      id: "only-unsafe",
      lineId: "KJ",
      segmentCount: 9,
      perSegmentSeconds: 120,
      riskLookup: avoidLookup,
    });

    const result = rankItineraries({
      itineraries: [only],
      riskLookup: avoidLookup,
      nowIso: NOW_ISO,
      originStationId: "KJ0",
      destinationStationId: "KJ9",
      atTime: 8 * 3600,
    });

    expect(result.noSafeAlternative).toBe(true);
    expect(result.recommendedItineraryId).toBeNull();
    expect(result.itineraries[0].reliabilityBadge).toBe("AVOID");
    expect(result.itineraries[0].whyThisRank).toContain("avoid");

    expect(result.fallback).not.toBeNull();
    expect(result.fallback?.description).toContain("KJ0");
    expect(result.fallback?.description).toContain("KJ9");
    expect(result.fallback?.estimatedDurationSeconds).toBeGreaterThan(0);
    expect(result.fallback?.note).toContain("70%");
    expect(result.fallback?.note).toContain("km");
  });

  it("recommends the safe alternative when one exists, and offers no fallback", () => {
    const unsafe = makeSimpleItinerary({
      id: "unsafe",
      lineId: "KJ",
      segmentCount: 9,
      perSegmentSeconds: 120,
      riskLookup: avoidLookup,
    });
    const safe = makeSimpleItinerary({
      id: "safe",
      lineId: "KGL",
      segmentCount: 9,
      perSegmentSeconds: 200,
    });

    const result = rankItineraries({
      itineraries: [unsafe, safe],
      riskLookup: avoidLookup,
      nowIso: NOW_ISO,
      originStationId: "KJ0",
      destinationStationId: "KGL9",
    });

    expect(result.noSafeAlternative).toBe(false);
    expect(result.recommendedItineraryId).toBe("safe");
    expect(result.fallback).toBeNull();
    expect(result.itineraries[1].reliabilityBadge).toBe("AVOID");
    expect(result.itineraries[1].whyThisRank).toContain("70%");
  });

  it("treats an empty candidate set as having no safe alternative", () => {
    const result = rankItineraries({
      itineraries: [],
      nowIso: NOW_ISO,
      originStationId: "KJ0",
      destinationStationId: "KJ9",
      fallbackRailSeconds: 1800,
    });
    expect(result.noSafeAlternative).toBe(true);
    expect(result.recommendedItineraryId).toBeNull();
    expect(result.fallback).not.toBeNull();
    expect(result.whyThisCouldBeWrong).toContain("no rail itinerary");
  });
});

describe("explanations", () => {
  it("writes a whyThisRank for every itinerary, and a real one for rank 1", () => {
    const result = rankItineraries({
      itineraries: [fastRisky(), slowSafe()],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });

    for (const itinerary of result.itineraries) {
      expect(itinerary.whyThisRank.length).toBeGreaterThan(30);
      expect(itinerary.whyThisRank).toContain(`Ranked ${itinerary.rank} of 2`);
    }
    expect(result.itineraries[0].whyThisRank).toContain("Ranked 1 of 2");
    expect(result.itineraries[0].whyThisRank).toContain("no reported disruption");
  });

  it("states exactly one sentence for whyThisCouldBeWrong", () => {
    const result = rankItineraries({
      itineraries: [fastRisky(), slowSafe()],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });

    const sentence = result.whyThisCouldBeWrong;
    expect(sentence.endsWith(".")).toBe(true);
    // No internal sentence boundary (a ". " followed by a capital).
    expect(sentence).not.toMatch(/\.\s+[A-Z]/);
    expect(sentence).toContain("The most likely reason this is wrong is");
  });

  it("names the recommendation's own worst segment when it carries risk", () => {
    const only = makeSimpleItinerary({
      id: "risky-only",
      lineId: "KJ",
      segmentCount: 9,
      perSegmentSeconds: 120,
      riskLookup: RISK_LOOKUP,
    });
    const result = rankItineraries({
      itineraries: [only],
      riskLookup: RISK_LOOKUP,
      nowIso: NOW_ISO,
    });
    expect(result.whyThisCouldBeWrong).toContain(RISKY_SEGMENT);
    expect(result.whyThisCouldBeWrong).toContain("DELAY");
  });

  it("names staleness when the overlay is stale", () => {
    const staleOverlay = {
      generatedAt: NOW_ISO,
      asOf: "2025-06-02T00:30:00.000Z",
      stalenessMinutes: 40,
      isStale: true,
      source: "cache" as const,
      segments: [],
    };
    const result = rankItineraries({
      itineraries: [slowSafe()],
      nowIso: NOW_ISO,
      overlay: staleOverlay,
    });
    expect(result.whyThisCouldBeWrong).toContain("40 minutes old");
    expect(result.computedOffline).toBe(true);
    expect(result.riskAsOf).toBe("2025-06-02T00:30:00.000Z");
  });

  it("names unresolved signals when some could not be tied to a segment", () => {
    const result = rankItineraries({
      itineraries: [slowSafe()],
      nowIso: NOW_ISO,
      unresolvedSignalIds: ["sig-a", "sig-b"],
    });
    expect(result.whyThisCouldBeWrong).toContain("2 signals could not be tied");
  });
});
