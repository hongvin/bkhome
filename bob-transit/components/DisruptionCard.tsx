"use client";

/**
 * Disruption card — screen D.
 *
 * The `first_seen` -> `operator_notified` delta IS the product, so it gets its
 * own full-width block at the top of the card with the minutes as the largest
 * number on the card. Everything else (severity, confidence, source breakdown)
 * supports that claim.
 */
import type { DisruptionSignal, Line, Segment, Station, StationId } from "@/lib/contracts";
import { confidenceBand } from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import { formatClockFromIso } from "@/components/lib/format";
import { describeSegment, lineLabel } from "@/components/lib/describe";
import { touchStyle } from "@/components/lib/touch";
import { CARD } from "@/components/ui/tokens";
import { ConfidenceMeter, SeverityPill } from "@/components/ui/atoms";

export interface DisruptionCardProps {
  signal: DisruptionSignal;
  segmentById: ReadonlyMap<string, Segment>;
  stationById: ReadonlyMap<StationId, Station>;
  lineById: ReadonlyMap<string, Line>;
  confidenceReduced: boolean;
  /** True when one of this signal's segments is on the selected itinerary. */
  affectsSelectedRoute: boolean;
  onExplain: (signalId: string) => void;
}

export function DisruptionCard({
  signal,
  segmentById,
  stationById,
  lineById,
  confidenceReduced,
  affectsSelectedRoute,
  onExplain,
}: DisruptionCardProps) {
  const { locale, t } = useLocale();
  const confidence = confidenceReduced
    ? signal.confidence.value * 0.6
    : signal.confidence.value;
  const band = confidenceBand(confidence);

  const firstSeen = formatClockFromIso(signal.firstSeenAt);
  const notified =
    signal.operatorNotifiedAt === null
      ? null
      : formatClockFromIso(signal.operatorNotifiedAt);
  const leadMinutes = signal.leadTimeMinutes;

  const location =
    signal.segmentIds.length > 0
      ? signal.segmentIds
          .slice(0, 2)
          .map((segmentId) => describeSegment(segmentId, segmentById, stationById, locale))
          .join(" · ")
      : signal.stationIds.length > 0
        ? `${stationById.get(signal.stationIds[0])?.name ?? signal.stationIds[0]}`
        : t("alert.unresolved");

  const lineNames = signal.lineIds
    .map((lineId) => lineLabel(lineId, lineById, locale))
    .join(" · ");

  return (
    <article
      data-testid="disruption-card"
      data-signal-id={signal.id}
      data-severity={signal.severity}
      data-issue-type={signal.issueType}
      data-on-route={affectsSelectedRoute ? "true" : "false"}
      className={`${CARD} p-3.5 ${affectsSelectedRoute ? "ring-1 ring-cyan-400/30" : ""}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SeverityPill severity={signal.severity} />
          <span className="rounded-full bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-slate-200">
            {t(`issue.${signal.issueType}`)}
          </span>
          <span className="rounded-full bg-white/[0.04] px-2 py-1 text-[10px] uppercase tracking-wider text-slate-400">
            {t(`status.${signal.status}`)}
          </span>
        </div>
        {affectsSelectedRoute ? (
          <span className="shrink-0 rounded-full bg-cyan-400/15 px-2 py-1 text-[10px] font-semibold text-cyan-200 ring-1 ring-cyan-400/30">
            {t("alert.affectsYourRoute")}
          </span>
        ) : null}
      </header>

      {/* ---------- THE DELTA ---------- */}
      <section
        data-testid="lead-time-block"
        className="mt-3 overflow-hidden rounded-xl border border-amber-400/25 bg-gradient-to-r from-amber-500/10 via-amber-500/[0.06] to-rose-500/10 px-3 py-2.5"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-200">
            {t("alert.lead")}
          </span>
          {leadMinutes !== null ? (
            <span
              data-testid="lead-time-minutes"
              className="text-2xl font-bold leading-none tabular-nums text-amber-100"
            >
              {t("common.minutes", { n: leadMinutes })}
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-amber-200/90">
              {t("alert.notNotified")}
            </span>
          )}
        </div>

        <div className="relative mt-2.5 h-1.5 rounded-full bg-white/10">
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${
              leadMinutes !== null
                ? "bg-gradient-to-r from-amber-400 to-rose-400"
                : "bg-amber-400/40"
            }`}
            style={{ width: leadMinutes !== null ? "100%" : "38%" }}
          />
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-amber-100/80">
          <span className="tabular-nums">
            {t("alert.firstSeen")} {firstSeen}
          </span>
          <span className="tabular-nums">
            {notified === null
              ? t("alert.notNotified")
              : `${t("alert.operatorNotified")} ${notified}`}
          </span>
        </div>

        <p className="mt-2 text-[11px] leading-snug text-amber-50/90">
          {leadMinutes !== null
            ? t("alert.leadTime", { min: leadMinutes })
            : t("alert.leadTimeNone")}
        </p>
      </section>

      <dl className="mt-3 space-y-2 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">{t("alert.what")}</dt>
          <dd className="min-w-0 flex-1 text-slate-200">{t(`issue.${signal.issueType}`)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">{t("alert.where")}</dt>
          <dd className="min-w-0 flex-1 text-slate-200">
            {location}
            {lineNames ? <span className="text-slate-400"> · {lineNames}</span> : null}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">{t("alert.confidence")}</dt>
          <dd className="min-w-0 flex-1">
            <ConfidenceMeter
              value={confidence}
              reduced={confidenceReduced}
              label={`${Math.round(confidence * 100)}%`}
            />
            <p className="mt-1 text-[10px] text-slate-500">
              {t(`confidence.${band}`)}
              {confidenceReduced ? ` · ${t("confidence.reducedOffline")}` : ""}
            </p>
          </dd>
        </div>
      </dl>

      {/* Source breakdown: official vs DISTINCT social authors. */}
      <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {t("alert.sources")}
        </p>
        <div className="mt-1.5 grid grid-cols-3 gap-2 text-center">
          <div data-testid="sources-official">
            <p className="text-base font-semibold tabular-nums text-slate-100">
              {signal.corroboratingSources.official}
            </p>
            <p className="text-[10px] leading-tight text-slate-400">
              {t("alert.sourcesOfficial", { count: signal.corroboratingSources.official })}
            </p>
          </div>
          <div data-testid="sources-social">
            <p className="text-base font-semibold tabular-nums text-slate-100">
              {signal.corroboratingSources.socialDistinctAuthors}
            </p>
            <p className="text-[10px] leading-tight text-slate-400">
              {t("alert.sourcesSocial", {
                count: signal.corroboratingSources.socialDistinctAuthors,
              })}
            </p>
          </div>
          <div data-testid="sources-realtime">
            <p className="text-base font-semibold tabular-nums text-slate-100">
              {signal.corroboratingSources.realtimeObservations}
            </p>
            <p className="text-[10px] leading-tight text-slate-400">
              {t("alert.sourcesRealtime", {
                count: signal.corroboratingSources.realtimeObservations,
              })}
            </p>
          </div>
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-snug text-slate-300">{signal.reasoning}</p>

      {signal.wouldAHumanCheckThis ? (
        <p className="mt-2 text-[10px] font-medium text-amber-300/90">
          ⚑ {t("alert.humanCheck")}
        </p>
      ) : null}

      {signal.resolution === "UNRESOLVED" && signal.unresolvedCandidates ? (
        <p className="mt-2 text-[10px] text-amber-300/90">
          {t("alert.unresolved")} ·{" "}
          {t("alert.candidates", { count: signal.unresolvedCandidates.length })}
        </p>
      ) : null}

      <button
        type="button"
        data-no-drag
        data-testid="explain-button"
        onClick={() => onExplain(signal.id)}
        style={touchStyle("explainButton")}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-white/[0.07] px-3 text-[12px] font-semibold text-cyan-200 ring-1 ring-cyan-400/25 active:opacity-80"
      >
        {t("alert.explain")}
        <span aria-hidden>›</span>
      </button>
    </article>
  );
}
