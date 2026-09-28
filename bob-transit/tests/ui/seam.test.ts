/**
 * The data-source seam.
 *
 * Proves three things the orchestrator needs at integration time:
 *  1. the mock layer returns REAL contract shapes over the REAL Klang Valley
 *     topology (line ids AG/KJ/PH/KGL/PYL/MR/BRT/SA, real segment ids);
 *  2. the demo actually demonstrates the thesis — the fastest route crosses the
 *     confirmed disruption and therefore ranks BELOW the slower, safer one;
 *  3. `createLiveDataSource` is a real adapter, not a stub: injecting the mock
 *     functions into it produces the same advisory shape as the mock source.
 */
import { describe, expect, it } from "vitest";

import type { DisruptionSignal, RiskOverlay, SegmentRiskLookup } from "@/lib/contracts";
import { CONTRACTS_VERSION } from "@/lib/contracts";
import {
  DEFAULT_DESTINATION_STATION_ID,
  DEFAULT_ORIGIN_STATION_ID,
  buildRouteQuery,
  createLiveDataSource,
  createMockDataSource,
  dataSource,
} from "@/lib/mock";
import { planMockJourneys } from "@/lib/mock/routing";
import { mockRiskOverlay, overlayLookup } from "@/lib/mock/risk";
import { MOCK_SIGNALS } from "@/lib/mock/signals";
import { buildSourceTrace } from "@/lib/mock/traces";
import { loadTopology } from "@/lib/mock/graph";

const CANONICAL_LINE_IDS = ["AG", "KJ", "PH", "KGL", "PYL", "MR", "BRT", "SA"];

describe("topology", () => {
  it("loads a real graph and records where it came from", () => {
    const meta = dataSource.meta();
    expect(["artifact", "fixture"]).toContain(meta.topologySource);
    expect(meta.stationCount).toBeGreaterThan(150);
    expect(meta.segmentCount).toBeGreaterThan(300);
    expect(meta.lineCount).toBe(8);
  });

  it("uses the canonical line ids — KGL, never MRT, for the Kajang line", () => {
    const ids = dataSource.getNetwork().lines.map((l) => l.id).sort();
    expect(ids).toEqual([...CANONICAL_LINE_IDS].sort());
    expect(ids).not.toContain("MRT");
  });

  it("normalises sponsor-suffixed GTFS names", () => {
    const stations = dataSource.getNetwork().stations;
    const klSentral = stations.find((s) => s.id === "KJ15");
    expect(klSentral?.name).toBe("KL Sentral");
    expect(klSentral?.name).not.toMatch(/REDONE/);
    expect(klSentral?.name).not.toBe(klSentral?.name.toUpperCase());
  });

  it("resolves the demo endpoints", () => {
    const topology = loadTopology();
    expect(topology.stationById.get(DEFAULT_ORIGIN_STATION_ID)?.name).toBe("KL Sentral");
    expect(topology.stationById.get(DEFAULT_DESTINATION_STATION_ID)?.name).toBe("Kajang");
  });

  it("knows every segment the fixtures reference", () => {
    const topology = loadTopology();
    for (const signal of MOCK_SIGNALS) {
      for (const segmentId of signal.segmentIds) {
        expect(topology.segmentById.has(segmentId), `${signal.id} -> ${segmentId}`).toBe(true);
      }
    }
  });
});

describe("signals", () => {
  it("returns contract-shaped signals with a full provenance trail", () => {
    for (const signal of MOCK_SIGNALS) {
      expect(signal.provenance.map((h) => h.hop)).toEqual([
        "INGEST",
        "VERIFY",
        "IMPACT",
        "ADVISORY",
      ]);
      expect(signal.sources.length).toBeGreaterThan(0);
      expect(signal.confidence.factors.length).toBeGreaterThan(0);
      // Contributions must actually add up to the reported value.
      const sum = signal.confidence.factors.reduce((acc, f) => acc + f.contribution, 0);
      expect(sum, `${signal.id} factors`).toBeCloseTo(signal.confidence.value, 2);
    }
  });

  it("confidence rises along the pipeline, so the inspector shows a climb", () => {
    for (const signal of MOCK_SIGNALS) {
      const values = signal.provenance.map((h) => h.confidence);
      for (let i = 1; i < values.length; i += 1) {
        expect(values[i]!, `${signal.id} hop ${i}`).toBeGreaterThan(values[i - 1]!);
      }
      expect(values[values.length - 1]).toBeCloseTo(signal.confidence.value, 3);
    }
  });

  it("derives leadTimeMinutes from firstSeen -> operatorNotified", () => {
    const headline = MOCK_SIGNALS.find((s) => s.id === "SIG-KGL-TRACK-0317");
    expect(headline).toBeDefined();
    if (!headline) return;
    expect(headline.operatorNotifiedAt).not.toBeNull();
    const derived = Math.round(
      (Date.parse(headline.operatorNotifiedAt!) - Date.parse(headline.firstSeenAt)) / 60_000,
    );
    expect(headline.leadTimeMinutes).toBe(derived);
    expect(headline.leadTimeMinutes).toBe(53);
  });

  it("has at least one signal the operator has not acknowledged", () => {
    expect(MOCK_SIGNALS.some((s) => s.operatorNotifiedAt === null)).toBe(true);
  });

  it("counts distinct social authors, never repost volume", () => {
    for (const signal of MOCK_SIGNALS) {
      const distinct = new Set(
        signal.sources
          .filter((s) => s.sourceClass === "SOCIAL")
          .map((s) => s.authorId ?? s.authorHandle ?? s.id),
      );
      expect(signal.corroboratingSources.socialDistinctAuthors).toBeLessThanOrEqual(
        distinct.size,
      );
    }
  });
});

describe("risk overlay", () => {
  it("marks cached overlays stale and reports the age", () => {
    const cached = dataSource.getOverlay("cache");
    expect(cached.source).toBe("cache");
    expect(cached.isStale).toBe(true);
    expect(cached.stalenessMinutes).toBeGreaterThan(0);
    expect(cached.segments.every((s) => s.stale)).toBe(true);
  });

  it("reports a live overlay as fresh", () => {
    const live = dataSource.getOverlay("live");
    expect(live.source).toBe("live");
    expect(live.isStale).toBe(false);
    expect(live.stalenessMinutes).toBe(0);
  });

  it("carries a degradation probability and a confidence for every risky segment", () => {
    for (const risk of dataSource.getOverlay("cache").segments) {
      expect(risk.degradationProbability).toBeGreaterThan(0);
      expect(risk.degradationProbability).toBeLessThanOrEqual(1);
      expect(risk.confidence).toBeGreaterThan(0);
      expect(risk.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("the demo trip: KL Sentral -> Kajang", () => {
  const query = buildRouteQuery(DEFAULT_ORIGIN_STATION_ID, DEFAULT_DESTINATION_STATION_ID);
  const advisory = dataSource.planRoute(query, "cache");

  it("returns more than one genuinely distinct itinerary", () => {
    expect(advisory.itineraries.length).toBeGreaterThanOrEqual(2);
    const signatures = advisory.itineraries.map((i) =>
      i.legs.flatMap((leg) => leg.segmentIds).sort().join("|"),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("ranks by reliability first", () => {
    const scores = advisory.itineraries.map((i) => i.reliabilityScore);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
    expect(advisory.itineraries.map((i) => i.rank)).toEqual(
      advisory.itineraries.map((_, index) => index + 1),
    );
  });

  it("puts a non-AVOID route first and an AVOID route below it", () => {
    const [top, ...rest] = advisory.itineraries;
    expect(top?.reliabilityBadge).not.toBe("AVOID");
    expect(rest.some((i) => i.reliabilityBadge === "AVOID")).toBe(true);
  });

  it("THE HEADLINE: the quickest option is NOT the recommended one", () => {
    // "Quickest" by MEAN duration — the number a naive app would lead with.
    const quickest = [...advisory.itineraries].sort(
      (a, b) => a.totalDurationSeconds - b.totalDurationSeconds,
    )[0];
    expect(quickest).toBeDefined();
    expect(quickest?.id).not.toBe(advisory.recommendedItineraryId);
    expect(advisory.itineraries[0]?.id).toBe(advisory.recommendedItineraryId);
  });

  it("makes the quickest option the one that crosses the confirmed fault", () => {
    const quickest = [...advisory.itineraries].sort(
      (a, b) => a.totalDurationSeconds - b.totalDurationSeconds,
    )[0];
    expect(quickest?.riskySegmentIds).toContain("KGL:KG17->KG18A");
    expect(quickest?.maxDegradationProbability).toBeGreaterThanOrEqual(0.7);
    expect(quickest?.reliabilityBadge).toBe("AVOID");
  });

  it("THE POINT OF P90: the quickest option has the WORSE P90 arrival", () => {
    // This is the product thesis falling out of real data rather than a fixture:
    // the route with the better average arrival has the worse tail, because the
    // disruption inflates its variance. Sorting on speed would pick the wrong one.
    const quickest = [...advisory.itineraries].sort(
      (a, b) => a.totalDurationSeconds - b.totalDurationSeconds,
    )[0];
    const recommended = advisory.itineraries[0];
    expect(quickest).toBeDefined();
    expect(recommended).toBeDefined();
    if (!quickest || !recommended) return;
    expect(quickest.totalDurationSeconds).toBeLessThan(recommended.totalDurationSeconds);
    expect(quickest.arrival.p90Seconds).toBeGreaterThan(recommended.arrival.p90Seconds);
    expect(quickest.arrival.meanToP90GapSeconds).toBeGreaterThan(
      recommended.arrival.meanToP90GapSeconds,
    );
  });

  it("reports a P90 window strictly wider than the mean on a risky route", () => {
    const top = advisory.itineraries[0];
    expect(top).toBeDefined();
    if (!top) return;
    expect(top.arrival.p90Seconds).toBeGreaterThan(top.arrival.meanSeconds);
    expect(top.arrival.meanToP90GapSeconds).toBeGreaterThan(0);
    expect(top.arrival.p10Seconds).toBeLessThanOrEqual(top.arrival.p50Seconds);
    expect(top.arrival.p50Seconds).toBeLessThanOrEqual(top.arrival.p90Seconds);
  });

  it("explains rank 1 in plain language", () => {
    expect(advisory.itineraries[0]?.whyThisRank.length).toBeGreaterThan(10);
  });

  it("always states the most likely reason the recommendation is wrong", () => {
    expect(advisory.whyThisCouldBeWrong.length).toBeGreaterThan(20);
  });

  it("names the signals that influenced the ranking", () => {
    expect(advisory.consideredSignals.length).toBeGreaterThan(0);
    for (const considered of advisory.consideredSignals) {
      expect(considered.segmentIds.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const again = dataSource.planRoute(query, "cache");
    expect(again.itineraries.map((i) => i.id)).toEqual(
      advisory.itineraries.map((i) => i.id),
    );
    expect(again.id).toBe(advisory.id);
  });

  it("flags the advisory as computed offline when served from cache", () => {
    expect(advisory.computedOffline).toBe(true);
    expect(advisory.riskAsOf).toBe(dataSource.getOverlay("cache").asOf);
  });

  it("plans a route for an arbitrary pair, not just the demo one", () => {
    const other = dataSource.planRoute(buildRouteQuery("KJ1", "KJ37"), "cache");
    expect(other.itineraries.length).toBeGreaterThan(0);
    expect(other.itineraries[0]?.legs.length).toBeGreaterThan(0);
  });

  it("degrades gracefully when origin equals destination", () => {
    const same = dataSource.planRoute(buildRouteQuery("KJ15", "KJ15"), "cache");
    expect(same.itineraries).toEqual([]);
    expect(same.recommendedItineraryId).toBeNull();
    expect(same.fallback).not.toBeNull();
  });
});

describe("source inspector", () => {
  it("traces a signal from evidence to route decision", () => {
    const trace = dataSource.getSourceTrace("SIG-KGL-TRACK-0317");
    expect(trace).not.toBeNull();
    if (!trace) return;
    expect(trace.steps.length).toBeGreaterThanOrEqual(5);
    expect(trace.confidenceByHop).toHaveLength(4);
    expect(trace.claim).toContain("Merdeka");
    for (const step of trace.steps) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(10);
      expect(step.confidence).toBeGreaterThan(0);
    }
  });

  it("returns null for an unknown signal", () => {
    expect(dataSource.getSourceTrace("NOPE")).toBeNull();
  });

  it("builds a trace for every fixture signal", () => {
    const topology = loadTopology();
    const lookup = overlayLookup(mockRiskOverlay({ mode: "cache" }));
    for (const signal of MOCK_SIGNALS) {
      const trace = buildSourceTrace(signal, topology, lookup);
      expect(trace.signalId).toBe(signal.id);
      expect(trace.steps.length).toBeGreaterThan(0);
    }
  });
});

describe("reconnect reconciliation", () => {
  it("returns everything for an epoch cursor", () => {
    const result = dataSource.reconcile(new Date(0).toISOString());
    expect(result.changedSignals).toHaveLength(MOCK_SIGNALS.length);
    expect(result.newSignalIds).toHaveLength(MOCK_SIGNALS.length);
    expect(result.overlay.segments.length).toBeGreaterThan(0);
  });

  it("returns nothing changed for a future cursor", () => {
    const result = dataSource.reconcile("2099-01-01T00:00:00.000Z");
    expect(result.changedSignals).toEqual([]);
    expect(result.newSignalIds).toEqual([]);
  });
});

describe("API envelope metadata", () => {
  it("reports the contracts version so a stale client can detect a mismatch", () => {
    expect(dataSource.apiMeta("cache").contractsVersion).toBe(CONTRACTS_VERSION);
  });

  it("marks cached responses as cached and carries the as-of pair", () => {
    const meta = dataSource.apiMeta("cache");
    expect(meta.cached).toBe(true);
    expect(meta.stalenessMinutes).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(meta.asOf))).toBe(true);
  });

  it("marks live responses as not cached and zero-staleness", () => {
    const meta = dataSource.apiMeta("live");
    expect(meta.cached).toBe(false);
    expect(meta.stalenessMinutes).toBe(0);
  });
});

describe("the live adapter is real, not a stub", () => {
  it("produces the same advisory shape when given the mock functions", () => {
    const topology = loadTopology();
    const overlay: RiskOverlay = mockRiskOverlay({ mode: "cache" });
    const lookup: SegmentRiskLookup = overlayLookup(overlay);
    const network = dataSource.getNetwork();

    const live = createLiveDataSource({
      planJourneys: ({ query, riskLookup }) =>
        planMockJourneys({ graph: topology.graph, query, riskLookup }),
      getNetwork: () => network,
      getSignals: () => MOCK_SIGNALS as DisruptionSignal[],
      getOverlay: () => overlay,
      getSourceTrace: (signalId) => dataSource.getSourceTrace(signalId),
      describeTopology: () => ({ source: topology.source, path: topology.path }),
    });

    expect(live.kind).toBe("live");
    expect(live.meta().stationCount).toBe(network.stations.length);

    const query = buildRouteQuery(
      DEFAULT_ORIGIN_STATION_ID,
      DEFAULT_DESTINATION_STATION_ID,
    );
    const advisory = live.planRoute(query, "cache");
    expect(advisory.itineraries.length).toBeGreaterThanOrEqual(2);
    expect(advisory.recommendedItineraryId).toBe(advisory.itineraries[0]?.id);
    expect(advisory.itineraries[0]?.reliabilityBadge).not.toBe("AVOID");
    expect(live.getSourceTrace("SIG-KGL-TRACK-0317")).not.toBeNull();
    expect(live.apiMeta("cache").cached).toBe(true);
    void lookup;
  });

  it("the mock source and the seam binding are the same object contract", () => {
    const mock = createMockDataSource();
    expect(Object.keys(mock).sort()).toEqual(Object.keys(dataSource).sort());
    expect(dataSource.kind).toBe("mock");
  });
});
