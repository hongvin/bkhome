"use client";

/**
 * The sheet's scrollable content: route options (screen B) followed by the
 * disruption feed (screen D). Both live in the same column so a single upward
 * drag moves the rider from "which route" to "why".
 */
import type {
  DisruptionSignal,
  Itinerary,
  Line,
  RouteAdvisory,
  Segment,
  SegmentRisk,
  SegmentId,
  Station,
  StationId,
} from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import { DisruptionCard } from "@/components/DisruptionCard";
import { RouteCard } from "@/components/RouteCard";
import { CARD } from "@/components/ui/tokens";

export interface RouteResultsProps {
  advisory: RouteAdvisory | null;
  loading: boolean;
  error: string | null;
  signals: DisruptionSignal[];
  lines: Line[];
  segmentById: ReadonlyMap<SegmentId, Segment>;
  stationById: ReadonlyMap<StationId, Station>;
  riskBySegment: ReadonlyMap<SegmentId, SegmentRisk>;
  selectedItineraryId: string | null;
  confidenceReduced: boolean;
  onSelect: (itineraryId: string) => void;
  onExplainSegment: (segmentId: SegmentId) => void;
  onExplainSignal: (signalId: string) => void;
  onRetry: () => void;
}

export function RouteResults({
  advisory,
  loading,
  error,
  signals,
  lines,
  segmentById,
  stationById,
  riskBySegment,
  selectedItineraryId,
  confidenceReduced,
  onSelect,
  onExplainSegment,
  onExplainSignal,
  onRetry,
}: RouteResultsProps) {
  const { locale, t } = useLocale();
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const itineraries: Itinerary[] = advisory?.itineraries ?? [];

  const selected = itineraries.find((i) => i.id === selectedItineraryId) ?? itineraries[0];
  const selectedSegments = new Set(selected?.legs.flatMap((leg) => leg.segmentIds) ?? []);

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3.5 pt-0">
      {error ? (
        <div className={`${CARD} px-3 py-3`}>
          <p className="text-[12px] text-rose-200">{t("common.error")}</p>
          <p className="mt-1 break-words text-[11px] text-slate-400">{error}</p>
          <button
            type="button"
            data-no-drag
            onClick={onRetry}
            className="mt-2 h-11 w-full rounded-xl bg-white/[0.07] text-[12px] font-semibold text-slate-100 ring-1 ring-white/10 active:opacity-80"
          >
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">{t("results.title")}</h2>
        <span className="text-[11px] text-slate-400">
          {loading
            ? t("common.loading")
            : itineraries.length === 1
              ? t("results.countOne")
              : t("results.count", { count: itineraries.length })}
        </span>
      </div>

      {itineraries.length === 0 && !loading ? (
        <p className={`${CARD} px-3 py-4 text-center text-[12px] text-slate-400`}>
          {t("results.empty")}
        </p>
      ) : null}

      {advisory?.noSafeAlternative ? (
        <p
          data-testid="no-safe-alternative"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] leading-snug text-rose-100"
        >
          {t("results.noSafeAlternative")}
        </p>
      ) : null}

      {itineraries.map((itinerary) => (
        <RouteCard
          key={itinerary.id}
          itinerary={itinerary}
          all={itineraries}
          riskBySegment={riskBySegment}
          segmentById={segmentById}
          stationById={stationById}
          lines={lines}
          selected={selected?.id === itinerary.id}
          onSelect={onSelect}
          onExplainSegment={onExplainSegment}
          confidenceReduced={confidenceReduced}
        />
      ))}

      {advisory?.fallback ? (
        <div className={`${CARD} px-3 py-2.5`}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {t("results.fallback")}
          </p>
          <p className="mt-1 break-words text-[12px] text-slate-100">
            {advisory.fallback.description}
          </p>
          <p className="mt-1 break-words text-[11px] text-slate-400">
            {advisory.fallback.note}
          </p>
        </div>
      ) : null}

      {advisory?.whyThisCouldBeWrong ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {t("results.whyWrong")}
          </p>
          <p className="mt-1 break-words text-[11px] leading-snug text-slate-300">
            {advisory.whyThisCouldBeWrong}
          </p>
        </div>
      ) : null}

      {advisory?.computedOffline ? (
        <p className="text-[10px] text-amber-300/80">{t("results.computedOffline")}</p>
      ) : null}

      {/* ---------------- disruption feed ---------------- */}
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          {signals.length === 1 ? t("alert.title") : t("alert.titlePlural")}
        </h2>
        <span className="text-[11px] text-slate-400">{signals.length}</span>
      </div>

      {signals.length === 0 ? (
        <div className={`${CARD} px-3 py-4 text-center`}>
          <p className="text-[12px] text-slate-200">{t("alert.none")}</p>
          <p className="mt-1 text-[11px] text-slate-400">{t("alert.noneBody")}</p>
        </div>
      ) : (
        signals.map((signal) => (
          <DisruptionCard
            key={signal.id}
            signal={signal}
            segmentById={segmentById}
            stationById={stationById}
            lineById={lineById}
            confidenceReduced={confidenceReduced}
            affectsSelectedRoute={signal.segmentIds.some((id) => selectedSegments.has(id))}
            onExplain={onExplainSignal}
          />
        ))
      )}

      <p className="pb-1 text-center text-[9px] text-slate-600">
        {t("map.attribution")}: OpenStreetMap · CARTO · {locale.toUpperCase()}
      </p>
    </div>
  );
}
