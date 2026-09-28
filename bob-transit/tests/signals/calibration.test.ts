import { describe, expect, it } from "vitest";

import { confidenceBand } from "@/lib/contracts";
import {
  CALIBRATION_VERSION,
  JUNK_QUALITY_THRESHOLD,
  OFFICIAL_DENIAL_MULTIPLIER,
  OFFLINE_CACHE_MULTIPLIER,
  REALTIME_CHANNEL_CAP,
  REPORTABLE_CONFIDENCE,
  SOCIAL_AUTHOR_TABLE,
  UNRESOLVED_CAP,
  calibrateConfidence,
  calibrationChannels,
  isReportable,
  recencyMultiplier,
  socialChannelStrength,
} from "@/lib/signals/calibration";

const base = {
  socialDistinctAuthors: 0,
  officialStatementCount: 0,
  realtimeObservationCount: 0,
};

function value(input: Parameters<typeof calibrateConfidence>[0]): number {
  return calibrateConfidence(input).value;
}

describe("the documented calibration table", () => {
  it("matches the published distinct-author table exactly", () => {
    for (const row of SOCIAL_AUTHOR_TABLE) {
      expect(socialChannelStrength(row.authors)).toBeCloseTo(row.strength, 10);
    }
    // Saturates beyond the table.
    expect(socialChannelStrength(50)).toBe(0.6);
    expect(socialChannelStrength(-3)).toBe(0);
  });

  it("holds the reference points from CALIBRATION.md", () => {
    expect(value({ ...base, socialDistinctAuthors: 1 })).toBeCloseTo(0.22, 6);
    expect(value({ ...base, socialDistinctAuthors: 2 })).toBeCloseTo(0.32, 6);
    expect(value({ ...base, socialDistinctAuthors: 3 })).toBeCloseTo(0.45, 6);
    expect(value({ ...base, socialDistinctAuthors: 4 })).toBeCloseTo(0.53, 6);
    expect(value({ ...base, socialDistinctAuthors: 5 })).toBeCloseTo(0.58, 6);
    expect(value({ ...base, socialDistinctAuthors: 6 })).toBeCloseTo(0.6, 6);
    expect(value({ ...base, officialStatementCount: 1 })).toBeCloseTo(0.9, 6);
    expect(
      value({ ...base, socialDistinctAuthors: 3, officialStatementCount: 1 }),
    ).toBeCloseTo(0.945, 6);
    expect(value({ ...base, realtimeObservationCount: 2 })).toBeCloseTo(0.1, 6);
    expect(value({ ...base, realtimeObservationCount: 3 })).toBeCloseTo(REALTIME_CHANNEL_CAP, 6);
  });

  it("orders the bands as the brief requires", () => {
    expect(confidenceBand(value({ ...base, socialDistinctAuthors: 1 }))).toBe("LOW");
    expect(confidenceBand(value({ ...base, socialDistinctAuthors: 3 }))).toBe("MODERATE");
    expect(confidenceBand(value({ ...base, socialDistinctAuthors: 9 }))).toBe("MODERATE");
    expect(confidenceBand(value({ ...base, officialStatementCount: 1 }))).toBe("VERY_HIGH");
    expect(confidenceBand(value({ ...base, realtimeObservationCount: 9 }))).toBe("VERY_LOW");
  });

  it("reports the calibration version so scores stay comparable", () => {
    expect(calibrateConfidence(base).calibrationVersion).toBe(CALIBRATION_VERSION);
  });
});

describe("monotonicity", () => {
  it("never decreases as distinct authors increase", () => {
    let previous = -1;
    for (let n = 0; n <= 40; n += 1) {
      const v = value({ ...base, socialDistinctAuthors: n });
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it("never decreases as distinct authors increase, at every evidence combination", () => {
    for (const official of [0, 1, 2]) {
      for (const realtime of [0, 1, 4]) {
        for (const quality of [0.05, 0.5, 1]) {
          for (const unresolved of [false, true]) {
            let previous = -1;
            for (let n = 0; n <= 12; n += 1) {
              const v = value({
                socialDistinctAuthors: n,
                officialStatementCount: official,
                realtimeObservationCount: realtime,
                socialQuality: quality,
                unresolved,
              });
              expect(v).toBeGreaterThanOrEqual(previous - 1e-12);
              previous = v;
            }
          }
        }
      }
    }
  });

  it("raises confidence sharply when an official statement arrives", () => {
    const socialOnly = value({ ...base, socialDistinctAuthors: 1 });
    const withOfficial = value({ ...base, socialDistinctAuthors: 1, officialStatementCount: 1 });
    expect(withOfficial).toBeGreaterThan(socialOnly * 4);
    expect(withOfficial - socialOnly).toBeGreaterThan(0.7);
  });

  it("keeps social evidence alone out of the HIGH band no matter how many authors", () => {
    for (let n = 1; n <= 500; n += 1) {
      expect(value({ ...base, socialDistinctAuthors: n })).toBeLessThan(0.65);
    }
  });

  it("keeps realtime observations alone inside the VERY_LOW band", () => {
    for (let n = 1; n <= 500; n += 1) {
      expect(value({ ...base, realtimeObservationCount: n })).toBeLessThanOrEqual(
        REALTIME_CHANNEL_CAP,
      );
    }
  });

  it("gives zero evidence a zero score", () => {
    expect(value(base)).toBe(0);
  });
});

describe("penalties and multipliers", () => {
  it("caps an unresolved claim below the HIGH band", () => {
    const resolved = value({ ...base, socialDistinctAuthors: 6 });
    const unresolved = value({ ...base, socialDistinctAuthors: 6, unresolved: true });
    expect(unresolved).toBeLessThan(resolved);
    expect(unresolved).toBeLessThanOrEqual(UNRESOLVED_CAP);
    for (let n = 0; n <= 50; n += 1) {
      expect(value({ ...base, socialDistinctAuthors: n, unresolved: true })).toBeLessThanOrEqual(
        UNRESOLVED_CAP,
      );
    }
  });

  it("heavily discounts social evidence when an official source reports normal service", () => {
    const plain = value({ ...base, socialDistinctAuthors: 3 });
    const denied = value({ ...base, socialDistinctAuthors: 3, officialDenial: true });
    expect(denied).toBeCloseTo(plain * OFFICIAL_DENIAL_MULTIPLIER, 6);
    expect(isReportable(calibrateConfidence({ ...base, socialDistinctAuthors: 3, officialDenial: true }))).toBe(false);
  });

  it("degrades a cached score and flags it", () => {
    const live = calibrateConfidence({ ...base, officialStatementCount: 1 });
    const cached = calibrateConfidence({
      ...base,
      officialStatementCount: 1,
      degradedByOfflineCache: true,
    });
    expect(cached.value).toBeCloseTo(live.value * OFFLINE_CACHE_MULTIPLIER, 6);
    expect(cached.degradedByOfflineCache).toBe(true);
    expect(live.degradedByOfflineCache).toBe(false);
  });

  it("decays stale evidence but never to zero", () => {
    expect(recencyMultiplier(null, 90)).toBe(1);
    expect(recencyMultiplier(90, 90)).toBe(1);
    expect(recencyMultiplier(180, 90)).toBeLessThan(1);
    expect(recencyMultiplier(100000, 90)).toBeGreaterThan(0);
    const stale = value({ ...base, socialDistinctAuthors: 3, newestSocialAgeMinutes: 600 });
    expect(stale).toBeLessThan(value({ ...base, socialDistinctAuthors: 3 }));
    expect(stale).toBeGreaterThan(0);
  });

  it("scores a junk-quality post far below a genuine one", () => {
    const genuine = value({ ...base, socialDistinctAuthors: 1, socialQuality: 1 });
    const joke = value({ ...base, socialDistinctAuthors: 1, socialQuality: 0.08 });
    expect(joke).toBeLessThan(JUNK_QUALITY_THRESHOLD * genuine);
    expect(isReportable(calibrateConfidence({ ...base, socialDistinctAuthors: 1, socialQuality: 0.08 }))).toBe(false);
  });

  it("treats a missing official statement as no official channel at all", () => {
    const channels = calibrationChannels({ ...base, officialStatementCount: 0 });
    expect(channels.official).toBe(0);
  });
});

describe("factor attribution", () => {
  it("names every factor and gives a signed, meaningful contribution", () => {
    const score = calibrateConfidence({
      socialDistinctAuthors: 3,
      officialStatementCount: 1,
      realtimeObservationCount: 2,
      unresolved: true,
      officialDenial: false,
      degradedByOfflineCache: true,
      socialQuality: 0.8,
    });
    const names = score.factors.map((f) => f.name);
    expect(names).toContain("social_distinct_authors");
    expect(names).toContain("official_statement");
    expect(names).toContain("location_resolution");
    expect(names).toContain("offline_cache");

    const byName = new Map(score.factors.map((f) => [f.name, f]));
    // Positive factors genuinely raise the score; penalties genuinely lower it.
    expect(byName.get("social_distinct_authors")!.contribution).toBeGreaterThan(0);
    expect(byName.get("official_statement")!.contribution).toBeGreaterThan(0);
    expect(byName.get("location_resolution")!.contribution).toBeLessThan(0);
    expect(byName.get("offline_cache")!.contribution).toBeLessThan(0);
    // Neutral factors contribute nothing.
    expect(byName.get("official_denial")!.contribution).toBe(0);
    for (const factor of score.factors) expect(factor.note.length).toBeGreaterThan(0);
  });

  it("attributes a sarcasm penalty to the social-quality factor", () => {
    const score = calibrateConfidence({
      ...base,
      socialDistinctAuthors: 3,
      socialQuality: 0.1,
    });
    const quality = score.factors.find((f) => f.name === "social_quality")!;
    expect(quality.contribution).toBeLessThan(0);
    expect(quality.weight).toBeCloseTo(0.1, 6);
  });
});

describe("reportable threshold", () => {
  it("is the documented 0.30", () => {
    expect(REPORTABLE_CONFIDENCE).toBe(0.3);
  });

  it("reports three authors and refuses one", () => {
    expect(isReportable(calibrateConfidence({ ...base, socialDistinctAuthors: 3 }))).toBe(true);
    expect(isReportable(calibrateConfidence({ ...base, socialDistinctAuthors: 1 }))).toBe(false);
    expect(isReportable(calibrateConfidence(base))).toBe(false);
  });
});
