/**
 * Staleness formatter.
 *
 * The acceptance requirement: it must produce "as of HH:MM, N min ago"
 * correctly. The rule behind it: cached data is never presented as live.
 */
import { describe, expect, it } from "vitest";

import {
  OFFLINE_CONFIDENCE_MULTIPLIER,
  formatStaleness,
  klClock,
  minutesBetween,
  reduceConfidenceForOffline,
} from "@/components/lib/staleness";

/** The demo instant: Monday 2025-03-17, 08:26 Asia/Kuala_Lumpur (+08:00). */
const DEMO_NOW = "2025-03-17T08:26:00+08:00";
const AS_OF_14_MIN = "2025-03-17T08:12:00+08:00";

describe("clock rendering", () => {
  it("renders HH:MM in Asia/Kuala_Lumpur regardless of the host timezone", () => {
    expect(klClock(AS_OF_14_MIN)).toBe("08:12");
    expect(klClock(DEMO_NOW)).toBe("08:26");
    // 00:26 UTC is 08:26 in Kuala Lumpur.
    expect(klClock("2025-03-17T00:26:00Z")).toBe("08:26");
  });

  it("degrades to --:-- on an unparseable input instead of printing NaN", () => {
    expect(klClock("not a date")).toBe("--:--");
  });

  it("computes whole minutes, floored, never negative", () => {
    expect(minutesBetween(AS_OF_14_MIN, DEMO_NOW)).toBe(14);
    expect(minutesBetween(DEMO_NOW, AS_OF_14_MIN)).toBe(0);
  });
});

describe('"as of HH:MM, N min ago"', () => {
  it("produces the exact acceptance string in English", () => {
    const result = formatStaleness({
      asOf: AS_OF_14_MIN,
      stalenessMinutes: 14,
      locale: "en",
    });
    expect(result.text).toBe("as of 08:12, 14 min ago");
    expect(result.key).toBe("stale.asOf");
    expect(result.clock).toBe("08:12");
    expect(result.totalMinutes).toBe(14);
    expect(result.isFresh).toBe(false);
  });

  it("produces the Bahasa Malaysia equivalent", () => {
    const result = formatStaleness({
      asOf: AS_OF_14_MIN,
      stalenessMinutes: 14,
      locale: "ms",
    });
    expect(result.text).toBe("setakat 08:12, 14 min lalu");
  });

  it("handles sub-minute staleness explicitly rather than saying 0 min ago", () => {
    const result = formatStaleness({
      asOf: AS_OF_14_MIN,
      stalenessMinutes: 0,
      locale: "en",
      cached: true,
    });
    expect(result.text).toBe("as of 08:12, less than a minute ago");
    expect(result.key).toBe("stale.asOfJustNow");
  });

  it("rolls over to hours past 60 minutes", () => {
    const result = formatStaleness({ asOf: AS_OF_14_MIN, stalenessMinutes: 95, locale: "en" });
    expect(result.text).toBe("as of 08:12, 1 h 35 min ago");
    expect(result.key).toBe("stale.asOfHours");
  });

  it("rolls over exactly at 60", () => {
    expect(
      formatStaleness({ asOf: AS_OF_14_MIN, stalenessMinutes: 59, locale: "en" }).text,
    ).toBe("as of 08:12, 59 min ago");
    expect(
      formatStaleness({ asOf: AS_OF_14_MIN, stalenessMinutes: 60, locale: "en" }).key,
    ).toBe("stale.asOfHours");
  });

  it("reports live data as live when there is nothing to disclose", () => {
    const result = formatStaleness({
      asOf: DEMO_NOW,
      stalenessMinutes: 0,
      locale: "en",
      cached: false,
    });
    expect(result.isFresh).toBe(true);
    expect(result.text).toBe("Live");
  });

  it("adds minutes accrued on the device while offline", () => {
    const result = formatStaleness({
      asOf: AS_OF_14_MIN,
      stalenessMinutes: 14,
      locale: "en",
      offlineExtraMinutes: 9,
    });
    expect(result.text).toBe("as of 08:12, 23 min ago");
    expect(result.totalMinutes).toBe(23);
  });

  it("keeps the clock part stable while only the age grows", () => {
    const first = formatStaleness({
      asOf: AS_OF_14_MIN,
      stalenessMinutes: 14,
      locale: "en",
      offlineExtraMinutes: 0,
    });
    const later = formatStaleness({
      asOf: AS_OF_14_MIN,
      stalenessMinutes: 14,
      locale: "en",
      offlineExtraMinutes: 30,
    });
    expect(later.clock).toBe(first.clock);
    expect(later.totalMinutes).toBeGreaterThan(first.totalMinutes);
  });

  it("is deterministic: same input, same output", () => {
    const input = { asOf: AS_OF_14_MIN, stalenessMinutes: 14, locale: "en" as const };
    expect(formatStaleness(input).text).toBe(formatStaleness(input).text);
  });

  it("never claims freshness for cached data", () => {
    for (const minutes of [0, 1, 5, 14, 59, 60, 240]) {
      const result = formatStaleness({
        asOf: AS_OF_14_MIN,
        stalenessMinutes: minutes,
        locale: "en",
        cached: true,
      });
      expect(result.text.toLowerCase()).toContain("as of");
      expect(result.isFresh).toBe(false);
    }
  });
});

describe("offline confidence reduction", () => {
  it("multiplies confidence down while offline", () => {
    expect(reduceConfidenceForOffline(0.82, true)).toBeCloseTo(0.82 * OFFLINE_CONFIDENCE_MULTIPLIER, 3);
    expect(reduceConfidenceForOffline(0.82, false)).toBe(0.82);
  });

  it("stays inside [0,1]", () => {
    expect(reduceConfidenceForOffline(1, true)).toBeLessThanOrEqual(1);
    expect(reduceConfidenceForOffline(0, true)).toBe(0);
    expect(reduceConfidenceForOffline(2, false)).toBe(1);
  });
});
