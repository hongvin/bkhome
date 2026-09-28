"use client";

/**
 * TransitApp — the whole product surface.
 *
 * Layout contract (enforced at every viewport, verified at 375px):
 *   - the map is full-bleed and sits behind everything;
 *   - there is NO top navigation bar;
 *   - the only chrome is the draggable bottom sheet, plus two small status
 *     chips over the map (freshness/offline) and a floating locate control;
 *   - the primary CTA is pinned to the bottom of the sheet, so it is inside the
 *     bottom ~15-20% of the viewport at every detent.
 *
 * Data flows one way: this component fetches from `app/api/**`, which reads
 * from the `lib/mock` seam. Nothing here imports the mock layer directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ApiMeta,
  DisruptionSignal,
  Line,
  RiskOverlay,
  RouteAdvisory,
  Segment,
  SegmentId,
  SegmentRisk,
  SourceInspectorTrace,
  Station,
  StationId,
} from "@/lib/contracts";

import { BottomSheet } from "@/components/BottomSheet";
import { LocaleProvider, useLocale } from "@/components/LocaleProvider";
import { MapCanvas } from "@/components/MapCanvas";
import { SourceInspector } from "@/components/SourceInspector";
import { StalenessChip } from "@/components/StalenessBanner";
import { StationPicker } from "@/components/StationPicker";
import { RouteResults } from "@/components/screens/RouteResults";
import {
  ApiError,
  fetchNetwork,
  fetchOverlay,
  fetchRoute,
  fetchSignals,
  fetchSourceTrace,
  type NetworkPayloadClient,
} from "@/components/lib/api";
import { segmentToSignalIndex } from "@/components/lib/describe";
import { detentHeightPx } from "@/components/lib/detents";
import { touchStyle } from "@/components/lib/touch";
import { useSheetDrag } from "@/components/sheet/useSheetDrag";

type Panel =
  | { kind: "results" }
  | { kind: "picker"; mode: "origin" | "destination" }
  | { kind: "inspector"; signalId: string };

const DEFAULT_VIEWPORT_HEIGHT = 812;

export function TransitApp() {
  return (
    <LocaleProvider>
      <TransitAppInner />
    </LocaleProvider>
  );
}

function TransitAppInner() {
  const { t } = useLocale();

  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [network, setNetwork] = useState<NetworkPayloadClient | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [signals, setSignals] = useState<DisruptionSignal[]>([]);
  const [overlay, setOverlay] = useState<RiskOverlay | null>(null);
  const [advisory, setAdvisory] = useState<RouteAdvisory | null>(null);
  const [originId, setOriginId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [selectedItineraryId, setSelectedItineraryId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: "results" });
  const [trace, setTrace] = useState<SourceInspectorTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [recentreToken, setRecentreToken] = useState(0);

  const bootstrapped = useRef(false);
  const sheet = useSheetDrag(viewportHeight);

  /* ---------------- viewport measurement ---------------- */
  useEffect(() => {
    const measure = () => setViewportHeight(window.innerHeight || DEFAULT_VIEWPORT_HEIGHT);
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  /* ---------------- connectivity ---------------- */
  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      setOfflineSince((current) => current ?? Date.now());
    };
    const goOnline = () => {
      setOffline(false);
      setOfflineSince(null);
      setClockTick((n) => n + 1);
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false) goOffline();
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  /* While offline, tick once a minute so "N min ago" keeps climbing. */
  useEffect(() => {
    if (!offline) return;
    const timer = window.setInterval(() => setClockTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [offline]);

  /* ---------------- bootstrap ---------------- */
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    let cancelled = false;

    async function boot() {
      try {
        const [networkResult, signalsResult, overlayResult] = await Promise.all([
          fetchNetwork("cache"),
          fetchSignals("cache"),
          fetchOverlay("cache"),
        ]);
        if (cancelled) return;
        setNetwork(networkResult.data);
        setMeta(networkResult.meta);
        setSignals(signalsResult.data.signals);
        setOverlay(overlayResult.data.overlay);
        setOriginId(networkResult.data.defaultOriginStationId);
        setDestinationId(networkResult.data.defaultDestinationStationId);
      } catch (cause) {
        if (cancelled) return;
        setLoadingRoute(false);
        setError(cause instanceof ApiError ? cause.message : t("common.error"));
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [t]);

  /* ---------------- route planning ---------------- */
  const loadRoute = useCallback(
    async (origin: string, destination: string) => {
      setLoadingRoute(true);
      setError(null);
      try {
        const result = await fetchRoute(origin, destination, "cache");
        setAdvisory(result.data.advisory);
        setMeta(result.meta);
        setSelectedItineraryId((current) => {
          const ids = result.data.advisory.itineraries.map((i) => i.id);
          return current && ids.includes(current)
            ? current
            : (result.data.advisory.recommendedItineraryId ?? ids[0] ?? null);
        });
        setRecentreToken((n) => n + 1);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : t("common.error"));
      } finally {
        setLoadingRoute(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!originId || !destinationId) return;
    if (originId === destinationId) return;
    void loadRoute(originId, destinationId);
  }, [originId, destinationId, loadRoute]);

  /* ---------------- derived ---------------- */
  const lines: Line[] = network?.lines ?? [];
  const stations: Station[] = network?.stations ?? [];
  const segments: Segment[] = network?.segments ?? [];

  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const stationById = useMemo(
    () => new Map(stations.map((s) => [s.id, s])),
    [stations],
  );
  const segmentById = useMemo(
    () => new Map(segments.map((s) => [s.id, s])),
    [segments],
  );
  const riskBySegment = useMemo(
    () => new Map<SegmentId, SegmentRisk>((overlay?.segments ?? []).map((r) => [r.segmentId, r])),
    [overlay],
  );
  const signalBySegment = useMemo(() => segmentToSignalIndex(signals), [signals]);

  const itineraries = advisory?.itineraries ?? [];
  const selectedItinerary =
    itineraries.find((i) => i.id === selectedItineraryId) ?? itineraries[0] ?? null;
  const routeSegmentIds = useMemo(
    () =>
      (selectedItinerary?.legs ?? []).flatMap((leg) =>
        leg.kind === "RIDE" ? leg.segmentIds : [],
      ),
    [selectedItinerary],
  );

  const origin = originId ? stationById.get(originId) : undefined;
  const destination = destinationId ? stationById.get(destinationId) : undefined;

  const confidenceReduced = offline || overlay?.isStale === true;
  const offlineExtraMinutes =
    offlineSince === null ? 0 : Math.max(0, Math.floor((Date.now() - offlineSince) / 60_000));
  void clockTick; // referenced so the minute tick re-renders the chip

  const sheetTopPx = Math.max(0, viewportHeight - sheet.heightPx);

  /* ---------------- actions ---------------- */
  const explainSignal = useCallback(async (signalId: string) => {
    setPanel({ kind: "inspector", signalId });
    setTrace(null);
    setTraceLoading(true);
    try {
      const result = await fetchSourceTrace(signalId);
      setTrace(result.data.trace);
    } catch {
      setTrace(null);
    } finally {
      setTraceLoading(false);
    }
  }, []);

  const explainSegment = useCallback(
    (segmentId: SegmentId) => {
      const signal = signalBySegment.get(segmentId);
      if (signal) {
        void explainSignal(signal.id);
        return;
      }
      // No signal explains this segment: open the inspector with the worst
      // signal on the route so the tap still leads somewhere truthful.
      const fallback = advisory?.consideredSignals[0];
      if (fallback) {
        const match = signals.find((s) =>
          s.segmentIds.some((id) => routeSegmentIds.includes(id)),
        );
        if (match) void explainSignal(match.id);
      }
    },
    [advisory, explainSignal, routeSegmentIds, signalBySegment, signals],
  );

  const onPrimaryAction = useCallback(() => {
    if (panel.kind !== "results") {
      setPanel({ kind: "results" });
      return;
    }
    if (sheet.detent === "peek") {
      sheet.setDetent("half");
      return;
    }
    setRecentreToken((n) => n + 1);
  }, [panel.kind, sheet]);

  const refresh = useCallback(() => {
    if (originId && destinationId) void loadRoute(originId, destinationId);
    void fetchOverlay("cache")
      .then((result) => {
        setOverlay(result.data.overlay);
        setMeta(result.meta);
      })
      .catch(() => undefined);
  }, [destinationId, loadRoute, originId]);

  const inspectorSignal =
    panel.kind === "inspector" ? signals.find((s) => s.id === panel.signalId) ?? null : null;
  const inspectorRouteDecision = useMemo(() => {
    if (!inspectorSignal || !selectedItinerary) return null;
    const touched = inspectorSignal.segmentIds.filter((id) =>
      selectedItinerary.legs.some((leg) => leg.segmentIds.includes(id)),
    );
    if (touched.length === 0) return null;
    return {
      rank: selectedItinerary.rank,
      delayMinutes: Math.max(1, Math.round(selectedItinerary.expectedDelaySeconds / 60)),
    };
  }, [inspectorSignal, selectedItinerary]);

  const primaryLabel =
    panel.kind !== "results"
      ? t("source.back")
      : sheet.detent === "peek"
        ? t("search.cta")
        : t("search.ctaShort");

  return (
    <main
      data-testid="app-root"
      data-viewport-height={viewportHeight}
      data-detent={sheet.detent}
      className="relative h-dvh w-full overflow-hidden bg-[#0b0f14]"
    >
      {/* full-bleed map */}
      <MapCanvas
        lines={lines}
        stations={stations}
        segments={segments}
        risks={overlay?.segments ?? []}
        routeSegmentIds={routeSegmentIds}
        originStationId={originId ?? ""}
        destinationStationId={destinationId ?? ""}
        sheetTopPx={sheetTopPx}
        recentreToken={recentreToken}
      />

      {/* status chips — NOT navigation; freshness disclosure only */}
      <div
        className="pointer-events-none absolute left-3 right-16 z-20"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)" }}
      >
        <div className="pointer-events-auto inline-block max-w-full">
          <StalenessChip
            asOf={meta?.asOf ?? new Date(0).toISOString()}
            stalenessMinutes={meta?.stalenessMinutes ?? 0}
            cached={meta?.cached ?? true}
            offline={offline}
            offlineExtraMinutes={offlineExtraMinutes}
            onRetry={refresh}
          />
        </div>
      </div>

      {/* floating locate control, just above the peek detent */}
      <button
        type="button"
        data-no-drag
        data-testid="map-locate"
        aria-label={t("map.locate")}
        onClick={() => setRecentreToken((n) => n + 1)}
        style={{
          ...touchStyle("mapLocate"),
          bottom: `calc(${detentHeightPx("peek", viewportHeight)}px + env(safe-area-inset-bottom, 0px) + 12px)`,
        }}
        className="absolute right-3 z-20 flex items-center justify-center rounded-2xl border border-white/10 bg-slate-950/80 text-slate-100 shadow-lg backdrop-blur active:bg-slate-800/80"
      >
        <span aria-hidden className="text-lg leading-none">
          ⌖
        </span>
      </button>

      {/* the only chrome */}
      <BottomSheet
        heightPx={sheet.heightPx}
        isDragging={sheet.isDragging}
        dragHandlers={sheet.dragHandlers}
        origin={origin}
        destination={destination}
        onPickOrigin={() => setPanel({ kind: "picker", mode: "origin" })}
        onPickDestination={() => setPanel({ kind: "picker", mode: "destination" })}
        onSwap={() => {
          setOriginId(destinationId);
          setDestinationId(originId);
          setPanel({ kind: "results" });
        }}
        onPrimaryAction={onPrimaryAction}
        primaryLabel={primaryLabel}
        primaryDisabled={!originId || !destinationId || originId === destinationId}
      >
        {panel.kind === "picker" ? (
          <StationPicker
            mode={panel.mode}
            stations={stations}
            lines={lines}
            currentStationId={(panel.mode === "origin" ? originId : destinationId) ?? ""}
            onPick={(stationId) => {
              if (panel.mode === "origin") setOriginId(stationId);
              else setDestinationId(stationId);
              setPanel({ kind: "results" });
              if (sheet.detent === "peek") sheet.setDetent("half");
            }}
            onPickPopular={(nextOrigin, nextDestination) => {
              setOriginId(nextOrigin);
              setDestinationId(nextDestination);
              setPanel({ kind: "results" });
              if (sheet.detent === "peek") sheet.setDetent("half");
            }}
            onCancel={() => setPanel({ kind: "results" })}
          />
        ) : panel.kind === "inspector" ? (
          <SourceInspector
            trace={trace}
            signal={inspectorSignal}
            loading={traceLoading}
            confidenceReduced={confidenceReduced}
            segmentById={segmentById}
            stationById={stationById}
            lineById={lineById}
            routeDecision={inspectorRouteDecision}
            onBack={() => setPanel({ kind: "results" })}
            onClose={() => {
              setPanel({ kind: "results" });
              sheet.setDetent("half");
            }}
          />
        ) : (
          <RouteResults
            advisory={advisory}
            loading={loadingRoute}
            error={error}
            signals={signals}
            lines={lines}
            segmentById={segmentById}
            stationById={stationById}
            riskBySegment={riskBySegment}
            selectedItineraryId={selectedItineraryId}
            confidenceReduced={confidenceReduced}
            onSelect={(itineraryId) => {
              setSelectedItineraryId(itineraryId);
              setRecentreToken((n) => n + 1);
            }}
            onExplainSegment={explainSegment}
            onExplainSignal={(signalId) => void explainSignal(signalId)}
            onRetry={refresh}
          />
        )}
      </BottomSheet>
    </main>
  );
}
