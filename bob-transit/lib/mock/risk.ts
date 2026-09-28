/**
 * Mock risk layer.
 *
 * Implements the frozen `RiskPenaltyFn` signature and produces a `RiskOverlay`
 * derived from the mock signals, so the router and the UI both get a realistic,
 * contract-shaped risk input while S4 is still being built. At integration this
 * file is replaced by S4's model; nothing else changes.
 */
import type {
  RiskOverlay,
  RiskPenalty,
  RiskPenaltyInput,
  SegmentId,
  SegmentRisk,
  SegmentRiskLookup,
} from "@/lib/contracts";
import {
  ISSUE_TYPE_SEVERITY_WEIGHT,
  MATERIAL_RISK_CONFIDENCE_THRESHOLD,
  SEVERITY_BASE_MULTIPLIER,
} from "@/lib/contracts";

import { DEMO_NOW_MS, DEMO_STALENESS_MINUTES, toKlIso } from "./clock";
import { MOCK_SIGNALS } from "./signals";

/** Nominal inter-station run used to turn a multiplier into a seconds penalty. */
const NOMINAL_RUN_SECONDS = 120;

/**
 * Deterministic, pure, monotonic in both severity and confidence, and never
 * below 1.0 — the four properties the frozen contract requires of S4's model.
 */
export function mockRiskPenalty(input: RiskPenaltyInput): RiskPenalty {
  const base = SEVERITY_BASE_MULTIPLIER[input.severity];
  const issueWeight = ISSUE_TYPE_SEVERITY_WEIGHT[input.issueType];
  const confidence = clamp01(input.confidence);

  let multiplier = 1 + (base - 1) * confidence * issueWeight;
  if (!input.isOngoing) {
    // A cleared signal still leaves residual knock-on delay, but much less.
    multiplier = 1 + (multiplier - 1) * 0.4;
  }
  multiplier = Math.max(1, multiplier);

  const penaltySeconds = Math.round(NOMINAL_RUN_SECONDS * (multiplier - 1));
  const reason =
    multiplier <= 1.0001
      ? "No known disruption on this segment."
      : `${input.severity} ${input.issueType} at ${Math.round(confidence * 100)}% confidence: ` +
        `${multiplier.toFixed(2)}x scheduled run time.`;

  return {
    segmentId: input.segmentId,
    penaltySeconds,
    multiplier: Number(multiplier.toFixed(4)),
    confidence,
    severity: input.severity,
    reason,
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export interface OverlayOptions {
  /** `cache` reproduces the offline/stale path the UI must always disclose. */
  mode?: "cache" | "live";
}

/** Confidence in the probability itself, driven by how many sources corroborate. */
function evidenceConfidence(sourceCount: number, official: number): number {
  const base = 0.34 + 0.075 * Math.min(sourceCount, 6);
  const officialBonus = official > 0 ? 0.18 : 0;
  return Number(clamp01(base + officialBonus).toFixed(3));
}

export function mockRiskOverlay(options: OverlayOptions = {}): RiskOverlay {
  const mode = options.mode ?? "cache";
  const bySegment = new Map<SegmentId, SegmentRisk>();

  for (const signal of MOCK_SIGNALS) {
    if (signal.status === "CLEARED" || signal.status === "REJECTED") continue;
    const sourceCount =
      signal.corroboratingSources.official +
      signal.corroboratingSources.socialDistinctAuthors +
      signal.corroboratingSources.realtimeObservations;
    for (const segmentId of signal.segmentIds) {
      const existing = bySegment.get(segmentId);
      const candidate: SegmentRisk = {
        segmentId,
        degradationProbability: signal.confidence.value,
        confidence: evidenceConfidence(sourceCount, signal.corroboratingSources.official),
        severity: signal.severity,
        issueType: signal.issueType,
        sourceCount,
        lastUpdated: signal.updatedAt,
        stale: mode === "cache",
      };
      // Two signals on one segment: keep the more probable one, but count both.
      if (!existing || candidate.degradationProbability > existing.degradationProbability) {
        bySegment.set(segmentId, candidate);
      } else {
        bySegment.set(segmentId, {
          ...existing,
          sourceCount: existing.sourceCount + candidate.sourceCount,
        });
      }
    }
  }

  const segments = [...bySegment.values()].sort((a, b) =>
    b.degradationProbability - a.degradationProbability ||
    a.segmentId.localeCompare(b.segmentId),
  );

  const isStale = mode === "cache";
  const asOfMs = isStale
    ? DEMO_NOW_MS - DEMO_STALENESS_MINUTES * 60_000
    : DEMO_NOW_MS;

  return {
    generatedAt: toKlIso(DEMO_NOW_MS),
    asOf: toKlIso(asOfMs),
    stalenessMinutes: isStale ? DEMO_STALENESS_MINUTES : 0,
    isStale,
    source: isStale ? "cache" : "live",
    segments,
  };
}

export function overlayLookup(overlay: RiskOverlay): SegmentRiskLookup {
  const index = new Map(overlay.segments.map((s) => [s.segmentId, s]));
  return (segmentId: SegmentId) => index.get(segmentId);
}

/** Convenience: the material-risk segments, for map highlighting and tests. */
export function materialRiskSegments(overlay: RiskOverlay): SegmentRisk[] {
  return overlay.segments.filter(
    (s) => s.degradationProbability >= MATERIAL_RISK_CONFIDENCE_THRESHOLD,
  );
}
