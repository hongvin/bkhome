/**
 * Sanity tests against real Klang Valley journeys, plus structural invariants
 * that every itinerary must satisfy.
 *
 * This is the test that retires the fundamental risk: if these pass, the graph
 * and CSA produce journeys a rider would recognise, with real station names and
 * real clock times.
 */

import { describe, expect, test } from "vitest";
import type { Itinerary, TransitGraph } from "@/lib/contracts";
import { planJourneys } from "@/lib/routing/plan";
import { itineraryLineIds, itinerarySegmentIds, itinerarySignature } from "@/lib/routing/itinerary";
import { formatClock } from "@/lib/gtfs/normalize";
import { cachedGraph, makeQuery, rideSignature, summarise } from "./helpers";

const graph = cachedGraph();

function stationName(g: TransitGraph, id: string): string {
  return g.stations.find((s) => s.id === id)?.name ?? id;
}

/** Human-readable journey, used as printed evidence in the test log. */
function formatJourney(g: TransitGraph, itinerary: Itinerary): string {
  const lines = [
    `rank ${itinerary.rank} | reliability ${(itinerary.reliabilityScore * 100).toFixed(1)}% (${itinerary.reliabilityBadge}) | P90 ${formatClock(itinerary.arrival.p90Seconds)} | mean ${formatClock(itinerary.arrival.meanSeconds)} | ${Math.round(itinerary.totalDurationSeconds / 60)} min | ${itinerary.transferCount} transfer(s) | ${itinerary.lineCount} line(s)`,
  ];
  for (const leg of itinerary.legs) {
    const from = stationName(g, leg.fromStationId);
    const to = stationName(g, leg.toStationId);
    const line = leg.lineId ? ` [${leg.lineId}]` : "";
    lines.push(
      `   ${formatClock(leg.departureTime)}-${formatClock(leg.arrivalTime)} ${leg.kind.padEnd(8)}${line} ${from} -> ${to}`,
    );
  }
  lines.push(`   why: ${itinerary.whyThisRank}`);
  return lines.join("\n");
}

function assertItineraryInvariants(itinerary: Itinerary): void {
  // Ranking + reliability bounds.
  expect(itinerary.rank).toBeGreaterThanOrEqual(1);
  expect(itinerary.reliabilityScore).toBeGreaterThanOrEqual(0);
  expect(itinerary.reliabilityScore).toBeLessThanOrEqual(1);
  expect([
    "VERY_RELIABLE",
    "RELIABLE",
    "UNCERTAIN",
    "AT_RISK",
    "AVOID",
  ]).toContain(itinerary.reliabilityBadge);
  expect(itinerary.whyThisRank.length).toBeGreaterThan(20);

  // Arrival window ordering.
  const { p10Seconds, p50Seconds, p90Seconds, meanSeconds, meanToP90GapSeconds } = itinerary.arrival;
  expect(p10Seconds).toBeLessThanOrEqual(p50Seconds + 1e-6);
  expect(p50Seconds).toBeLessThanOrEqual(p90Seconds + 1e-6);
  expect(meanSeconds).toBeCloseTo(p50Seconds, 6);
  expect(meanToP90GapSeconds).toBeCloseTo(p90Seconds - meanSeconds, 6);
  expect(meanToP90GapSeconds).toBeGreaterThanOrEqual(0);
  // P90 must always sit above the mean — that gap is the product.
  expect(itinerary.arrival.p90Seconds).toBeGreaterThan(itinerary.arrival.meanSeconds);

  // Legs are time-ordered, contiguous and internally consistent.
  let previousArrival = Number.NEGATIVE_INFINITY;
  let rideLegs = 0;
  for (const leg of itinerary.legs) {
    expect(leg.arrivalTime).toBeGreaterThan(leg.departureTime);
    expect(leg.departureTime).toBeGreaterThanOrEqual(previousArrival - 1e-6);
    previousArrival = leg.arrivalTime;
    if (leg.kind === "RIDE") {
      rideLegs += 1;
      expect(leg.lineId).not.toBeNull();
      expect(leg.segmentIds.length).toBeGreaterThan(0);
      expect(leg.scheduledSeconds).toBe(leg.arrivalTime - leg.departureTime);
    } else {
      expect(leg.lineId).toBeNull();
      expect(leg.segmentIds).toEqual([]);
    }
    expect(leg.addedDelaySeconds).toBeGreaterThanOrEqual(0);
  }

  // Consecutive legs must connect (either at the same station or across a
  // transfer leg that starts where the previous leg ended).
  for (let i = 1; i < itinerary.legs.length; i += 1) {
    expect(itinerary.legs[i].fromStationId).toBe(itinerary.legs[i - 1].toStationId);
  }

  // Counts agree with the legs.
  expect(itinerary.transferCount).toBe(Math.max(0, rideLegs - 1));
  expect(itinerary.lineCount).toBe(itineraryLineIds(itinerary).length);

  // Timing agrees with the first leg.
  if (itinerary.legs.length > 0) {
    expect(itinerary.departureTime).toBe(itinerary.legs[0].departureTime);
    expect(itinerary.totalDurationSeconds).toBeCloseTo(
      itinerary.arrival.meanSeconds - itinerary.departureTime,
      6,
    );
  }

  // Risk bookkeeping.
  expect(itinerary.maxDegradationProbability).toBeGreaterThanOrEqual(0);
  expect(itinerary.maxDegradationProbability).toBeLessThanOrEqual(1);
  expect(itinerary.expectedDelaySeconds).toBeGreaterThanOrEqual(0);
  for (const segmentId of itinerary.riskySegmentIds) {
    expect(itinerarySegmentIds(itinerary)).toContain(segmentId);
  }
}

describe("real Klang Valley journeys", () => {
  test("KLCC (KJ10) -> KL Sentral (KJ15): a real direct ride", () => {
    const itineraries = planJourneys({ graph, query: makeQuery("KJ10", "KJ15") });
    expect(itineraries.length).toBeGreaterThanOrEqual(2);

    // eslint-disable-next-line no-console
    console.log(
      [
        "KLCC (KJ10) -> KL Sentral (KJ15), Monday 08:00:",
        ...itineraries.map((it) => formatJourney(graph, it)),
      ].join("\n"),
    );

    const top = itineraries[0];
    expect(itinerarySegmentIds(top)).toContain("KJ:KJ10->KJ11");
    expect(itinerarySegmentIds(top)).toContain("KJ:KJ14->KJ15");
    expect(top.transferCount).toBe(0);
    expect(top.lineCount).toBe(1);
    expect(top.legs.some((leg) => leg.fromStationId === "KJ10")).toBe(true);
    expect(top.legs.some((leg) => leg.toStationId === "KJ15")).toBe(true);
    expect(top.arrival.meanSeconds).toBeGreaterThan(top.departureTime);
    expect(top.totalDurationSeconds).toBeGreaterThan(0);
    expect(top.totalDurationSeconds).toBeLessThan(2 * 3600);

    for (const itinerary of itineraries) assertItineraryInvariants(itinerary);
  });

  test("KLCC -> KL Sentral offers genuinely distinct options", () => {
    const itineraries = planJourneys({ graph, query: makeQuery("KJ10", "KJ15") });
    const signatures = new Set(itineraries.map(itinerarySignature));
    expect(signatures.size).toBe(itineraries.length);
    expect(signatures.size).toBeGreaterThanOrEqual(2);
    // eslint-disable-next-line no-console
    console.log(`KLCC -> KL Sentral routes:\n${itineraries.map(rideSignature).join("\n")}`);
  });

  test("Ampang Park -> Hang Tuah: cross-line journey requiring an interchange", () => {
    const itineraries = planJourneys({
      graph,
      query: makeQuery("KJ9", "AG9", { maxItineraries: 8 }),
    });
    expect(itineraries.length).toBeGreaterThanOrEqual(2);

    // eslint-disable-next-line no-console
    console.log(
      [
        "Ampang Park (KJ9) -> Hang Tuah (AG9), Monday 08:00:",
        ...itineraries.map((it) => formatJourney(graph, it)),
      ].join("\n"),
    );

    for (const itinerary of itineraries) {
      assertItineraryInvariants(itinerary);
      expect(itinerary.transferCount).toBeGreaterThanOrEqual(1);
      expect(itinerary.lineCount).toBeGreaterThanOrEqual(2);
    }

    // The two headline line combinations the orchestrator called out.
    const lineSets = itineraries.map((it) =>
      itineraryLineIds(it)
        .slice()
        .sort()
        .join("+"),
    );
    expect(lineSets).toContain("AG+KJ");
    expect(lineSets).toContain("KGL+MR+PYL");

    // Every itinerary really ends at a Hang Tuah platform.
    for (const itinerary of itineraries) {
      const last = itinerary.legs[itinerary.legs.length - 1];
      expect(["AG9", "SP9", "MR4"]).toContain(last.toStationId);
    }
  });

  test("Putra Heights -> Sentul Timur works in both directions", () => {
    for (const [origin, destination] of [
      ["KJ37", "AG1"],
      ["AG1", "KJ37"],
    ] as const) {
      const itineraries = planJourneys({
        graph,
        query: makeQuery(origin, destination, { maxItineraries: 4, maxTransfers: 3 }),
      });
      expect(itineraries.length, `${origin} -> ${destination}`).toBeGreaterThanOrEqual(1);
      for (const itinerary of itineraries) assertItineraryInvariants(itinerary);
    }
  });

  test("every itinerary of a busy interchange pair satisfies all invariants", () => {
    const pairs: Array<[string, string]> = [
      ["KJ10", "KJ15"],
      ["KJ9", "MR4"],
      ["PY20", "SP9"],
      ["KG18A", "AG10"],
      ["SA1", "KG09"],
      ["BRT7", "KJ31"],
      ["MR1", "KJ15"],
    ];
    for (const [origin, destination] of pairs) {
      const itineraries = planJourneys({
        graph,
        query: makeQuery(origin, destination, { maxItineraries: 5, maxTransfers: 4 }),
      });
      expect(itineraries.length, `${origin} -> ${destination}`).toBeGreaterThanOrEqual(1);
      for (const itinerary of itineraries) assertItineraryInvariants(itinerary);
    }
  });

  test("arrival windows widen with the length of the journey", () => {
    const short = planJourneys({ graph, query: makeQuery("KJ10", "KJ15") })[0];
    const long = planJourneys({ graph, query: makeQuery("KJ37", "AG1") })[0];
    expect(long.arrival.meanToP90GapSeconds).toBeGreaterThan(short.arrival.meanToP90GapSeconds);
    expect(long.totalDurationSeconds).toBeGreaterThan(short.totalDurationSeconds);
  });

  test("a full cross-network journey is printable end to end", () => {
    const itineraries = planJourneys({
      graph,
      query: makeQuery("SA26", "KG04", { maxItineraries: 3, maxTransfers: 4 }),
    });
    expect(itineraries.length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(
      [
        "Johan Setia (SA26) -> Kwasa Damansara (KG04):",
        ...itineraries.map((it) => formatJourney(graph, it)),
      ].join("\n"),
    );
    for (const itinerary of itineraries) assertItineraryInvariants(itinerary);
  });
});

describe("itinerary summary helper", () => {
  test("produces one line per itinerary", () => {
    const itineraries = planJourneys({ graph, query: makeQuery("KJ10", "KJ15") });
    expect(summarise(itineraries).split("\n")).toHaveLength(itineraries.length);
  });
});
