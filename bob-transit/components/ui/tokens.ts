/**
 * Visual tokens. Kept in one place so the dark palette, the severity scale and
 * the reliability scale cannot drift between screens.
 *
 * Accessibility note: reliability and severity are NEVER carried by colour
 * alone. Every badge renders a word, every risk chip renders a percentage, and
 * the confidence meter renders a numeric value beside its bar.
 */
import type { ConfidenceBand, ReliabilityBadge, Severity } from "@/lib/contracts";

export interface PillStyle {
  /** Tailwind classes for the pill background + text. */
  pill: string;
  /** Tailwind classes for a solid dot/indicator. */
  dot: string;
}

export const RELIABILITY_STYLE: Record<ReliabilityBadge, PillStyle> = {
  VERY_RELIABLE: {
    pill: "bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-400/30",
    dot: "bg-emerald-400",
  },
  RELIABLE: {
    pill: "bg-teal-400/15 text-teal-300 ring-1 ring-teal-400/30",
    dot: "bg-teal-400",
  },
  UNCERTAIN: {
    pill: "bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30",
    dot: "bg-amber-400",
  },
  AT_RISK: {
    pill: "bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/30",
    dot: "bg-orange-500",
  },
  AVOID: {
    pill: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30",
    dot: "bg-rose-500",
  },
};

export const SEVERITY_STYLE: Record<Severity, PillStyle> = {
  INFO: { pill: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-400/25", dot: "bg-slate-400" },
  MINOR: { pill: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/25", dot: "bg-sky-400" },
  MAJOR: { pill: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30", dot: "bg-amber-400" },
  SEVERE: { pill: "bg-rose-600/20 text-rose-200 ring-1 ring-rose-500/40", dot: "bg-rose-500" },
};

export const CONFIDENCE_STYLE: Record<ConfidenceBand, PillStyle> = {
  VERY_LOW: { pill: "bg-slate-500/15 text-slate-300 ring-1 ring-slate-400/25", dot: "bg-slate-400" },
  LOW: { pill: "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/25", dot: "bg-sky-400" },
  MODERATE: {
    pill: "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30",
    dot: "bg-amber-400",
  },
  HIGH: { pill: "bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/30", dot: "bg-orange-400" },
  VERY_HIGH: { pill: "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30", dot: "bg-rose-400" },
};

/** Bar fill colour for a confidence meter, by value. */
export function confidenceBarClass(value: number): string {
  if (value >= 0.85) return "bg-rose-400";
  if (value >= 0.65) return "bg-orange-400";
  if (value >= 0.4) return "bg-amber-400";
  if (value >= 0.2) return "bg-sky-400";
  return "bg-slate-400";
}

export const SURFACE = "bg-slate-900/95";
export const CARD = "rounded-2xl border border-white/10 bg-white/[0.03]";
export const DIVIDER = "border-white/10";
