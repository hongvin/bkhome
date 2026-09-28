"use client";

/**
 * A route card — screen B.
 *
 * Order of information is deliberate and matches the product thesis:
 *   1. reliability badge and rank (the ranking key),
 *   2. the P90 arrival window (the headline number),
 *   3. the typical duration beside it,
 *   4. segment risk chips,
 *   5. WHY this itinerary sits at this rank — mandatory for rank 1.
 * Raw speed never leads.
 */
import type {
  Itinerary,
  Line,
  Segment,
  SegmentRisk,
  SegmentId,
  Station,
  StationId,
} from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import {
  formatArrivalWindow,
  formatClockOfDay,
  formatDuration,
  formatTransfers,
} from "@/components/lib/format";
import { explainRank } from "@/components/lib/ranking";
import { describeSegment, lineLabel } from "@/components/lib/describe";
import { touchStyle } from "@/components/lib/touch";
import { CARD } from "@/components/ui/tokens";
import { ReliabilityBadgePill, RiskChip } from "@/components/ui/atoms";

export interface RouteCardProps {
  itinerary: Itinerary;
  all: Itinerary[];
  riskBySegment: ReadonlyMap<SegmentId, SegmentRisk>;
  segmentById: ReadonlyMap<SegmentId, Segment>;
  stationById: ReadonlyMap<StationId, Station>;
  lines: Line[];
  selected: boolean;
  onSelect: (itineraryId: string) => void;
  /** Opens screen E for the signal behind a segment. */
  onExplainSegment: (segmentId: SegmentId) => void;
  confidenceReduced: boolean;
}

export function RouteCard({
  itinerary,
  all,
  riskBySegment,
  segmentById,
  stationById,
  lines,
  selected,
  onSelect,
  onExplainSegment,
  confidenceReduced,
}: RouteCardProps) {
  const { locale, t } = useLocale();
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const explanation = explainRank(itinerary, {
    all,
    riskLookup: (segmentId) => riskBySegment.get(segmentId),
    t,
  });

  const rideLegs = itinerary.legs.filter((leg) => leg.kind === "RIDE");
  const lineChips = rideLegs.map((leg) => ({
    lineId: leg.lineId,
    color: leg.lineId ? `#${lineById.get(leg.lineId)?.color ?? "64748b"}` : "#64748b",
    label: leg.lineId ? lineLabel(leg.lineId, lineById, locale) : "",
    short: leg.lineId ? lineById.get(leg.lineId)?.shortName ?? leg.lineId : "",
  }));

  const risky = itinerary.riskySegmentIds
    .map((segmentId) => riskBySegment.get(segmentId))
    .filter((risk): risk is SegmentRisk => risk !== undefined)
    .sort((a, b) => b.degradationProbability - a.degradationProbability)
    .slice(0, 3);

  const isTop = itinerary.rank === 1;

  return (
    <article
      data-testid="route-card"
      data-rank={itinerary.rank}
      data-itinerary-id={itinerary.id}
      data-selected={selected ? "true" : "false"}
      data-reliability={itinerary.reliabilityBadge}
      className={`${CARD} p-3.5 transition-colors ${
        isTop ? "border-emerald-400/25 bg-emerald-400/[0.04]" : ""
      } ${selected ? "ring-2 ring-cyan-400/60" : ""}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums ${
              isTop ? "bg-emerald-400 text-slate-950" : "bg-white/10 text-slate-200"
            }`}
          >
            {itinerary.rank}
          </span>
          <div className="min-w-0">
            <ReliabilityBadgePill badge={itinerary.reliabilityBadge} />
            {isTop ? (
              <p className="mt-1 truncate text-[10px] font-semibold uppercase tracking-wider text-emerald-300/90">
                {t("results.topOption")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-semibold leading-none tabular-nums text-slate-50">
            {formatDuration(itinerary.totalDurationSeconds, locale)}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-slate-400">
            {t("results.typical")}
          </p>
        </div>
      </header>

      {/* P90 — the headline number, given its own row. */}
      <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            {t("results.p90")}
          </span>
          <span className="text-sm font-semibold tabular-nums text-amber-200">
            {t("results.p90Label", { time: formatClockOfDay(itinerary.arrival.p90Seconds) })}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span className="tabular-nums">
            {t("results.window", {
              p50: formatClockOfDay(itinerary.arrival.p50Seconds),
              p90: formatClockOfDay(itinerary.arrival.p90Seconds),
            })}
          </span>
          <span className="tabular-nums">
            {itinerary.expectedDelaySeconds >= 60
              ? t("results.expectedDelay", {
                  min: Math.round(itinerary.expectedDelaySeconds / 60),
                })
              : t("results.onTime")}
          </span>
        </div>
      </div>

      {/* Line + transfer summary */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {lineChips.map((chip, index) => (
          <span
            key={`${chip.lineId ?? "walk"}-${index}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-slate-300"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: chip.color }}
              aria-hidden
            />
            {chip.short || t("results.fallback")}
          </span>
        ))}
        <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300">
          {formatTransfers(itinerary.transferCount, locale)}
        </span>
      </div>

      {/* Segment risk chips — each one is a real button into the inspector. */}
      <div className="mt-3">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {t("results.risk")}
        </p>
        {risky.length === 0 ? (
          <p className="text-[11px] text-slate-400">{t("results.noRisk")}</p>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            {risky.map((risk) => (
              <RiskChip
                key={risk.segmentId}
                risk={risk}
                reduced={confidenceReduced}
                segmentLabel={describeSegment(
                  risk.segmentId,
                  segmentById,
                  stationById,
                  locale,
                )}
                onExplain={() => onExplainSegment(risk.segmentId)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Why this rank. Rank 1 must always explain itself. */}
      <div
        data-testid="why-this-rank"
        className={`mt-3 rounded-xl border px-3 py-2 ${
          isTop
            ? "border-emerald-400/20 bg-emerald-400/[0.06]"
            : "border-white/10 bg-white/[0.02]"
        }`}
      >
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {isTop ? t("results.whyTop") : t("results.whyThisRank")}
        </p>
        <p className="mt-1 text-[12px] leading-snug text-slate-200">
          {explanation.headline}
        </p>
        {explanation.details.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {explanation.details.map((detail, index) => (
              <li key={index} className="text-[11px] leading-snug text-slate-400">
                · {detail}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <button
        type="button"
        data-no-drag
        data-testid="route-select"
        onClick={() => onSelect(itinerary.id)}
        style={touchStyle("routeCardSelect")}
        aria-pressed={selected}
        className={`mt-3 w-full rounded-xl px-4 text-sm font-semibold active:opacity-80 ${
          selected
            ? "bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-400/40"
            : "bg-white/[0.07] text-slate-100 ring-1 ring-white/10"
        }`}
      >
        {selected ? t("results.selected") : t("results.select")}
      </button>
    </article>
  );
}
