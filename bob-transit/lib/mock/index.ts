/**
 * ============================================================================
 *  INTEGRATION SEAM
 * ============================================================================
 *
 * `app/api/**` imports `dataSource` from this module and NOTHING else from the
 * mock layer. That is the whole point of this file: the UI talks to one
 * interface, and the implementation behind it is swappable in one line.
 *
 * The line to change is at the bottom of this file:
 *
 *     export const dataSource: TransitDataSource = createMockDataSource();
 *
 * becomes
 *
 *     export const dataSource: TransitDataSource =
 *       createLiveDataSource({ planJourneys, getSignals, getOverlay, getSourceTrace });
 *
 * with S1's `PlanJourneysFn`, S3's signal accessors and S4's overlay builder
 * passed in. `createLiveDataSource` is implemented in `./source-live.ts` — it is
 * real code, not a stub; it takes those functions by injection precisely because
 * importing S1/S3/S4 directly would break the parallel build.
 *
 * Network topology is ALREADY shared, not mocked: `./graph.ts` loads
 * `public/graph/transit-graph.json` (S1's real artifact) first and only falls
 * back to `lib/mock/fixtures/network.json` when that file does not exist yet.
 * So the UI and the router cannot disagree about the network.
 * ============================================================================
 */
import type {
  ApiMeta,
  DisruptionSignal,
  Line,
  ReconcileResponse,
  RiskOverlay,
  RouteAdvisory,
  RouteQuery,
  Segment,
  SegmentRiskLookup,
  SourceInspectorTrace,
  Station,
} from "@/lib/contracts";
import { CONTRACTS_VERSION } from "@/lib/contracts";

import {
  DEMO_NOW_MS,
  DEMO_STALENESS_MINUTES,
  demoNowIso,
  localSecondsOfDay,
  localWeekday,
  toKlIso,
} from "./clock";
import { loadTopology, type LoadedTopology, type TopologySource } from "./graph";
import { mockRiskOverlay, overlayLookup } from "./risk";
import { planMockAdvisory, planMockJourneys } from "./routing";
import { MOCK_SIGNALS, mockSignalById } from "./signals";
import { buildSourceTrace } from "./traces";

export type DataMode = "cache" | "live";

/** The default demo trip: KL Sentral to Kajang — the fastest route is the risky one. */
export const DEFAULT_ORIGIN_STATION_ID = "KJ15";
export const DEFAULT_DESTINATION_STATION_ID = "KG35";

export interface DataSourceMeta {
  kind: "mock" | "live";
  /** Where the network topology actually came from. */
  topologySource: TopologySource;
  topologyPath: string;
  stationCount: number;
  segmentCount: number;
  lineCount: number;
  signalCount: number;
  notes: string[];
}

export interface NetworkPayload {
  lines: Line[];
  stations: Station[];
  segments: Segment[];
}

export interface TransitDataSource {
  readonly id: string;
  readonly kind: "mock" | "live";
  meta(): DataSourceMeta;
  getNetwork(): NetworkPayload;
  getSignals(): DisruptionSignal[];
  getSignal(id: string): DisruptionSignal | undefined;
  getOverlay(mode: DataMode): RiskOverlay;
  planRoute(query: RouteQuery, mode: DataMode): RouteAdvisory;
  getSourceTrace(signalId: string): SourceInspectorTrace | null;
  reconcile(since: string): ReconcileResponse;
  apiMeta(mode: DataMode): ApiMeta;
}

export function buildRouteQuery(
  originStationId: string,
  destinationStationId: string,
  nowMs: number = DEMO_NOW_MS,
): RouteQuery {
  return {
    originStationId,
    destinationStationId,
    departAfterSeconds: localSecondsOfDay(nowMs),
    serviceWeekday: localWeekday(nowMs),
    maxItineraries: 3,
    maxInitialWaitSeconds: 900,
    maxTransfers: 2,
  };
}

export function apiMetaFor(overlay: RiskOverlay, mode: DataMode): ApiMeta {
  return {
    generatedAt: demoNowIso(),
    cached: mode === "cache",
    asOf: overlay.asOf,
    stalenessMinutes: overlay.stalenessMinutes,
    contractsVersion: CONTRACTS_VERSION,
  };
}

/** segment id -> the fixture signal that explains it. */
export function mockSegmentSignalIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const signal of MOCK_SIGNALS) {
    for (const segmentId of signal.segmentIds) {
      const existing = index.get(segmentId);
      if (!existing) index.set(segmentId, signal.id);
    }
  }
  return index;
}

/* ------------------------------------------------------------------ */
/* Mock implementation                                                 */
/* ------------------------------------------------------------------ */

export function createMockDataSource(): TransitDataSource {
  let topology: LoadedTopology | null = null;
  const topo = (): LoadedTopology => {
    if (!topology) topology = loadTopology();
    return topology;
  };

  const lookupFor = (mode: DataMode): SegmentRiskLookup =>
    overlayLookup(mockRiskOverlay({ mode }));

  return {
    id: "mock-fixture-v1",
    kind: "mock",

    meta(): DataSourceMeta {
      const t = topo();
      return {
        kind: "mock",
        topologySource: t.source,
        topologyPath: t.path,
        stationCount: t.graph.stations.length,
        segmentCount: t.graph.segments.length,
        lineCount: t.graph.lines.length,
        signalCount: MOCK_SIGNALS.length,
        notes: [
          t.source === "artifact"
            ? "Network topology read from the real public/graph/transit-graph.json artifact."
            : "Network topology read from the committed offline fallback (public/graph/transit-graph.json not built yet).",
          "Disruption signals and the risk overlay are hand-authored fixtures anchored to a fixed demo instant.",
          "Routing is a real Dijkstra over the real topology, but it is not timetable-exact: S1's frequency-expanding CSA replaces planMockJourneys at integration.",
        ],
      };
    },

    getNetwork(): NetworkPayload {
      const t = topo();
      return {
        lines: t.graph.lines,
        stations: t.graph.stations,
        segments: t.graph.segments,
      };
    },

    getSignals(): DisruptionSignal[] {
      return MOCK_SIGNALS;
    },

    getSignal(id: string): DisruptionSignal | undefined {
      return mockSignalById(id);
    },

    getOverlay(mode: DataMode): RiskOverlay {
      return mockRiskOverlay({ mode });
    },

    planRoute(query: RouteQuery, mode: DataMode): RouteAdvisory {
      const overlay = mockRiskOverlay({ mode });
      return planMockAdvisory({
        query,
        riskLookup: overlayLookup(overlay),
        riskAsOf: overlay.asOf,
        computedOffline: mode === "cache",
        topology: topo(),
        signalIndex: mockSegmentSignalIndex(),
      });
    },

    getSourceTrace(signalId: string): SourceInspectorTrace | null {
      const signal = mockSignalById(signalId);
      if (!signal) return null;
      const t = topo();
      return buildSourceTrace(signal, t, lookupFor("cache"));
    },

    reconcile(since: string): ReconcileResponse {
      const sinceMs = Date.parse(since);
      const valid = Number.isFinite(sinceMs);
      const changedSignals = valid
        ? MOCK_SIGNALS.filter((s) => Date.parse(s.updatedAt) > sinceMs)
        : MOCK_SIGNALS;
      const newSignalIds = valid
        ? MOCK_SIGNALS.filter((s) => Date.parse(s.createdAt) > sinceMs).map((s) => s.id)
        : MOCK_SIGNALS.map((s) => s.id);
      const changedIds = new Set(changedSignals.map((s) => s.id));
      const clearedSignalIds = MOCK_SIGNALS.filter(
        (s) => (s.status === "CLEARED" || s.status === "REJECTED") && !changedIds.has(s.id),
      ).map((s) => s.id);

      return {
        changedSignals,
        clearedSignalIds,
        newSignalIds,
        overlay: mockRiskOverlay({ mode: "cache" }),
        serverTime: toKlIso(DEMO_NOW_MS),
      };
    },

    apiMeta(mode: DataMode): ApiMeta {
      return apiMetaFor(mockRiskOverlay({ mode }), mode);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Re-exports the API routes need                                      */
/* ------------------------------------------------------------------ */

export { planMockJourneys, DEMO_STALENESS_MINUTES };
export type { TopologySource };

/**
 * Re-exported so the swap below really is ONE line: the import already exists.
 * (The dependency is type-only in the other direction, so there is no runtime
 * import cycle.)
 */
export { createLiveDataSource } from "./source-live";
export type { LiveDataSourceDeps } from "./source-live";

/* ==================================================================== */
/* ====  THE ONE LINE. Change this at integration.  ================== */
/* ==================================================================== */

export const dataSource: TransitDataSource = createMockDataSource();
