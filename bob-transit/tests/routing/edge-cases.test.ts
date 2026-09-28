/**
 * Property / edge-case tests for the router.
 *
 * The brief listed a "missing weekend pattern" case. The orchestrator verified
 * that claim was wrong: all 48 trip templates have stop_times and all three
 * service patterns (MonFri, Sat, Sun) are covered, so there is no missing
 * pattern to degrade. That case is replaced here by positive weekend coverage.
 */

import { describe, expect, test } from "vitest";
import { planJourneys } from "@/lib/routing/plan";
import { itinerarySegmentIds } from "@/lib/routing/itinerary";
import { cachedGraph, makeQuery, summarise } from "./helpers";

const graph = cachedGraph();

describe("degenerate queries", () => {
  test("origin === destination returns one trivial itinerary", () => {
    const result = planJourneys({ graph, query: makeQuery("KJ10", "KJ10") });
    expect(result).toHaveLength(1);
    const only = result[0];
    expect(only.legs).toEqual([]);
    expect(only.totalDurationSeconds).toBe(0);
    expect(only.transferCount).toBe(0);
    expect(only.lineCount).toBe(0);
    expect(only.reliabilityScore).toBe(1);
    expect(only.reliabilityBadge).toBe("VERY_RELIABLE");
    expect(only.rank).toBe(1);
    expect(only.arrival.p90Seconds).toBe(only.arrival.meanSeconds);
    expect(only.whyThisRank).toMatch(/same station/i);
  });

  test("origin === destination works even for a station with no service at that hour", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ10", { departAfterSeconds: 3 * 3600 }),
    });
    expect(result).toHaveLength(1);
    expect(result[0].legs).toEqual([]);
  });

  test("unknown station ids return no itineraries", () => {
    expect(planJourneys({ graph, query: makeQuery("NOPE", "KJ15") })).toEqual([]);
    expect(planJourneys({ graph, query: makeQuery("KJ10", "NOPE") })).toEqual([]);
    expect(planJourneys({ graph, query: makeQuery("", "") })).toEqual([]);
  });

  test("maxItineraries is honoured as a strict upper bound", () => {
    expect(planJourneys({ graph, query: makeQuery("KJ10", "KJ15", { maxItineraries: 0 }) })).toEqual(
      [],
    );
    expect(planJourneys({ graph, query: makeQuery("KJ10", "KJ15", { maxItineraries: 1 }) })).toHaveLength(1);
    expect(
      planJourneys({ graph, query: makeQuery("KJ10", "KJ15", { maxItineraries: 2 }) }).length,
    ).toBeLessThanOrEqual(2);
  });
});

describe("no service in the requested window", () => {
  test("03:00 returns nothing (before first train)", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ15", { departAfterSeconds: 3 * 3600 }),
    });
    expect(result).toEqual([]);
  });

  test("05:00 returns nothing because the rider gives up before the 06:00 first train", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ15", { departAfterSeconds: 5 * 3600, maxInitialWaitSeconds: 1800 }),
    });
    expect(result).toEqual([]);
  });

  test("the same 05:00 query succeeds once the rider will wait an hour", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ15", { departAfterSeconds: 5 * 3600, maxInitialWaitSeconds: 3600 }),
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const firstRide = result[0].legs.find((leg) => leg.kind === "RIDE");
    expect(firstRide).toBeDefined();
    expect((firstRide?.departureTime ?? 0) - 5 * 3600).toBeLessThanOrEqual(3600);
  });

  test("maxInitialWaitSeconds: 0 returns nothing (the rider never waits)", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ15", { maxInitialWaitSeconds: 0 }),
    });
    expect(result).toEqual([]);
  });

  test("the initial wait never exceeds maxInitialWaitSeconds", () => {
    for (const wait of [120, 300, 600, 1800]) {
      const result = planJourneys({
        graph,
        query: makeQuery("KJ10", "KJ15", { maxInitialWaitSeconds: wait }),
      });
      for (const itinerary of result) {
        const firstRide = itinerary.legs.find((leg) => leg.kind === "RIDE");
        if (!firstRide) continue;
        expect(firstRide.departureTime - 8 * 3600).toBeLessThanOrEqual(wait);
      }
    }
  });
});

describe("unreachable pairs", () => {
  test("a cross-line pair is unreachable with maxTransfers 0", () => {
    // KLCC (KJ) -> Hang Tuah (AG/SP/MR): no single line serves both.
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "AG9", { maxTransfers: 0, maxItineraries: 8 }),
    });
    expect(result).toEqual([]);
  });

  test("the same pair is reachable as soon as one transfer is allowed", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "AG9", { maxTransfers: 1, maxItineraries: 8 }),
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const itinerary of result) {
      expect(itinerary.transferCount).toBeLessThanOrEqual(1);
    }
  });

  test("no itinerary ever exceeds maxTransfers", () => {
    for (const maxTransfers of [0, 1, 2, 3]) {
      const result = planJourneys({
        graph,
        query: makeQuery("KJ37", "AG1", { maxTransfers, maxItineraries: 8 }),
      });
      for (const itinerary of result) {
        expect(itinerary.transferCount).toBeLessThanOrEqual(maxTransfers);
      }
    }
  });
});

describe("service-day coverage", () => {
  test("Monday, Saturday and Sunday all route (no missing service pattern)", () => {
    for (const weekday of [1, 6, 0]) {
      const result = planJourneys({
        graph,
        query: makeQuery("KJ10", "KJ15", { serviceWeekday: weekday }),
      });
      expect(result.length, `weekday ${weekday}`).toBeGreaterThanOrEqual(1);
      const connectionService = result[0].legs.find((leg) => leg.kind === "RIDE");
      expect(connectionService).toBeDefined();
    }
  });

  test("weekend services produce a different departure grid from MonFri", () => {
    const monday = planJourneys({ graph, query: makeQuery("KJ10", "KJ15", { serviceWeekday: 1 }) });
    const sunday = planJourneys({ graph, query: makeQuery("KJ10", "KJ15", { serviceWeekday: 0 }) });
    expect(monday[0].departureTime).toBe(sunday[0].departureTime);
    // Kelana Jaya runs a 240s peak headway on MonFri and 420s on Sunday, so the
    // first boarding cannot be identical.
    const firstRideMonday = monday[0].legs.find((l) => l.kind === "RIDE");
    const firstRideSunday = sunday[0].legs.find((l) => l.kind === "RIDE");
    expect(firstRideMonday?.departureTime).not.toBe(firstRideSunday?.departureTime);
  });

  test("late-night departures still route", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ15", { departAfterSeconds: 23 * 3600 }),
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  test("past the last train there is no route", () => {
    // The last MonFri Kelana Jaya departure is 23:15 + headway slack; 02:00 is
    // outside service even with a generous wait.
    const result = planJourneys({
      graph,
      query: makeQuery("KJ10", "KJ15", {
        departAfterSeconds: 26 * 3600,
        maxInitialWaitSeconds: 1800,
      }),
    });
    expect(result).toEqual([]);
  });
});

describe("long cross-network journeys", () => {
  test("Shah Alam line to MRT Kajang line needs and gets transfers", () => {
    const result = planJourneys({
      graph,
      query: makeQuery("SA26", "KG04", { maxTransfers: 4, maxItineraries: 4 }),
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`edge: SA26 -> KG04\n${summarise(result)}`);
    for (const itinerary of result) {
      expect(itinerarySegmentIds(itinerary).length).toBeGreaterThan(3);
    }
  });

  test("BRT Sunway line connects to the rail network via USJ 7", () => {
    const result = planJourneys({ graph, query: makeQuery("BRT7", "KJ10", { maxTransfers: 3 }) });
    expect(result.length).toBeGreaterThanOrEqual(1);
    // BRT7 (USJ7) and KJ31 (USJ 7) are 50 m apart, so the interchange footpath
    // is what makes this journey possible at all.
    const legs = result[0].legs;
    expect(
      legs.some((leg) => leg.lineId === "BRT") ||
        legs.some((leg) => leg.kind === "TRANSFER" && leg.fromStationId === "BRT7"),
    ).toBe(true);
    expect(itinerarySegmentIds(result[0]).some((id) => id.startsWith("KJ:"))).toBe(true);
  });

  test("an intra-BRT journey is a plain ride", () => {
    const result = planJourneys({ graph, query: makeQuery("BRT7", "BRT1", { maxTransfers: 1 }) });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const segments = itinerarySegmentIds(result[0]);
    expect(segments).toContain("BRT:BRT7->BRT6");
    expect(result[0].transferCount).toBe(0);
  });
});
