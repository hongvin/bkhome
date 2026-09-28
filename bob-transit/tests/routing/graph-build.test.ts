/**
 * Contract conformance + structural integrity of the built `TransitGraph`.
 */

import { statSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { CONTRACTS_VERSION, TZ_NAME, makeSegmentId } from "@/lib/contracts";
import { validateTransitGraph, parseTransitGraph, serializeTransitGraph } from "@/lib/gtfs/graph-io";
import { computeInterchanges, transferWalkSeconds } from "@/lib/gtfs/interchange";
import { GRAPH_PATH, cachedGraph, readGraphJson } from "./helpers";

/** Verified against the committed fixture by the orchestrator. */
const STOPS_PER_LINE: Record<string, number> = {
  KJ: 37,
  PYL: 36,
  PH: 29,
  KGL: 29,
  SA: 20,
  AG: 18,
  MR: 11,
  BRT: 7,
};

describe("graph artifact", () => {
  test("exists on disk and validates against the frozen contract", () => {
    expect(statSync(GRAPH_PATH).size).toBeGreaterThan(0);
    expect(validateTransitGraph(cachedGraph())).toEqual([]);
    expect(cachedGraph().contractsVersion).toBe(CONTRACTS_VERSION);
    expect(cachedGraph().timezone).toBe(TZ_NAME);
  });

  test("round-trips through JSON without loss", () => {
    const graph = cachedGraph();
    const reparsed = parseTransitGraph(serializeTransitGraph(graph));
    expect(reparsed.stats).toEqual(graph.stats);
    expect(reparsed.stations).toEqual(graph.stations);
    expect(reparsed.segments).toEqual(graph.segments);
    expect(reparsed.connections.length).toBe(graph.connections.length);
  });

  test("parsing rejects a graph whose connections are out of order", () => {
    const graph = cachedGraph();
    const broken = { ...graph, connections: [...graph.connections].reverse() };
    const problems = validateTransitGraph(broken);
    expect(problems.join("\n")).toMatch(/not sorted by departureTime/);
  });

  test("stats are self-consistent", () => {
    const graph = cachedGraph();
    expect(graph.stats.stationCount).toBe(graph.stations.length);
    expect(graph.stats.lineCount).toBe(graph.lines.length);
    expect(graph.stats.segmentCount).toBe(graph.segments.length);
    expect(graph.stats.connectionCount).toBe(graph.connections.length);
  });

  test("carries the verified network shape", () => {
    const graph = cachedGraph();
    expect(graph.stats.stationCount).toBe(187);
    expect(graph.stats.lineCount).toBe(8);
    expect(graph.stats.segmentCount).toBe(358);
    expect(graph.stats.serviceDayCount).toBe(3); // MonFri, Sat, Sun
    expect(graph.connections.length).toBeGreaterThan(150_000);
    expect(graph.frequencies.length).toBe(106);
    expect(graph.services.length).toBe(8);
  });

  test("stops-per-line match the orchestrator's verified counts", () => {
    const graph = cachedGraph();
    const counts = new Map<string, number>();
    for (const station of graph.stations) {
      for (const lineId of station.lineIds) {
        counts.set(lineId, (counts.get(lineId) ?? 0) + 1);
      }
    }
    for (const [lineId, expected] of Object.entries(STOPS_PER_LINE)) {
      expect(counts.get(lineId), `stops on ${lineId}`).toBe(expected);
    }
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(187);
  });

  test("connections are sorted ascending by departureTime (CSA precondition)", () => {
    const graph = cachedGraph();
    for (let i = 1; i < graph.connections.length; i += 1) {
      expect(graph.connections[i].departureTime).toBeGreaterThanOrEqual(
        graph.connections[i - 1].departureTime,
      );
    }
  });

  test("every connection resolves to a real segment, station and line", () => {
    const graph = cachedGraph();
    const segmentIds = new Set(graph.segments.map((s) => s.id));
    const stationIds = new Set(graph.stations.map((s) => s.id));
    const lineIds = new Set(graph.lines.map((l) => l.id));
    const segmentById = new Map(graph.segments.map((s) => [s.id, s] as const));

    for (const c of graph.connections) {
      expect(segmentIds.has(c.segmentId)).toBe(true);
      expect(stationIds.has(c.fromStationId)).toBe(true);
      expect(stationIds.has(c.toStationId)).toBe(true);
      expect(lineIds.has(c.lineId)).toBe(true);
      expect(c.arrivalTime).toBeGreaterThan(c.departureTime);
      const segment = segmentById.get(c.segmentId);
      expect(segment?.fromStationId).toBe(c.fromStationId);
      expect(segment?.toStationId).toBe(c.toStationId);
      expect(segment?.lineId).toBe(c.lineId);
    }
  });

  test("segments are directional, non-degenerate, and shaped", () => {
    const graph = cachedGraph();
    const ids = new Set(graph.segments.map((s) => s.id));
    for (const segment of graph.segments) {
      expect(segment.id).toBe(
        makeSegmentId(segment.lineId, segment.fromStationId, segment.toStationId),
      );
      expect(segment.fromStationId).not.toBe(segment.toStationId);
      expect(segment.scheduledRunSeconds).toBeGreaterThan(0);
      expect(segment.scheduledDwellSeconds).toBeGreaterThanOrEqual(0);
      expect(segment.shape.length).toBeGreaterThanOrEqual(2);
      expect(segment.lengthMeters).toBeGreaterThan(0);
      // Both directions of every hop must exist.
      expect(ids.has(makeSegmentId(segment.lineId, segment.toStationId, segment.fromStationId))).toBe(
        true,
      );
    }
  });

  test("interchange stops are flagged and grouped", () => {
    const graph = cachedGraph();
    const topology = computeInterchanges(graph.stations);
    const groupOf = (id: string): string[] => {
      const group = topology.groups.find((g) => g.stationIds.includes(id));
      return group ? group.stationIds : [];
    };
    // The three interchanges the A2 test depends on.
    expect(groupOf("KJ9")).toEqual(expect.arrayContaining(["KJ9", "PY20"]));
    expect(groupOf("AG9")).toEqual(expect.arrayContaining(["AG9", "SP9", "MR4"]));
    expect(groupOf("KJ13")).toEqual(expect.arrayContaining(["KJ13", "AG7", "SP7"]));
    // Name mismatch bridged by proximity.
    expect(groupOf("KJ15")).toEqual(expect.arrayContaining(["KJ15", "MR1"]));
    // Same-line neighbours are never linked.
    expect(groupOf("MR1")).not.toContain("MR2");
    // Nothing is grouped with itself only.
    expect(groupOf("KJ10").length).toBe(0);

    for (const id of ["KJ9", "PY20", "AG9", "SP9", "MR4", "KJ13", "AG7", "SP7", "KJ15", "MR1"]) {
      expect(graph.stations.find((s) => s.id === id)?.isInterchange, `${id} isInterchange`).toBe(
        true,
      );
    }
    expect(graph.stations.find((s) => s.id === "KJ10")?.isInterchange).toBe(false);
  });

  test("transfer walking times are bounded and monotonic in distance", () => {
    expect(transferWalkSeconds(0)).toBe(120);
    expect(transferWalkSeconds(60)).toBeGreaterThan(transferWalkSeconds(0));
    expect(transferWalkSeconds(10_000)).toBeLessThanOrEqual(900);
  });

  test("stations are normalised and carry no broken geometry", () => {
    const graph = cachedGraph();
    const klcc = graph.stations.find((s) => s.id === "KJ10");
    expect(klcc?.name).toBe("KLCC");
    expect(klcc?.nameMs).toBe("KLCC");
    expect(klcc?.lineIds).toEqual(["KJ"]);
    expect(klcc?.isAccessible).toBe(true);

    for (const station of graph.stations) {
      expect(station.name).not.toContain("[object Object]");
      expect(station.lineIds.length).toBeGreaterThan(0);
      expect(Number.isFinite(station.lat)).toBe(true);
      expect(Number.isFinite(station.lon)).toBe(true);
    }
  });

  test("warnings surface the broken geometry column and no phantom missing patterns", () => {
    const graph = cachedGraph();
    const text = graph.warnings.join("\n");
    expect(text).toMatch(/geometry/);
    expect(text).toMatch(/\[object Object\]/);
    // All 48 trip templates DO have stop_times; there is no missing pattern.
    expect(text).not.toMatch(/no frequencies\.txt headway/);
    expect(text).not.toMatch(/fewer than 2 stop_times/);
    expect(text).not.toMatch(/unmappable route_id/);
  });

  test("frequency templates cover all three service patterns", () => {
    const graph = cachedGraph();
    const services = new Set(graph.frequencies.map((f) => f.serviceId));
    expect([...services].sort()).toEqual(["MonFri", "Sat", "Sun"]);
    const trips = new Set(graph.frequencies.map((f) => f.tripId));
    expect(trips.size).toBe(48);
    for (const f of graph.frequencies) {
      expect(f.headwaySeconds).toBeGreaterThan(0);
      expect(f.endTime).toBeGreaterThan(f.startTime);
    }
  });

  test("the raw JSON is the artifact the browser caches", () => {
    const json = readGraphJson();
    expect(json.length).toBeGreaterThan(1_000_000);
    expect(json.trimStart().startsWith("{")).toBe(true);
  });
});
