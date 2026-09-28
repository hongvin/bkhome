import { describe, expect, it } from "vitest";
import {
  StalenessFormatter,
  computeStaleness,
  formatClockTime,
  formatStaleness,
  stalenessFormatter,
  stalenessFormatterMs,
  stalenessMinutes,
} from "@/lib/offline/staleness";

const BASE = "2025-01-02T00:42:00.000Z"; // 08:42 in Asia/Kuala_Lumpur (+08:00)

function at(offsetSeconds: number): Date {
  return new Date(Date.parse(BASE) + offsetSeconds * 1000);
}

describe("staleness formatting", () => {
  it("renders exactly 'as of HH:MM, N min ago'", () => {
    expect(stalenessFormatter.format(BASE, at(12 * 60))).toBe("as of 08:42, 12 min ago");
  });

  it("renders the Bahasa Malaysia variant", () => {
    expect(stalenessFormatterMs.format(BASE, at(12 * 60))).toBe("setakat 08:42, 12 minit lalu");
    expect(formatStaleness(BASE, at(3 * 60), { locale: "ms" })).toBe("setakat 08:42, 3 minit lalu");
  });

  it("renders HH:MM in the transit timezone regardless of host timezone", () => {
    expect(formatClockTime(BASE)).toBe("08:42");
    // 16:30 UTC is 00:30 the next day in Kuala Lumpur.
    expect(formatClockTime("2025-01-01T16:30:00.000Z")).toBe("00:30");
    expect(formatClockTime("2025-01-01T16:30:00.000Z", 0)).toBe("16:30");
  });

  it("floors the minute count at the N-minute boundaries", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [59, 0],
      [60, 1],
      [61, 1],
      [119, 1],
      [120, 2],
      [59 * 60 + 59, 59],
      [60 * 60, 60],
      [60 * 60 + 59, 60],
      [90 * 60, 90],
    ];
    for (const [offsetSeconds, expected] of cases) {
      expect(stalenessMinutes(BASE, at(offsetSeconds)), `offset ${offsetSeconds}s`).toBe(expected);
    }
  });

  it("clamps a future asOf to 0 minutes and flags it", () => {
    const staleness = computeStaleness(BASE, at(-120));
    expect(staleness.minutes).toBe(0);
    expect(staleness.isFuture).toBe(true);
    expect(staleness.isStale).toBe(false);
    expect(stalenessFormatter.format(BASE, at(-120))).toBe("as of 08:42, 0 min ago");
  });

  it("marks data stale past the freshness budget", () => {
    expect(computeStaleness(BASE, at(5 * 60)).isStale).toBe(false);
    expect(computeStaleness(BASE, at(5 * 60 + 1)).isStale).toBe(true);
    expect(computeStaleness(BASE, at(20 * 60), { staleAfterMinutes: 30 }).isStale).toBe(false);
  });

  it("is deterministic: same inputs, same string, independent of wall clock", () => {
    const formatter = new StalenessFormatter({ locale: "en" });
    const first = formatter.format(BASE, at(7 * 60));
    const second = formatter.format(BASE, at(7 * 60));
    expect(first).toBe(second);
    expect(first).toBe("as of 08:42, 7 min ago");
  });

  it("rejects an unparseable timestamp instead of inventing a time", () => {
    expect(() => formatClockTime("not-a-date")).toThrow(RangeError);
    expect(() => computeStaleness(BASE, "also-not-a-date")).toThrow(RangeError);
  });
});
