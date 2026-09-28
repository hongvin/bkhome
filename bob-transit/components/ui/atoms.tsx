"use client";

/**
 * Small presentational atoms: reliability badge, severity pill, confidence
 * meter, risk chip.
 *
 * Every one of these is a non-interactive element EXCEPT the risk chip's
 * "why" affordance, which is a real ≥44px button (never a hover tooltip).
 */
import type { ConfidenceBand, ReliabilityBadge, SegmentRisk, Severity } from "@/lib/contracts";
import { confidenceBand } from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import { touchStyle } from "@/components/lib/touch";
import { CONFIDENCE_STYLE, RELIABILITY_STYLE, SEVERITY_STYLE, confidenceBarClass } from "@/components/ui/tokens";
import { formatPercent } from "@/components/lib/format";

export function ReliabilityBadgePill({ badge }: { badge: ReliabilityBadge }) {
  const { t } = useLocale();
  const style = RELIABILITY_STYLE[badge];
  return (
    <span
      data-badge={badge}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${style.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      {t(`badge.${badge}`)}
    </span>
  );
}

export function SeverityPill({ severity }: { severity: Severity }) {
  const { t } = useLocale();
  const style = SEVERITY_STYLE[severity];
  return (
    <span
      data-severity={severity}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${style.pill}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      {t(`severity.${severity}`)}
    </span>
  );
}

export function ConfidencePill({
  value,
  band,
  reduced,
}: {
  value: number;
  band?: ConfidenceBand;
  reduced?: boolean;
}) {
  const { t } = useLocale();
  const resolved = band ?? confidenceBand(value);
  const style = CONFIDENCE_STYLE[resolved];
  return (
    <span
      data-confidence-band={resolved}
      data-confidence-reduced={reduced ? "true" : "false"}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ${style.pill}`}
    >
      {t(`confidence.${resolved}`)}
      <span className="tabular-nums opacity-80">{formatPercent(value)}</span>
      {reduced ? <span aria-hidden>▾</span> : null}
    </span>
  );
}

/**
 * Horizontal confidence bar. `reduced` renders the offline state explicitly:
 * a hatched, shorter bar plus a label, because the requirement is to SAY that
 * confidence is reduced, not merely to lower the number.
 */
export function ConfidenceMeter({
  value,
  label,
  reduced,
}: {
  value: number;
  label?: string;
  reduced?: boolean;
}) {
  const { t } = useLocale();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t("a11y.confidenceMeter", { pct })}
        className="relative h-1.5 w-full min-w-[64px] overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={`h-full rounded-full ${confidenceBarClass(value)} ${
            reduced ? "opacity-60" : ""
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-slate-400">
        {label ?? formatPercent(value)}
      </span>
    </div>
  );
}

export interface RiskChipProps {
  risk: SegmentRisk;
  reduced?: boolean;
  onExplain?: () => void;
  /** Human label for the segment, e.g. "Merdeka → Bukit Bintang". */
  segmentLabel: string;
}

export function RiskChip({ risk, reduced, onExplain, segmentLabel }: RiskChipProps) {
  const { t } = useLocale();
  const style = SEVERITY_STYLE[risk.severity];
  const content = (
    <>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden />
      <span className="truncate">{segmentLabel}</span>
      <span className="shrink-0 tabular-nums opacity-80">
        {formatPercent(risk.degradationProbability)}
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-wider opacity-70">
        {t(`severity.${risk.severity}`)}
      </span>
    </>
  );

  if (!onExplain) {
    return (
      <span
        data-risk-segment={risk.segmentId}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${style.pill}`}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-risk-segment={risk.segmentId}
      data-no-drag
      onClick={onExplain}
      style={touchStyle("explainButton")}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-left text-[11px] font-medium active:opacity-80 ${style.pill}`}
    >
      {content}
    </button>
  );
}
