/**
 * Purity and determinism guard.
 *
 * The brief is explicit: no wall-clock and no I/O inside pure risk logic. A test
 * that only calls a function twice can pass while the function still reads
 * `Date.now()` on a path the test did not hit, so this file also inspects the
 * source text of every pure module for the forbidden constructs.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRiskPenaltyFn, riskPenalty } from "@/lib/risk/penalty";
import { computeArrivalWindow } from "@/lib/risk/arrival";
import { buildRiskOverlay } from "@/lib/risk/overlay";
import { rankItineraries } from "@/lib/risk/rank";
import { degradedHeadwaySeconds } from "@/lib/risk/headway";
import { estimateTransferSeconds } from "@/lib/risk/interchange";
import { estimateGroundTransportFallback } from "@/lib/risk/ground";
import { runImpactAgent } from "@/lib/agents/impact";
import { NOW_ISO, makeItinerary, makeSegmentId, makeSegmentRisk, makeLookup, makeSignal } from "./fixtures";

const PURE_MODULES = [
  "lib/risk/penalty.ts",
  "lib/risk/arrival.ts",
  "lib/risk/headway.ts",
  "lib/risk/interchange.ts",
  "lib/risk/overlay.ts",
  "lib/risk/rank.ts",
  "lib/risk/ground.ts",
  "lib/agents/impact/index.ts",
];

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bDate\.now\s*\(/, why: "wall-clock read" },
  { pattern: /\bperformance\.now\s*\(/, why: "wall-clock read" },
  { pattern: /\bMath\.random\s*\(/, why: "non-deterministic randomness" },
  { pattern: /\bfetch\s*\(/, why: "network I/O" },
  { pattern: /\bprocess\.env\b/, why: "ambient configuration" },
  { pattern: /from\s+["']node:fs["']/, why: "filesystem I/O" },
  { pattern: /from\s+["']node:child_process["']/, why: "process I/O" },
  { pattern: /require\s*\(/, why: "dynamic require" },
];

/**
 * Strip comments so that prose *about* a forbidden construct (for example the
 * doc comment that says "nothing here calls Date.now()") is not mistaken for the
 * construct itself. Keeps `https://` intact by only treating `//` as a comment
 * when it is not preceded by a colon.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("pure risk logic contains no wall-clock or I/O", () => {
  for (const modulePath of PURE_MODULES) {
    it(`${modulePath} is free of forbidden constructs`, () => {
      const source = stripComments(readFileSync(resolve(process.cwd(), modulePath), "utf8"));
      for (const { pattern, why } of FORBIDDEN) {
        expect(pattern.test(source), `${modulePath} contains ${why} (${pattern})`).toBe(false);
      }
    });
  }
});

describe("every pure entry point is deterministic", () => {
  const SEGMENT = makeSegmentId("KJ", "KJ13", "KJ14");
  const riskLookup = makeLookup([
    makeSegmentRisk({
      segmentId: SEGMENT,
      degradationProbability: 0.55,
      confidence: 0.62,
      severity: "MAJOR",
      issueType: "SIGNAL_FAULT",
    }),
  ]);
  const itinerary = makeItinerary({
    id: "det",
    departureTime: 8 * 3600,
    rideLegs: [
      { lineId: "KJ", segmentIds: [SEGMENT, makeSegmentId("KJ", "KJ14", "KJ15")], scheduledSeconds: 240 },
    ],
    riskLookup,
  });
  const signals = [makeSignal({ id: "sig-det", segmentIds: [SEGMENT], confidenceValue: 0.62 })];

  it("riskPenalty / createRiskPenaltyFn", () => {
    const input = {
      segmentId: SEGMENT,
      severity: "MAJOR" as const,
      confidence: 0.62,
      issueType: "SIGNAL_FAULT" as const,
      atTime: 8 * 3600,
      isOngoing: true,
    };
    expect(riskPenalty(input)).toEqual(riskPenalty(input));
    expect(createRiskPenaltyFn()(input)).toEqual(createRiskPenaltyFn()(input));
  });

  it("computeArrivalWindow", () => {
    const input = { scheduledArrivalSeconds: 30_000, expectedDelaySeconds: 420, segmentCount: 9 };
    expect(computeArrivalWindow(input)).toEqual(computeArrivalWindow(input));
  });

  it("buildRiskOverlay", () => {
    const args = { signals, nowIso: NOW_ISO };
    expect(buildRiskOverlay(args)).toEqual(buildRiskOverlay(args));
  });

  it("rankItineraries", () => {
    const args = { itineraries: [itinerary], riskLookup, signals, nowIso: NOW_ISO };
    expect(rankItineraries(args).itineraries).toEqual(rankItineraries(args).itineraries);
    expect(rankItineraries(args).whyThisCouldBeWrong).toBe(rankItineraries(args).whyThisCouldBeWrong);
  });

  it("runImpactAgent", () => {
    const args = {
      originStationId: "KJ13",
      destinationStationId: "KJ15",
      itineraries: [itinerary],
      riskLookup,
      signals,
      nowIso: NOW_ISO,
    };
    expect(runImpactAgent(args)).toEqual(runImpactAgent(args));
    expect(JSON.stringify(runImpactAgent(args))).toBe(JSON.stringify(runImpactAgent(args)));
  });

  it("degradedHeadwaySeconds, estimateTransferSeconds and the ground fallback", () => {
    const degradation = {
      severity: "MAJOR" as const,
      issueType: "TRACK_FAULT" as const,
      confidence: 0.6,
      atTime: 8 * 3600,
      isOngoing: true,
    };
    expect(degradedHeadwaySeconds(240, degradation)).toBe(degradedHeadwaySeconds(240, degradation));

    const transferInput = { fromStationId: "AG7", toStationId: "KJ13", atTime: 8 * 3600 };
    expect(estimateTransferSeconds(transferInput)).toEqual(estimateTransferSeconds(transferInput));

    const groundInput = {
      originStationId: "KJ13",
      destinationStationId: "KJ15",
      railScheduledSeconds: 900,
      atTime: 8 * 3600,
    };
    expect(estimateGroundTransportFallback(groundInput)).toEqual(
      estimateGroundTransportFallback(groundInput),
    );
  });
});
