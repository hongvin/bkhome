import { describe, expect, it } from "vitest";
import type { IssueType, RiskPenaltyInput, Severity } from "@/lib/contracts";
import { ISSUE_TYPES, SEVERITIES } from "@/lib/contracts";
import {
  NOMINAL_SEGMENT_RUN_SECONDS,
  confidenceWeight,
  createRiskPenaltyFn,
  effectiveConfidence,
  excessMultiplier,
  isAvoidConfidence,
  isMaterialRisk,
  riskPenalty,
} from "@/lib/risk/penalty";

const SEGMENT = "KJ:KJ13->KJ14";
/** 12:00 — off-peak, so the demand modifier is neutral unless a test wants it. */
const OFF_PEAK = 12 * 3600;
/** 08:00 — inside the AM peak window. */
const PEAK = 8 * 3600;

function input(overrides: Partial<RiskPenaltyInput> = {}): RiskPenaltyInput {
  return {
    segmentId: SEGMENT,
    severity: "MAJOR",
    confidence: 0.5,
    issueType: "TRACK_FAULT",
    atTime: OFF_PEAK,
    isOngoing: true,
    ...overrides,
  };
}

describe("riskPenalty — contract requirements", () => {
  it("returns penaltySeconds 0 and multiplier 1 for a healthy segment", () => {
    const info = riskPenalty(input({ severity: "INFO", confidence: 1 }));
    expect(info.penaltySeconds).toBe(0);
    expect(info.multiplier).toBe(1);

    const zeroConfidence = riskPenalty(input({ severity: "SEVERE", confidence: 0 }));
    expect(zeroConfidence.penaltySeconds).toBe(0);
    expect(zeroConfidence.multiplier).toBe(1);

    expect(info.reason).toContain("no run-time cost added");
    expect(zeroConfidence.reason).toContain("no run-time cost added");
  });

  it("keeps multiplier >= 1 and penaltySeconds >= 0 across the whole input grid", () => {
    for (const severity of SEVERITIES) {
      for (const issueType of ISSUE_TYPES) {
        for (let i = 0; i <= 20; i += 1) {
          for (const isOngoing of [true, false]) {
            for (const atTime of [OFF_PEAK, PEAK, 3 * 3600]) {
              const penalty = riskPenalty(
                input({ severity, issueType, confidence: i / 20, isOngoing, atTime }),
              );
              expect(penalty.multiplier).toBeGreaterThanOrEqual(1);
              expect(penalty.penaltySeconds).toBeGreaterThanOrEqual(0);
              expect(Number.isFinite(penalty.penaltySeconds)).toBe(true);
              expect(penalty.reason.length).toBeGreaterThan(20);
            }
          }
        }
      }
    }
  });

  it("is monotonic non-decreasing in confidence for every severity and issue type", () => {
    for (const severity of SEVERITIES) {
      for (const issueType of ISSUE_TYPES) {
        let previous = -Infinity;
        for (let i = 0; i <= 100; i += 1) {
          const multiplier = riskPenalty(
            input({ severity, issueType, confidence: i / 100 }),
          ).multiplier;
          expect(multiplier).toBeGreaterThanOrEqual(previous);
          previous = multiplier;
        }
      }
    }
  });

  it("is strictly increasing in confidence where the severity actually costs something", () => {
    for (const severity of ["MINOR", "MAJOR", "SEVERE"] as const) {
      const low = riskPenalty(input({ severity, confidence: 0.2 })).multiplier;
      const mid = riskPenalty(input({ severity, confidence: 0.5 })).multiplier;
      const high = riskPenalty(input({ severity, confidence: 0.95 })).multiplier;
      expect(mid).toBeGreaterThan(low);
      expect(high).toBeGreaterThan(mid);
    }
  });

  it("is monotonic non-decreasing in severity for every confidence", () => {
    for (let i = 0; i <= 10; i += 1) {
      const confidence = i / 10;
      const multipliers = SEVERITIES.map(
        (severity) => riskPenalty(input({ severity, confidence })).multiplier,
      );
      for (let k = 1; k < multipliers.length; k += 1) {
        expect(multipliers[k]).toBeGreaterThanOrEqual(multipliers[k - 1]);
      }
    }
  });

  it("scales with severity x confidence x issueTypeWeight instead of a flat penalty", () => {
    const base = riskPenalty(input({ severity: "MAJOR", issueType: "TRACK_FAULT", confidence: 1 }));
    const mild = riskPenalty(input({ severity: "MINOR", issueType: "TRACK_FAULT", confidence: 1 }));
    const severe = riskPenalty(input({ severity: "SEVERE", issueType: "TRACK_FAULT", confidence: 1 }));

    // Excess over 1 is proportional to (SEVERITY_BASE_MULTIPLIER - 1).
    expect(base.multiplier - 1).toBeCloseTo(0.6 * 1.35, 10);
    expect(mild.multiplier - 1).toBeCloseTo(0.15 * 1.35, 10);
    expect(severe.multiplier - 1).toBeCloseTo(1.75 * 1.35, 10);

    // Excess is proportional to ISSUE_TYPE_SEVERITY_WEIGHT.
    const elevator = riskPenalty(
      input({ severity: "MAJOR", issueType: "ELEVATOR_FAULT", confidence: 1 }),
    );
    expect((base.multiplier - 1) / (elevator.multiplier - 1)).toBeCloseTo(1 / 0.35, 10);

    // Not flat: the same severity costs different amounts at different confidences.
    expect(riskPenalty(input({ confidence: 0.4 })).penaltySeconds).not.toBe(
      riskPenalty(input({ confidence: 0.9 })).penaltySeconds,
    );

    // Confidence can dominate severity: a barely-reported SEVERE fault is cheaper
    // than a fully-confirmed MINOR one. That is the proportionality working.
    const severeRumour = riskPenalty(input({ severity: "SEVERE", confidence: 0.05 }));
    const confirmedMinor = riskPenalty(input({ severity: "MINOR", confidence: 1 }));
    expect(severeRumour.multiplier).toBeLessThan(confirmedMinor.multiplier);
  });

  it("is pure and deterministic", () => {
    for (const severity of SEVERITIES) {
      const args = input({ severity, confidence: 0.63, issueType: "SIGNAL_FAULT" });
      const first = riskPenalty(args);
      const second = riskPenalty(args);
      expect(first).toEqual(second);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
  });

  it("surfaces the frozen 0.4 and 0.7 thresholds in the reason", () => {
    const avoid = riskPenalty(input({ confidence: 0.8 })).reason;
    expect(avoid).toContain("avoid threshold");
    expect(avoid).toContain("70%");

    const material = riskPenalty(input({ confidence: 0.5 })).reason;
    expect(material).toContain("material-risk threshold");
    expect(material).toContain("40%");
    expect(material).not.toContain("avoid threshold");

    const quiet = riskPenalty(input({ confidence: 0.2 })).reason;
    expect(quiet).not.toContain("threshold");

    expect(isMaterialRisk(0.4)).toBe(false);
    expect(isMaterialRisk(0.4001)).toBe(true);
    expect(isAvoidConfidence(0.6999)).toBe(false);
    expect(isAvoidConfidence(0.7)).toBe(true);
  });

  it("names the segment, the issue and the numbers in the reason", () => {
    const penalty = riskPenalty(input({ confidence: 0.78, severity: "SEVERE", issueType: "TRACK_FAULT" }));
    expect(penalty.reason).toContain(SEGMENT);
    expect(penalty.reason).toContain("SEVERE");
    expect(penalty.reason).toContain("TRACK_FAULT");
    expect(penalty.reason).toContain("78%");
    expect(penalty.reason).toContain(`+${penalty.penaltySeconds} s`);
  });
});

describe("riskPenalty — modifiers", () => {
  it("damps a signal whose persistence is unconfirmed", () => {
    const ongoing = riskPenalty(input({ isOngoing: true }));
    const notOngoing = riskPenalty(input({ isOngoing: false }));
    expect(notOngoing.multiplier).toBeLessThan(ongoing.multiplier);
    expect(notOngoing.reason).toContain("persistence unconfirmed");
    expect(ongoing.reason).toContain("ongoing");
  });

  it("amplifies demand-sensitive issue types during the peak but not capacity faults", () => {
    const crowdingOff = riskPenalty(input({ issueType: "CROWDING", confidence: 0.5, atTime: OFF_PEAK }));
    const crowdingPeak = riskPenalty(input({ issueType: "CROWDING", confidence: 0.5, atTime: PEAK }));
    expect(crowdingPeak.multiplier).toBeGreaterThan(crowdingOff.multiplier);

    const trackOff = riskPenalty(input({ issueType: "TRACK_FAULT", confidence: 0.5, atTime: OFF_PEAK }));
    const trackPeak = riskPenalty(input({ issueType: "TRACK_FAULT", confidence: 0.5, atTime: PEAK }));
    expect(trackPeak.multiplier).toBe(trackOff.multiplier);
  });

  it("exposes a convex confidence curve kinked at the frozen thresholds", () => {
    expect(confidenceWeight(0)).toBe(0);
    expect(confidenceWeight(0.4)).toBeCloseTo(0.4, 10);
    expect(confidenceWeight(0.7)).toBeCloseTo(0.8, 10);
    expect(confidenceWeight(1)).toBeCloseTo(1.35, 10);

    // Convex: the marginal cost of confidence rises.
    const firstSlope = confidenceWeight(0.5) - confidenceWeight(0.4);
    const lastSlope = confidenceWeight(1) - confidenceWeight(0.9);
    expect(lastSlope).toBeGreaterThan(firstSlope);

    // Clamped outside [0,1] and never NaN.
    expect(confidenceWeight(-1)).toBe(0);
    expect(confidenceWeight(2)).toBeCloseTo(1.35, 10);
    expect(confidenceWeight(Number.NaN)).toBe(0);
  });

  it("clamps effectiveConfidence into [0,1] under peak amplification", () => {
    const effective = effectiveConfidence({
      confidence: 0.95,
      issueType: "CROWDING",
      atTime: PEAK,
      isOngoing: true,
    });
    expect(effective).toBe(1);
    expect(excessMultiplier({ severity: "MAJOR", issueType: "CROWDING", confidence: 0.95, atTime: PEAK, isOngoing: true })).toBeCloseTo(
      0.6 * 0.55 * 1.35,
      10,
    );
  });
});

describe("createRiskPenaltyFn", () => {
  it("prices against the caller-supplied segment run time", () => {
    const fn = createRiskPenaltyFn({ segmentSeconds: new Map([[SEGMENT, 300]]) });
    const penalty = fn(input({ severity: "MAJOR", issueType: "TRACK_FAULT", confidence: 1 }));
    expect(penalty.multiplier).toBeCloseTo(1.81, 10);
    expect(penalty.penaltySeconds).toBe(Math.round(0.81 * 300));
  });

  it("falls back to the measured GTFS median run time", () => {
    expect(NOMINAL_SEGMENT_RUN_SECONDS).toBe(120);
    const penalty = riskPenalty(input({ severity: "MAJOR", issueType: "TRACK_FAULT", confidence: 1 }));
    expect(penalty.penaltySeconds).toBe(Math.round(0.81 * 120));
  });

  it("accepts a plain record as well as a Map, and ignores bad values", () => {
    const fn = createRiskPenaltyFn({ segmentSeconds: { [SEGMENT]: 0 } });
    expect(fn(input({ severity: "MAJOR", issueType: "TRACK_FAULT", confidence: 1 })).penaltySeconds).toBe(
      Math.round(0.81 * NOMINAL_SEGMENT_RUN_SECONDS),
    );
  });
});
