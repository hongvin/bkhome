"use client";

/**
 * Source Inspector — screen E.
 *
 * One tap from every claim in the app lands here. It traces
 * signal -> segment -> confidence -> route decision in plain language, and it
 * shows the confidence at each pipeline hop so the reader can see WHERE the
 * belief came from rather than being handed a single number.
 *
 * Raw source text is shown verbatim and never translated: it is evidence.
 */
import type {
  DisruptionSignal,
  Line,
  Segment,
  SignalProvenanceHop,
  SourceInspectorTrace,
  Station,
  StationId,
} from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import type { TranslationKey } from "@/lib/i18n";
import { formatClockFromIso } from "@/components/lib/format";
import { describeSegment, lineLabel } from "@/components/lib/describe";
import { touchStyle } from "@/components/lib/touch";
import { CARD } from "@/components/ui/tokens";
import { ConfidenceMeter } from "@/components/ui/atoms";

/**
 * Hop -> label key.
 *
 * `SourceInspectorTrace.confidenceByHop[].hop` is typed as `string` in the frozen
 * contract (unlike `SignalProvenanceHop.hop`, which is the closed union), so this
 * narrows it explicitly rather than casting.
 */
function hopLabelKey(hop: string): TranslationKey {
  switch (hop) {
    case "INGEST":
      return "source.hop.INGEST";
    case "VERIFY":
      return "source.hop.VERIFY";
    case "IMPACT":
      return "source.hop.IMPACT";
    case "ADVISORY":
      return "source.hop.ADVISORY";
    default:
      return "source.confidenceByHop";
  }
}

/** Closed-union variant, used where the contract does give us the union. */
const HOP_LABEL_KEY: Record<SignalProvenanceHop["hop"], TranslationKey> = {
  INGEST: "source.hop.INGEST",
  VERIFY: "source.hop.VERIFY",
  IMPACT: "source.hop.IMPACT",
  ADVISORY: "source.hop.ADVISORY",
};

export interface SourceInspectorProps {
  trace: SourceInspectorTrace | null;
  signal: DisruptionSignal | null;
  loading: boolean;
  confidenceReduced: boolean;
  segmentById: ReadonlyMap<string, Segment>;
  stationById: ReadonlyMap<StationId, Station>;
  lineById: ReadonlyMap<string, Line>;
  /** Populated when this signal actually changed the ranking. */
  routeDecision: { rank: number; delayMinutes: number } | null;
  onBack: () => void;
  onClose: () => void;
}

export function SourceInspector({
  trace,
  signal,
  loading,
  confidenceReduced,
  segmentById,
  stationById,
  lineById,
  routeDecision,
  onBack,
  onClose,
}: SourceInspectorProps) {
  const { locale, t } = useLocale();

  return (
    <section data-testid="source-inspector" className="flex flex-col gap-3 p-3.5 pt-0">
      <header className="flex items-center gap-2">
        <button
          type="button"
          data-no-drag
          data-testid="inspector-back"
          onClick={onBack}
          style={touchStyle("backButton")}
          className="flex shrink-0 items-center justify-center rounded-xl bg-white/[0.07] text-slate-200 ring-1 ring-white/10 active:opacity-80"
          aria-label={t("source.back")}
        >
          ‹
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
          {t("source.title")}
        </h2>
        <button
          type="button"
          data-no-drag
          data-testid="inspector-close"
          onClick={onClose}
          style={touchStyle("closeButton")}
          className="flex shrink-0 items-center justify-center rounded-xl bg-white/[0.07] text-slate-200 ring-1 ring-white/10 active:opacity-80"
          aria-label={t("source.close")}
        >
          ✕
        </button>
      </header>

      {loading ? (
        <p className="py-8 text-center text-xs text-slate-400">{t("common.loading")}</p>
      ) : !trace || !signal ? (
        <p className="py-8 text-center text-xs text-slate-400">{t("source.noTrace")}</p>
      ) : (
        <>
          <div className={`${CARD} px-3 py-2.5`}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t("source.claim")}
            </p>
            <p className="mt-1 text-[13px] leading-snug text-slate-100">{trace.claim}</p>
          </div>

          {/* Confidence at each hop — the A3 requirement, made visible. */}
          <div className={`${CARD} px-3 py-2.5`}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t("source.confidenceByHop")}
            </p>
            <ol className="mt-2 flex items-stretch gap-1.5">
              {trace.confidenceByHop.map((hop) => {
                const value = confidenceReduced ? hop.confidence * 0.6 : hop.confidence;
                return (
                  <li
                    key={hop.hop}
                    data-hop={hop.hop}
                    data-confidence={value.toFixed(3)}
                    className="flex min-w-0 flex-1 flex-col justify-end gap-1 rounded-lg bg-white/[0.03] px-1.5 py-1.5"
                  >
                    <span
                      className="w-full rounded-sm bg-cyan-400/70"
                      style={{ height: `${Math.max(4, Math.round(value * 40))}px` }}
                      aria-hidden
                    />
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-300">
                      {t(hopLabelKey(hop.hop))}
                    </span>
                    <span className="text-[10px] tabular-nums text-slate-400">
                      {Math.round(value * 100)}%
                    </span>
                    <span className="text-[9px] tabular-nums text-slate-500">
                      {formatClockFromIso(hop.at)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Route decision */}
          <div className={`${CARD} px-3 py-2.5`}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t("source.routeDecision")}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-slate-200">
              {routeDecision
                ? t("source.routeDecisionBody", {
                    rank: routeDecision.rank,
                    delay: routeDecision.delayMinutes,
                  })
                : t("source.routeDecisionNone")}
            </p>
          </div>

          {/* Steps */}
          <div className={`${CARD} px-3 py-2.5`}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t("source.steps")}
            </p>
            <ol className="mt-2 space-y-2.5">
              {trace.steps.map((step, index) => {
                const value = confidenceReduced ? step.confidence * 0.6 : step.confidence;
                return (
                  <li key={`${step.label}-${index}`} className="flex gap-2.5">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold tabular-nums text-slate-300">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-semibold text-slate-100">{step.label}</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-slate-300">
                        {step.detail}
                      </p>
                      <div className="mt-1.5">
                        <ConfidenceMeter value={value} reduced={confidenceReduced} />
                      </div>
                      {step.refs.length > 0 ? (
                        <p className="mt-1 break-words text-[9px] leading-tight text-slate-500">
                          {t("source.refs")}: {step.refs.slice(0, 6).join(", ")}
                          {step.refs.length > 6 ? ` +${step.refs.length - 6}` : ""}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Segments this claim rests on */}
          {signal.segmentIds.length > 0 ? (
            <div className={`${CARD} px-3 py-2.5`}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {t("alert.segment")}
              </p>
              <ul className="mt-1.5 space-y-1">
                {signal.segmentIds.map((segmentId) => {
                  const segment = segmentById.get(segmentId);
                  return (
                    <li
                      key={segmentId}
                      data-segment-id={segmentId}
                      className="flex items-baseline justify-between gap-2 text-[11px]"
                    >
                      <span className="min-w-0 flex-1 text-slate-200">
                        {describeSegment(segmentId, segmentById, stationById, locale)}
                      </span>
                      <span className="shrink-0 text-slate-500">
                        {segment ? lineLabel(segment.lineId, lineById, locale) : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* Raw sources — verbatim, never translated. */}
          <div className={`${CARD} px-3 py-2.5`}>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {t("source.rawText")}
            </p>
            <ul className="mt-1.5 space-y-2">
              {signal.sources.map((source) => (
                <li key={source.id} data-source-id={source.id}>
                  <details className="group rounded-xl bg-white/[0.03] px-2.5 py-2">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-slate-200">
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                          source.sourceClass === "SOCIAL"
                            ? "bg-sky-400/15 text-sky-200"
                            : "bg-emerald-400/15 text-emerald-200"
                        }`}
                      >
                        {source.sourceClass === "SOCIAL" ? "Social" : "Official"}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {source.title ?? source.authorHandle ?? source.id}
                      </span>
                      <span className="shrink-0 text-[9px] tabular-nums text-slate-500">
                        {formatClockFromIso(source.publishedAt)}
                      </span>
                    </summary>
                    <p className="mt-2 text-[11px] leading-snug text-slate-300">
                      {source.rawText}
                    </p>
                    <p className="mt-1.5 text-[9px] text-slate-500">
                      {t("source.language")}: {source.language} ·{" "}
                      {t("source.published")}: {source.publishedAt}
                      {source.authorHandle ? ` · ${t("source.author")} ${source.authorHandle}` : ""}
                    </p>
                    {source.url ? (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={touchStyle("explainButton")}
                        className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-white/[0.06] px-2.5 text-[11px] font-medium text-cyan-200 active:opacity-80"
                      >
                        {t("source.openSource")} <span aria-hidden>↗</span>
                      </a>
                    ) : null}
                  </details>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
