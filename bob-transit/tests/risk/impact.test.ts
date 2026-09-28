import { describe, expect, it } from "vitest";
import type { Itinerary, SegmentId } from "@/lib/contracts";
import { runImpactAgent, describeAdvisory, formatClockTime, makeAdvisoryId } from "@/lib/agents/impact";
import { buildRiskOverlayWithDiagnostics, createSegmentRiskLookup } from "@/lib/risk/overlay";
import { NOW_ISO, makeItinerary, makeSegmentId, makeSignal } from "./fixtures";

const RISKY_SEGMENT: SegmentId = makeSegmentId("KJ", "KJ4", "KJ5");

function segmentsFor(lineId: string, count: number): SegmentId[] {
  return Array.from({ length: count }, (_, i) =>
    makeSegmentId(lineId, `${lineId}${i}`, `${lineId}${i + 1}`),
  );
}

function itinerariesFor(lookup: ReturnType<typeof createSegmentRiskLookup>): Itinerary[] {
  const riskySegments = segmentsFor("KJ", 9);
  return [
    makeItinerary({
      id: "fast-risky",
      departureTime: 8 * 3600,
      rideLegs: [{ lineId: "KJ", segmentIds: riskySegments, scheduledSeconds: 9 * 120 }],
      riskLookup: lookup,
      riskPenaltyOptions: { segmentSeconds: new Map(riskySegments.map((id) => [id, 120])) },
    }),
    makeItinerary({
      id: "slow-safe",
      departureTime: 8 * 3600,
      rideLegs: [{ lineId: "KGL", segmentIds: segmentsFor("KGL", 9), scheduledSeconds: 9 * 160 }],
    }),
  ];
}

const SIGNALS = [
  makeSignal({
    id: "sig-jamek",
    segmentIds: [RISKY_SEGMENT],
    confidenceValue: 0.45,
    severity: "MAJOR",
    issueType: "DELAY",
    lineIds: ["KJ"],
  }),
];

describe("runImpactAgent — end to end from signals to advisory", () => {
  const diagnostics = buildRiskOverlayWithDiagnostics({ signals: SIGNALS, nowIso: NOW_ISO });
  const lookup = createSegmentRiskLookup(diagnostics.overlay);

  function advisory() {
    return runImpactAgent({
      originStationId: "KJ0",
      destinationStationId: "KGL9",
      itineraries: itinerariesFor(lookup),
      riskLookup: lookup,
      overlay: diagnostics.overlay,
      overlayDiagnostics: diagnostics,
      signals: SIGNALS,
      nowIso: NOW_ISO,
    });
  }

  it("produces a complete RouteAdvisory with the safe route recommended", () => {
    const result = advisory();

    expect(result.id).toBe(makeAdvisoryId("KJ0", "KGL9", NOW_ISO));
    expect(result.generatedAt).toBe(NOW_ISO);
    expect(result.originStationId).toBe("KJ0");
    expect(result.destinationStationId).toBe("KGL9");
    expect(result.itineraries).toHaveLength(2);
    expect(result.itineraries.map((it) => it.id)).toEqual(["slow-safe", "fast-risky"]);
    expect(result.recommendedItineraryId).toBe("slow-safe");
    expect(result.noSafeAlternative).toBe(false);
    expect(result.fallback).toBeNull();
    expect(result.riskAsOf).toBe(NOW_ISO);
    expect(result.computedOffline).toBe(false);
  });

  it("reports P90 with the mean alongside it", () => {
    const result = advisory();
    const recommended = result.itineraries[0];

    expect(recommended.arrival.p90Seconds).toBeGreaterThan(recommended.arrival.meanSeconds);
    expect(recommended.arrival.meanToP90GapSeconds).toBe(
      recommended.arrival.p90Seconds - recommended.arrival.meanSeconds,
    );

    const lines = describeAdvisory(result);
    expect(lines[0]).toContain("P90");
    expect(lines[0]).toContain("mean");
    expect(lines[0]).toContain("slack");
    expect(lines[0]).toContain(recommended.reliabilityBadge);
    expect(lines[1]).toBe(recommended.whyThisRank);
  });

  it("records the signals that influenced the ranking", () => {
    const result = advisory();
    expect(result.consideredSignals).toEqual([
      { signalId: "sig-jamek", confidence: 0.45, severity: "MAJOR", segmentIds: [RISKY_SEGMENT] },
    ]);
  });

  it("states the single most likely reason the recommendation is wrong", () => {
    const result = advisory();
    expect(result.whyThisCouldBeWrong.endsWith(".")).toBe(true);
    expect(result.whyThisCouldBeWrong).not.toMatch(/\.\s+[A-Z]/);
    expect(describeAdvisory(result).some((line) => line.startsWith("Why this could be wrong:"))).toBe(
      true,
    );
  });

  it("is deterministic for the same injected now", () => {
    expect(advisory()).toEqual(advisory());
    expect(JSON.stringify(advisory())).toBe(JSON.stringify(advisory()));
  });

  it("withholds the rail recommendation and offers ground transport when nothing is safe", () => {
    const avoidSignals = [
      makeSignal({
        id: "sig-avoid",
        segmentIds: [RISKY_SEGMENT],
        confidenceValue: 0.85,
        severity: "SEVERE",
        issueType: "TRACK_FAULT",
      }),
    ];
    const avoidDiagnostics = buildRiskOverlayWithDiagnostics({
      signals: avoidSignals,
      nowIso: NOW_ISO,
    });
    const avoidLookup = createSegmentRiskLookup(avoidDiagnostics.overlay);
    const riskySegments = segmentsFor("KJ", 9);

    const result = runImpactAgent({
      originStationId: "KJ0",
      destinationStationId: "KJ9",
      itineraries: [
        makeItinerary({
          id: "only-unsafe",
          departureTime: 8 * 3600,
          rideLegs: [{ lineId: "KJ", segmentIds: riskySegments, scheduledSeconds: 9 * 120 }],
          riskLookup: avoidLookup,
        }),
      ],
      riskLookup: avoidLookup,
      overlay: avoidDiagnostics.overlay,
      overlayDiagnostics: avoidDiagnostics,
      signals: avoidSignals,
      nowIso: NOW_ISO,
      atTime: 8 * 3600,
    });

    expect(result.noSafeAlternative).toBe(true);
    expect(result.recommendedItineraryId).toBeNull();
    expect(result.itineraries[0].reliabilityBadge).toBe("AVOID");
    expect(result.fallback).not.toBeNull();
    expect(result.fallback?.estimatedDurationSeconds).toBeGreaterThan(0);

    const lines = describeAdvisory(result);
    expect(lines[0]).toContain("No safe rail option");
    expect(lines.some((line) => line.includes("No rail itinerary avoids a segment above 70%"))).toBe(
      true,
    );
  });

  it("flags a cached overlay as computed offline", () => {
    const cached = runImpactAgent({
      originStationId: "KJ0",
      destinationStationId: "KGL9",
      itineraries: itinerariesFor(lookup),
      riskLookup: lookup,
      overlay: {
        generatedAt: NOW_ISO,
        asOf: "2025-06-02T00:30:00.000Z",
        stalenessMinutes: 40,
        isStale: true,
        source: "cache",
        segments: diagnostics.overlay.segments,
      },
      signals: SIGNALS,
      nowIso: NOW_ISO,
    });

    expect(cached.computedOffline).toBe(true);
    expect(cached.riskAsOf).toBe("2025-06-02T00:30:00.000Z");
    expect(cached.whyThisCouldBeWrong).toContain("40 minutes old");
    expect(describeAdvisory(cached).some((line) => line.includes("Computed offline"))).toBe(true);
  });

  it("handles an empty candidate set without throwing", () => {
    const result = runImpactAgent({
      originStationId: "KJ0",
      destinationStationId: "KJ9",
      itineraries: [],
      nowIso: NOW_ISO,
    });
    expect(result.itineraries).toEqual([]);
    expect(result.recommendedItineraryId).toBeNull();
    expect(result.noSafeAlternative).toBe(true);
    expect(result.fallback).not.toBeNull();
  });
});

describe("formatClockTime", () => {
  it("formats seconds after midnight, wrapping past 24h", () => {
    expect(formatClockTime(0)).toBe("00:00");
    expect(formatClockTime(8 * 3600 + 5 * 60)).toBe("08:05");
    expect(formatClockTime(23 * 3600 + 59 * 60)).toBe("23:59");
    expect(formatClockTime(25 * 3600)).toBe("01:00");
  });
});
