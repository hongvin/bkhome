/**
 * Compact artifact + windowed expansion.
 *
 * The claim under test is NOT "the compact file is smaller" (though it is) but
 * "expanding a window from the compact file reproduces exactly what the full
 * artifact contains". That equivalence is checked against the full graph.
 */

import { statSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseTransitGraph } from "@/lib/gtfs/graph-io";
import {
  compactSegmentIds,
  expandConnectionsForWindow,
  materializeTransitGraph,
  parseCompactGraph,
  serializeCompactGraph,
  toCompactGraph,
  validateCompactGraph,
} from "@/lib/gtfs/compact";
import { validateTransitGraph } from "@/lib/gtfs/graph-io";
import { planJourneys, planJourneysFromCompact } from "@/lib/routing/plan";
import { itinerarySignature } from "@/lib/routing/itinerary";
import { COMPACT_GRAPH_PATH, GRAPH_PATH, cachedGraph, makeQuery, readCompactGraphJson, readGraphJson } from "./helpers";

const graph = cachedGraph();
const compact = toCompactGraph(graph);

describe("compact artifact", () => {
  test("is written to disk and contains no connections", () => {
    const json = readCompactGraphJson();
    expect(statSync(COMPACT_GRAPH_PATH).size).toBeGreaterThan(0);
    expect(json).not.toContain('"connections"');
    // Much smaller than the full artifact.
    expect(statSync(COMPACT_GRAPH_PATH).size * 20).toBeLessThan(statSync(GRAPH_PATH).size);
  });

  test("validates and round-trips", () => {
    expect(validateCompactGraph(compact)).toEqual([]);
    const reparsed = parseCompactGraph(serializeCompactGraph(compact));
    expect(reparsed.tripPatterns).toEqual(compact.tripPatterns);
    expect(reparsed.stats).toEqual(graph.stats);
    expect(reparsed.stations).toEqual(graph.stations);
  });

  test("has one pattern per trip template, covering every frequency row", () => {
    expect(compact.tripPatterns).toHaveLength(48);
    const templates = new Set(compact.tripPatterns.map((p) => p.tripId));
    for (const frequency of compact.frequencies) {
      expect(templates.has(frequency.tripId)).toBe(true);
    }
    for (const pattern of compact.tripPatterns) {
      expect(pattern.stopIds.length).toBeGreaterThanOrEqual(2);
      expect(pattern.departureOffsets).toHaveLength(pattern.stopIds.length - 1);
      expect(pattern.arrivalOffsets).toHaveLength(pattern.stopIds.length);
      expect(pattern.departureOffsets[0]).toBe(0);
      // Times must be non-decreasing along the pattern, and every hop must take
      // at least one second.
      for (let i = 0; i < pattern.departureOffsets.length; i += 1) {
        expect(pattern.arrivalOffsets[i + 1]).toBeGreaterThan(pattern.departureOffsets[i]);
        if (i > 0) expect(pattern.departureOffsets[i]).toBeGreaterThanOrEqual(pattern.arrivalOffsets[i]);
      }
    }
  });

  test("every segment in the compact patterns exists in the graph", () => {
    const known = new Set(graph.segments.map((s) => s.id));
    for (const segmentId of compactSegmentIds(compact)) {
      expect(known.has(segmentId), segmentId).toBe(true);
    }
  });
});

describe("windowed expansion equals the full artifact", () => {
  test("Monday 08:00-11:00 matches the corresponding slice of the full graph", () => {
    const from = 8 * 3600;
    const to = 11 * 3600;
    const expanded = expandConnectionsForWindow(compact, 1, from, to);
    const expected = graph.connections.filter(
      (c) =>
        c.serviceId === "MonFri" && c.departureTime >= from && c.departureTime <= to,
    );
    expect(expanded.length).toBe(expected.length);
    expect(expanded).toEqual(expected);
  });

  test("Sunday 12:00-15:00 matches too (different service pattern)", () => {
    const from = 12 * 3600;
    const to = 15 * 3600;
    const expanded = expandConnectionsForWindow(compact, 0, from, to);
    const expected = graph.connections.filter(
      (c) => c.serviceId === "Sun" && c.departureTime >= from && c.departureTime <= to,
    );
    expect(expanded).toEqual(expected);
  });

  test("a window covering the whole service day reproduces every connection", () => {
    const expanded = expandConnectionsForWindow(compact, 1, 0, 30 * 3600);
    const expected = graph.connections.filter((c) => c.serviceId === "MonFri");
    expect(expanded.length).toBe(expected.length);
    expect(expanded).toEqual(expected);
  });

  test("the exact window planJourneysFromCompact uses matches the full graph", () => {
    // 08:00 + maxInitialWait(1800) + MAX_PLANNING_HORIZON_SECONDS(6h)
    const from = 8 * 3600;
    const to = from + 1800 + 6 * 3600;
    const expanded = expandConnectionsForWindow(compact, 1, from, to);
    const expected = graph.connections.filter(
      (c) => c.serviceId === "MonFri" && c.departureTime >= from && c.departureTime <= to,
    );
    expect(expanded.length).toBe(expected.length);
    expect(expanded).toEqual(expected);
  });

  test("trips that started before the window still contribute their later stops", () => {
    // Kelana Jaya runs take ~1h40m end to end, so the 06:00-07:00 headway row
    // must still feed connections that depart after 08:00.
    const expanded = expandConnectionsForWindow(compact, 1, 8 * 3600, 9 * 3600);
    const longRuns = expanded.filter((c) => c.lineId === "KJ" && c.departureTime >= 8 * 3600);
    expect(longRuns.length).toBeGreaterThan(0);
    const full = graph.connections.filter(
      (c) => c.serviceId === "MonFri" && c.lineId === "KJ" && c.departureTime >= 8 * 3600 && c.departureTime <= 9 * 3600,
    );
    expect(longRuns.length).toBe(full.length);
  });

  test("expansion is sorted ascending by departureTime", () => {
    const expanded = expandConnectionsForWindow(compact, 1, 6 * 3600, 9 * 3600);
    expect(expanded.length).toBeGreaterThan(1000);
    for (let i = 1; i < expanded.length; i += 1) {
      expect(expanded[i].departureTime).toBeGreaterThanOrEqual(expanded[i - 1].departureTime);
    }
  });

  test("an empty window expands to nothing", () => {
    expect(expandConnectionsForWindow(compact, 1, 3 * 3600, 4 * 3600)).toEqual([]);
  });

  test("the window is far smaller than the full connection set", () => {
    const peak = expandConnectionsForWindow(compact, 1, 8 * 3600, 11 * 3600);
    expect(peak.length).toBeLessThan(graph.connections.length / 10);
    expect(peak.length).toBeGreaterThan(1000);
  });
});

describe("routing from the compact artifact", () => {
  test("a materialized window is a valid TransitGraph", () => {
    const windowed = materializeTransitGraph(compact, {
      weekday: 1,
      fromSeconds: 8 * 3600,
      toSeconds: 14 * 3600,
    });
    expect(validateTransitGraph(windowed)).toEqual([]);
    expect(windowed.stats.connectionCount).toBe(windowed.connections.length);
    expect(windowed.stats.stationCount).toBe(graph.stats.stationCount);
  });

  test("planJourneysFromCompact returns the same itineraries as the full graph", () => {
    const query = makeQuery("KJ10", "KJ15", { maxItineraries: 4 });
    const fromFull = planJourneys({ graph, query });
    const fromCompact = planJourneysFromCompact(parseCompactGraph(readCompactGraphJson()), { query });
    expect(fromCompact.map(itinerarySignature)).toEqual(fromFull.map(itinerarySignature));
    expect(fromCompact[0].arrival.p90Seconds).toBeCloseTo(fromFull[0].arrival.p90Seconds, 6);
  });

  test("a cross-line journey plans identically from the compact artifact", () => {
    const query = makeQuery("KJ9", "AG9", { maxItineraries: 6 });
    const fromFull = planJourneys({ graph, query });
    const fromCompact = planJourneysFromCompact(parseCompactGraph(readCompactGraphJson()), { query });
    expect(fromCompact.map(itinerarySignature)).toEqual(fromFull.map(itinerarySignature));
  });

  test("routing from the compact artifact needs no network", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("NETWORK ACCESS ATTEMPTED");
    }) as unknown as typeof fetch;
    try {
      const result = planJourneysFromCompact(parseCompactGraph(readCompactGraphJson()), {
        query: makeQuery("KJ10", "KJ15"),
      });
      expect(result.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a window materialized from JSON routes identically to one from memory", () => {
    const reparsed = parseCompactGraph(readCompactGraphJson());
    const inMemory = materializeTransitGraph(compact, {
      weekday: 1,
      fromSeconds: 8 * 3600,
      toSeconds: 14 * 3600,
    });
    const fromJson = materializeTransitGraph(reparsed, {
      weekday: 1,
      fromSeconds: 8 * 3600,
      toSeconds: 14 * 3600,
    });
    const query = makeQuery("KJ10", "KJ15");
    expect(planJourneys({ graph: fromJson, query })).toEqual(planJourneys({ graph: inMemory, query }));
  });
});

describe("full artifact is unchanged by the compact work", () => {
  test("the full graph still parses and routes", () => {
    const full = parseTransitGraph(readGraphJson());
    expect(full.connections.length).toBeGreaterThan(150_000);
    expect(planJourneys({ graph: full, query: makeQuery("KJ10", "KJ15") }).length).toBeGreaterThanOrEqual(2);
  });
});
