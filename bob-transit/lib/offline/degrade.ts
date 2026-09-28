/**
 * Offline degradation.
 *
 * When the device is offline the app still shows the last-known disruption state —
 * but it must be visibly less certain. The frozen contracts carry the two flags
 * that make that possible: `ConfidenceScore.degradedByOfflineCache` and
 * `SegmentRisk.stale`. This module sets them and produces the human-readable
 * reason string the UI renders next to the "as of HH:MM, N min ago" label.
 *
 * Degradation is idempotent: calling it twice does not compound the penalty.
 */

import type { ConfidenceScore } from "@/lib/contracts/signal";
import type { DisruptionSignal } from "@/lib/contracts/signal";
import { confidenceBand } from "@/lib/contracts/signal";
import type { RiskOverlay, SegmentRisk } from "@/lib/contracts/risk";
import {
  StalenessFormatter,
  type Staleness,
  type StalenessLocale,
} from "./staleness";

/**
 * Multiplier applied to a cached confidence value. Documented and deliberately
 * mild: it is a display-integrity penalty, not a re-derivation of the risk model
 * (which S4 owns).
 */
export const OFFLINE_CONFIDENCE_FACTOR = 0.85;

export const OFFLINE_CACHE_FACTOR_NAME = "offline_cache_degradation";

export interface OfflineDegradeOptions {
  /** Injected clock — required, so output is deterministic. */
  now: Date;
  locale?: StalenessLocale;
  /** Confidence multiplier in (0, 1]. Default `OFFLINE_CONFIDENCE_FACTOR`. */
  factor?: number;
  staleAfterMinutes?: number;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Reduce a confidence score and flag it as cache-derived. */
export function degradeConfidenceForOfflineCache(
  confidence: ConfidenceScore,
  options: OfflineDegradeOptions,
): ConfidenceScore {
  if (confidence.degradedByOfflineCache) return confidence;
  const factor = clamp01(options.factor ?? OFFLINE_CONFIDENCE_FACTOR) || OFFLINE_CONFIDENCE_FACTOR;
  const value = clamp01(confidence.value * factor);
  return {
    ...confidence,
    value,
    band: confidenceBand(value),
    degradedByOfflineCache: true,
    factors: [
      ...confidence.factors,
      {
        name: OFFLINE_CACHE_FACTOR_NAME,
        weight: factor,
        contribution: value - confidence.value,
        note:
          `Served from the offline cache; confidence multiplied by ${factor} ` +
          `because the disruption state could not be re-checked with the network.`,
      },
    ],
  };
}

/** Reduce a signal's confidence and mark it cache-derived. */
export function degradeSignalForOfflineCache(
  signal: DisruptionSignal,
  options: OfflineDegradeOptions,
): DisruptionSignal {
  const confidence = degradeConfidenceForOfflineCache(signal.confidence, options);
  if (confidence === signal.confidence) return signal;
  return { ...signal, confidence };
}

export function degradeSignalsForOfflineCache(
  signals: readonly DisruptionSignal[],
  options: OfflineDegradeOptions,
): DisruptionSignal[] {
  return signals.map((signal) => degradeSignalForOfflineCache(signal, options));
}

export interface DegradedOverlay {
  /** Contract-typed overlay, safe to hand to the UI and the router. */
  overlay: RiskOverlay;
  /** `"as of HH:MM, N min ago"` for the overlay's `asOf`. */
  label: string;
  staleness: Staleness;
  /** Full sentence explaining why confidence is reduced. */
  reason: string;
  confidenceFactor: number;
}

function degradeSegmentRisk(segment: SegmentRisk, factor: number): SegmentRisk {
  return {
    ...segment,
    confidence: clamp01(segment.confidence * factor),
    stale: true,
  };
}

/**
 * Mark an overlay as cache-served: `source: "cache"`, `isStale: true`, honest
 * `stalenessMinutes`, every segment `stale`, and confidence reduced.
 */
export function degradeOverlayForOfflineCache(
  overlay: RiskOverlay,
  options: OfflineDegradeOptions,
): DegradedOverlay {
  const factor = clamp01(options.factor ?? OFFLINE_CONFIDENCE_FACTOR) || OFFLINE_CONFIDENCE_FACTOR;
  const formatter = new StalenessFormatter({
    locale: options.locale ?? "en",
    staleAfterMinutes: options.staleAfterMinutes,
  });
  const staleness = formatter.describe(overlay.asOf, options.now);
  const degraded: RiskOverlay = {
    ...overlay,
    source: "cache",
    isStale: true,
    stalenessMinutes: staleness.minutes,
    segments: overlay.segments.map((segment) => degradeSegmentRisk(segment, factor)),
  };
  return {
    overlay: degraded,
    label: formatter.format(overlay.asOf, options.now),
    staleness,
    reason: offlineReason(overlay.asOf, options.now, {
      locale: options.locale,
      staleAfterMinutes: options.staleAfterMinutes,
    }),
    confidenceFactor: factor,
  };
}

/**
 * The reason string exposed to the UI. Never claims the data is live.
 */
export function offlineReason(
  asOf: string,
  now: Date,
  options: { locale?: StalenessLocale; staleAfterMinutes?: number } = {},
): string {
  const locale = options.locale ?? "en";
  const formatter = new StalenessFormatter({
    locale,
    staleAfterMinutes: options.staleAfterMinutes,
  });
  const label = formatter.format(asOf, now);
  return locale === "ms"
    ? `Luar talian: memaparkan data gangguan yang disimpan (${label}); keyakinan dikurangkan.`
    : `Offline: showing cached disruption data (${label}); confidence reduced.`;
}
