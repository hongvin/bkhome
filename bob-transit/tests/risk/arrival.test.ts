/**
 * Arrival distribution / P90 tests.
 *
 * Per the orchestrator ruling there is ONE canonical arrival model
 * (`lib/routing/reliability.ts`), and `lib/risk/arrival.ts` delegates to it. These
 * tests therefore assert the product properties of that single model — they do
 * not assert a private rival implementation.
 */

import { describe, expect, it } from "vitest";
import {
  ARRIVAL_MODEL_DESCRIPTION,
  BASE_JITTER_SECONDS,
  PER_SEGMENT_JITTER_SECONDS,
  computeArrivalWindow,
  impliedExpectedDelaySeconds,
  meanToP90GapSeconds,
} from "@/lib/risk/arrival";
import { createRiskPenaltyFn } from "@/lib/risk/penalty";
import type { Severity } from "@/lib/contracts";

const SCHEDULED_ARRIVAL = 8 * 3600 + 1200;

function window(expectedDelaySeconds: number, segmentCount = 9) {
  return computeArrivalWindow({
    scheduledArrivalSeconds: SCHEDULED_ARRIVAL,
    expectedDelaySeconds,
    segmentCount,
  });
}

describe("computeArrivalWindow (canonical model, via the risk barrel)", () => {
  it("orders p10 <= p50 <= p90 and keeps the mean equal to the median", () => {
    for (const mu of [0, 30, 120, 600, 1800]) {
      for (const segmentCount of [1, 5, 9, 20]) {
        const w = window(mu, segmentCount);
        expect(w.p10Seconds).toBeLessThanOrEqual(w.p50Seconds);
        expect(w.p50Seconds).toBeLessThanOrEqual(w.p90Seconds);
        expect(w.meanSeconds).toBe(w.p50Seconds);
      }
    }
  });

  it("stores meanToP90GapSeconds explicitly as p90 - mean", () => {
    for (const mu of [0, 45, 300]) {
      const w = window(mu);
      expect(w.meanToP90GapSeconds).toBeCloseTo(w.p90Seconds - w.meanSeconds, 10);
      expect(meanToP90GapSeconds(w)).toBe(w.meanToP90GapSeconds);
    }
  });

  it("never collapses to a zero-width window on a healthy network", () => {
    // The residual schedule-jitter floor: dwell overruns, crowding and signalling
    // margin exist whether or not a signal has been filed. If this were zero, the
    // headline "plan for this much slack" number would vanish on a good day.
    const healthy = window(0, 9);
    expect(healthy.meanToP90GapSeconds).toBeGreaterThan(0);
    expect(healthy.meanToP90GapSeconds).toBeCloseTo(
      1.2816 * (BASE_JITTER_SECONDS + PER_SEGMENT_JITTER_SECONDS * Math.sqrt(9)),
      6,
    );
    expect(healthy.meanSeconds).toBe(SCHEDULED_ARRIVAL);
    expect(healthy.p90Seconds).toBeGreaterThan(healthy.meanSeconds);
  });

  it("WIDENS the P90 gap as risk rises", () => {
    const gaps: number[] = [];
    for (let mu = 0; mu <= 3000; mu += 150) gaps.push(window(mu).meanToP90GapSeconds);

    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    }
    // Concrete: a healthy 9-segment trip vs the same trip with 10 minutes of
    // expected delay.
    expect(window(600).meanToP90GapSeconds).toBeGreaterThan(window(0).meanToP90GapSeconds * 3);
  });

  it("widens the gap with more segments at the same expected delay", () => {
    const few = window(300, 2).meanToP90GapSeconds;
    const many = window(300, 20).meanToP90GapSeconds;
    expect(many).toBeGreaterThan(few);
  });

  it("never lets p10 fall below the scheduled arrival", () => {
    for (const mu of [0, 60, 300, 1200]) {
      expect(window(mu).p10Seconds).toBeGreaterThanOrEqual(SCHEDULED_ARRIVAL);
    }
  });

  it("is deterministic", () => {
    expect(window(240, 7)).toEqual(window(240, 7));
    expect(JSON.stringify(window(240, 7))).toBe(JSON.stringify(window(240, 7)));
  });

  it("states its distribution", () => {
    expect(ARRIVAL_MODEL_DESCRIPTION).toContain("Normal");
    expect(ARRIVAL_MODEL_DESCRIPTION).toContain("clipped at zero");
    expect(ARRIVAL_MODEL_DESCRIPTION).toContain("meanToP90GapSeconds");
  });

  it("reports the expected delay the window actually used", () => {
    for (const mu of [0, 90, 900]) {
      const w = window(mu);
      expect(impliedExpectedDelaySeconds(w, SCHEDULED_ARRIVAL)).toBeCloseTo(mu, 6);
    }
  });
});

describe("risk -> arrival integration", () => {
  it("feeds the penalty function's output straight in as mu, so the models agree", () => {
    // The mixture insight preserved as a consistency check rather than as a rival
    // implementation: the mean delay a disruption contributes to the canonical
    // window is exactly the run-time excess the penalty function charges.
    const penaltyFn = createRiskPenaltyFn({ segmentSeconds: new Map([["KJ:A->B", 120]]) });
    const cases: Array<{ severity: Severity; confidence: number }> = [
      { severity: "MINOR", confidence: 0.4 },
      { severity: "MAJOR", confidence: 0.7 },
      { severity: "SEVERE", confidence: 1 },
    ];

    for (const c of cases) {
      const penalty = penaltyFn({
        segmentId: "KJ:A->B",
        severity: c.severity,
        issueType: "TRACK_FAULT",
        confidence: c.confidence,
        atTime: 12 * 3600,
        isOngoing: true,
      });
      const w = window(penalty.penaltySeconds, 9);
      expect(impliedExpectedDelaySeconds(w, SCHEDULED_ARRIVAL)).toBe(penalty.penaltySeconds);
      expect(w.meanToP90GapSeconds).toBeGreaterThan(0);
    }
  });

  it("produces a strictly larger gap for a SEVERE disruption than a MINOR one", () => {
    const fn = createRiskPenaltyFn();
    const penaltyFor = (severity: Severity) =>
      fn({
        segmentId: "KJ:A->B",
        severity,
        issueType: "TRACK_FAULT",
        confidence: 0.9,
        atTime: 12 * 3600,
        isOngoing: true,
      }).penaltySeconds;

    const minor = window(penaltyFor("MINOR")).meanToP90GapSeconds;
    const major = window(penaltyFor("MAJOR")).meanToP90GapSeconds;
    const severe = window(penaltyFor("SEVERE")).meanToP90GapSeconds;
    expect(major).toBeGreaterThan(minor);
    expect(severe).toBeGreaterThan(major);
  });
});
