import { describe, expect, it } from "vitest";
import type { RiskOverlay } from "@/lib/contracts";
import {
  CORROBORATION_CONFIDENCE_BONUS,
  DEFAULT_STALE_AFTER_MINUTES,
  buildRiskOverlay,
  buildRiskOverlayWithDiagnostics,
  createOverlayRiskPenaltyFn,
  createSegmentRiskLookup,
  emptyRiskOverlay,
  minutesBetween,
} from "@/lib/risk/overlay";
import { NOW_ISO, makeSegmentId, makeSignal } from "./fixtures";

const SEG_A = makeSegmentId("KJ", "KJ13", "KJ14");
const SEG_B = makeSegmentId("AG", "AG7", "AG8");

describe("buildRiskOverlay", () => {
  it("builds a live overlay as of the injected now, with no staleness", () => {
    const overlay = buildRiskOverlay({
      signals: [makeSignal({ id: "sig-1", segmentIds: [SEG_A], confidenceValue: 0.6 })],
      nowIso: NOW_ISO,
    });

    expect(overlay.generatedAt).toBe(NOW_ISO);
    expect(overlay.asOf).toBe(NOW_ISO);
    expect(overlay.stalenessMinutes).toBe(0);
    expect(overlay.isStale).toBe(false);
    expect(overlay.source).toBe("live");
    expect(overlay.segments).toHaveLength(1);
    expect(overlay.segments[0].segmentId).toBe(SEG_A);
    expect(overlay.segments[0].stale).toBe(false);
  });

  it("reports the age and staleness of a cached overlay", () => {
    const cached: RiskOverlay = {
      generatedAt: "2025-06-02T00:30:00.000Z",
      asOf: "2025-06-02T00:30:00.000Z",
      stalenessMinutes: 0,
      isStale: false,
      source: "live",
      segments: [],
    };

    const overlay = buildRiskOverlay({
      signals: [],
      nowIso: NOW_ISO,
      source: "cache",
      cached,
    });

    expect(overlay.source).toBe("cache");
    expect(overlay.asOf).toBe("2025-06-02T00:30:00.000Z");
    expect(overlay.stalenessMinutes).toBe(40);
    expect(overlay.isStale).toBe(true);
    expect(overlay.generatedAt).toBe(NOW_ISO);
  });

  it("does not flag a cache that is still fresh", () => {
    const overlay = buildRiskOverlay({
      signals: [],
      nowIso: NOW_ISO,
      source: "cache",
      cached: {
        generatedAt: "2025-06-02T01:05:00.000Z",
        asOf: "2025-06-02T01:05:00.000Z",
        stalenessMinutes: 0,
        isStale: false,
        source: "live",
        segments: [],
      },
    });
    expect(overlay.stalenessMinutes).toBe(5);
    expect(overlay.isStale).toBe(false);
    expect(DEFAULT_STALE_AFTER_MINUTES).toBe(15);
  });

  it("fuses independent signals on one segment with a noisy-OR", () => {
    const overlay = buildRiskOverlay({
      signals: [
        makeSignal({ id: "sig-a", segmentIds: [SEG_A], confidenceValue: 0.5 }),
        makeSignal({ id: "sig-b", segmentIds: [SEG_A], confidenceValue: 0.5 }),
      ],
      nowIso: NOW_ISO,
    });

    expect(overlay.segments).toHaveLength(1);
    expect(overlay.segments[0].degradationProbability).toBeCloseTo(1 - 0.5 * 0.5, 10);
    expect(overlay.segments[0].sourceCount).toBe(2);
  });

  it("raises confidence with independent corroboration at the same fused probability", () => {
    const single = buildRiskOverlay({
      signals: [makeSignal({ id: "sig-one", segmentIds: [SEG_A], confidenceValue: 0.75 })],
      nowIso: NOW_ISO,
    }).segments[0];

    const corroborated = buildRiskOverlay({
      signals: [
        makeSignal({ id: "sig-a", segmentIds: [SEG_A], confidenceValue: 0.5 }),
        makeSignal({ id: "sig-b", segmentIds: [SEG_A], confidenceValue: 0.5 }),
      ],
      nowIso: NOW_ISO,
    }).segments[0];

    expect(corroborated.degradationProbability).toBeCloseTo(single.degradationProbability, 10);
    expect(corroborated.confidence).toBeGreaterThan(single.confidence);
    expect(corroborated.confidence - corroborated.degradationProbability).toBeCloseTo(
      CORROBORATION_CONFIDENCE_BONUS * (1 - Math.exp(-0.5)),
      10,
    );
  });

  it("keeps the most severe and most specific issue on a fused segment", () => {
    const overlay = buildRiskOverlay({
      signals: [
        makeSignal({
          id: "sig-major",
          segmentIds: [SEG_A],
          confidenceValue: 0.6,
          severity: "MAJOR",
          issueType: "DELAY",
        }),
        makeSignal({
          id: "sig-severe",
          segmentIds: [SEG_A],
          confidenceValue: 0.55,
          severity: "SEVERE",
          issueType: "TRACK_FAULT",
        }),
      ],
      nowIso: NOW_ISO,
    });

    expect(overlay.segments[0].severity).toBe("SEVERE");
    expect(overlay.segments[0].issueType).toBe("TRACK_FAULT");
  });

  it("never assigns an UNRESOLVED signal to a segment", () => {
    const diagnostics = buildRiskOverlayWithDiagnostics({
      signals: [
        makeSignal({
          id: "sig-unresolved",
          resolution: "UNRESOLVED",
          segmentIds: [],
          unresolvedCandidates: [SEG_A, SEG_B],
          confidenceValue: 0.7,
        }),
      ],
      nowIso: NOW_ISO,
    });

    expect(diagnostics.overlay.segments).toHaveLength(0);
    expect(diagnostics.unresolvedSignalIds).toEqual(["sig-unresolved"]);
    expect(diagnostics.contributingSignalIds).toEqual([]);
  });

  it("ignores CLEARED, REJECTED and out-of-window signals", () => {
    const diagnostics = buildRiskOverlayWithDiagnostics({
      signals: [
        makeSignal({ id: "sig-cleared", segmentIds: [SEG_A], confidenceValue: 0.9, status: "CLEARED" }),
        makeSignal({ id: "sig-rejected", segmentIds: [SEG_A], confidenceValue: 0.9, status: "REJECTED" }),
        makeSignal({
          id: "sig-expired",
          segmentIds: [SEG_A],
          confidenceValue: 0.9,
          windowStart: "2025-06-01T00:00:00.000Z",
          windowEnd: "2025-06-01T02:00:00.000Z",
        }),
        makeSignal({ id: "sig-live", segmentIds: [SEG_B], confidenceValue: 0.4 }),
      ],
      nowIso: NOW_ISO,
    });

    expect(diagnostics.overlay.segments.map((s) => s.segmentId)).toEqual([SEG_B]);
    expect(diagnostics.ignoredSignalIds).toEqual(["sig-cleared", "sig-expired", "sig-rejected"]);
    expect(diagnostics.contributingSignalIds).toEqual(["sig-live"]);
  });

  it("sorts segments by id so the overlay is stable", () => {
    const overlay = buildRiskOverlay({
      signals: [
        makeSignal({ id: "sig-b", segmentIds: [SEG_B], confidenceValue: 0.4 }),
        makeSignal({ id: "sig-a", segmentIds: [SEG_A], confidenceValue: 0.4 }),
      ],
      nowIso: NOW_ISO,
    });
    expect(overlay.segments.map((s) => s.segmentId)).toEqual([SEG_B, SEG_A].sort());
  });

  it("is deterministic for the same injected now", () => {
    const args = {
      signals: [makeSignal({ id: "sig-1", segmentIds: [SEG_A], confidenceValue: 0.62 })],
      nowIso: NOW_ISO,
    };
    expect(buildRiskOverlay(args)).toEqual(buildRiskOverlay(args));
    expect(JSON.stringify(buildRiskOverlay(args))).toBe(JSON.stringify(buildRiskOverlay(args)));
  });

  it("produces an empty overlay when there are no signals", () => {
    const overlay = emptyRiskOverlay(NOW_ISO);
    expect(overlay.segments).toEqual([]);
    expect(overlay.source).toBe("live");
    expect(createSegmentRiskLookup(overlay)(SEG_A)).toBeUndefined();
  });

  it("counts whole minutes and clamps negatives", () => {
    expect(minutesBetween("2025-06-02T00:00:00.000Z", "2025-06-02T01:00:00.000Z")).toBe(60);
    expect(minutesBetween("2025-06-02T01:00:00.000Z", "2025-06-02T00:00:00.000Z")).toBe(0);
    expect(minutesBetween("nonsense", NOW_ISO)).toBe(0);
  });
});

describe("consuming the overlay", () => {
  const overlay = buildRiskOverlay({
    signals: [
      makeSignal({
        id: "sig-1",
        segmentIds: [SEG_A],
        confidenceValue: 0.55,
        severity: "MAJOR",
        issueType: "TRACK_FAULT",
      }),
    ],
    nowIso: NOW_ISO,
  });

  it("returns undefined for a healthy segment", () => {
    const lookup = createSegmentRiskLookup(overlay);
    expect(lookup(SEG_A)).toBeDefined();
    expect(lookup(SEG_B)).toBeUndefined();
    expect(lookup("does-not-exist")).toBeUndefined();
  });

  it("binds a RiskPenaltyFn to the overlay", () => {
    const penaltyFn = createOverlayRiskPenaltyFn(overlay, {
      segmentSeconds: new Map([[SEG_A, 120]]),
    });

    const risky = penaltyFn({
      segmentId: SEG_A,
      severity: "INFO",
      issueType: "UNKNOWN",
      confidence: 0,
      atTime: 12 * 3600,
      isOngoing: true,
    });
    expect(risky.severity).toBe("MAJOR");
    expect(risky.multiplier).toBeGreaterThan(1);
    expect(risky.reason).toContain(SEG_A);

    const healthy = penaltyFn({
      segmentId: SEG_B,
      severity: "SEVERE",
      issueType: "TRACK_FAULT",
      confidence: 1,
      atTime: 12 * 3600,
      isOngoing: true,
    });
    // The overlay is authoritative: a healthy segment is not priced.
    expect(healthy.penaltySeconds).toBe(0);
    expect(healthy.multiplier).toBe(1);
  });
});
