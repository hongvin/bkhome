/**
 * Live integration adapter — the other side of the seam in `./index.ts`.
 *
 * This is NOT a stub: every method is implemented. It takes S1's router, S3's
 * signal accessors and S4's overlay builder by INJECTION rather than by import,
 * because importing `lib/routing`, `lib/signals` or `lib/risk` directly would
 * couple the UI build to modules still under construction in parallel.
 *
 * At integration, `lib/mock/index.ts` changes one line:
 *
 *   export const dataSource: TransitDataSource = createMockDataSource();
 * ->
 *   export const dataSource: TransitDataSource =
 *     createLiveDataSource({ planJourneys, getSignals, getOverlay, getSourceTrace });
 *
 * where those four come from S1/S3/S4. Nothing in `app/**` or `components/**`
 * changes, because both implementations satisfy `TransitDataSource`.
 */
import type {
  ApiMeta,
  DisruptionSignal,
  PlanJourneysFn,
  ReconcileResponse,
  RiskOverlay,
  RouteAdvisory,
  RouteQuery,
  SegmentRiskLookup,
  SourceInspectorTrace,
} from "@/lib/contracts";
import { CONTRACTS_VERSION } from "@/lib/contracts";

import { assembleAdvisory } from "./routing";
import { loadTopology } from "./graph";
import { apiMetaFor, type DataMode, type DataSourceMeta, type NetworkPayload, type TransitDataSource } from "./index";

export interface LiveDataSourceDeps {
  /** S1 — the frequency-expanding CSA router. */
  planJourneys: PlanJourneysFn;
  /** S1 — the built graph, already loaded (the UI must not read files itself). */
  getNetwork: () => NetworkPayload;
  /** S3 — active signals. */
  getSignals: () => DisruptionSignal[];
  /** S4 — the risk overlay. */
  getOverlay: (mode: DataMode) => RiskOverlay;
  /** S3/S4 — the Source Inspector trace for one signal. */
  getSourceTrace: (signalId: string) => SourceInspectorTrace | null;
  /** Optional provenance for the diagnostics payload. */
  describeTopology?: () => { source: "artifact" | "fixture"; path: string };
}

export function createLiveDataSource(deps: LiveDataSourceDeps): TransitDataSource {
  const lookupFor = (mode: DataMode): SegmentRiskLookup => {
    const overlay = deps.getOverlay(mode);
    const index = new Map(overlay.segments.map((s) => [s.segmentId, s]));
    return (segmentId) => index.get(segmentId);
  };

  return {
    id: "live-v1",
    kind: "live",

    meta(): DataSourceMeta {
      const network = deps.getNetwork();
      const topology = deps.describeTopology?.() ?? {
        source: "artifact" as const,
        path: "public/graph/transit-graph.json",
      };
      return {
        kind: "live",
        topologySource: topology.source,
        topologyPath: topology.path,
        stationCount: network.stations.length,
        segmentCount: network.segments.length,
        lineCount: network.lines.length,
        signalCount: deps.getSignals().length,
        notes: ["Served by the live S1 router, S3 signals and S4 risk model."],
      };
    },

    getNetwork(): NetworkPayload {
      return deps.getNetwork();
    },

    getSignals(): DisruptionSignal[] {
      return deps.getSignals();
    },

    getSignal(id: string): DisruptionSignal | undefined {
      return deps.getSignals().find((s) => s.id === id);
    },

    getOverlay(mode: DataMode): RiskOverlay {
      return deps.getOverlay(mode);
    },

    planRoute(query: RouteQuery, mode: DataMode): RouteAdvisory {
      const overlay = deps.getOverlay(mode);
      const topology = loadTopology();
      const itineraries = deps.planJourneys({
        graph: topology.graph,
        query,
        riskLookup: lookupFor(mode),
      });
      return assembleAdvisory(itineraries, {
        query,
        riskLookup: lookupFor(mode),
        riskAsOf: overlay.asOf,
        computedOffline: mode === "cache",
        topology,
      });
    },

    getSourceTrace(signalId: string): SourceInspectorTrace | null {
      return deps.getSourceTrace(signalId);
    },

    reconcile(since: string): ReconcileResponse {
      const sinceMs = Date.parse(since);
      const valid = Number.isFinite(sinceMs);
      const signals = deps.getSignals();
      const changedSignals = valid
        ? signals.filter((s) => Date.parse(s.updatedAt) > sinceMs)
        : signals;
      return {
        changedSignals,
        clearedSignalIds: signals
          .filter((s) => s.status === "CLEARED" || s.status === "REJECTED")
          .map((s) => s.id),
        newSignalIds: valid
          ? signals.filter((s) => Date.parse(s.createdAt) > sinceMs).map((s) => s.id)
          : signals.map((s) => s.id),
        overlay: deps.getOverlay("cache"),
        serverTime: new Date().toISOString(),
      };
    },

    apiMeta(mode: DataMode): ApiMeta {
      const meta = apiMetaFor(deps.getOverlay(mode), mode);
      return { ...meta, contractsVersion: CONTRACTS_VERSION };
    },
  };
}
