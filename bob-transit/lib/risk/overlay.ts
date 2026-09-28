/**
 * Risk overlay construction — turns verified `DisruptionSignal`s into the
 * per-segment risk picture the router and the map both read.
 *
 * TIME IS INJECTED, NEVER READ
 * ----------------------------
 * Every function here takes `nowIso` as a parameter. Nothing in this module calls
 * `Date.now()`. That is what makes the overlay reproducible in tests and in the
 * replay demo: the same signals plus the same `nowIso` always produce a
 * byte-identical overlay.
 *
 * FUSION RULE
 * -----------
 * Signals are independent pieces of evidence about the same physical track, so
 * their probabilities combine with a noisy-OR:
 *
 *     degradationProbability = 1 - PROD(1 - signal.confidence.value)
 *
 * This is the standard "at least one of these independent reports is right"
 * combination. It is monotone: adding a signal can only raise the probability.
 *
 * `confidence` (confidence in the fused probability itself) starts equal to the
 * fused probability — one source gives an estimate you are exactly as confident
 * in as the estimate — and rises as independent corroboration arrives:
 *
 *     confidence = clamp01(degradationProbability
 *                          + CORROBORATION_BONUS * (1 - exp(-(distinctSources-1)/2)))
 *
 * The exponential saturation is deliberate: the 2nd independent source adds far
 * more confidence than the 5th, which is how corroboration actually behaves.
 *
 * UNRESOLVED SIGNALS ARE NOT GUESSED
 * ----------------------------------
 * A signal with `resolution: "UNRESOLVED"` has no `segmentIds` and a set of
 * `unresolvedCandidates`. The frozen contract says: "Never silently pick one."
 * So this module assigns it to no segment, records it in the diagnostics, and the
 * Impact agent surfaces it in `whyThisCouldBeWrong` instead.
 */

import type {
  DisruptionSignal,
  IssueType,
  RiskOverlay,
  RiskPenalty,
  RiskPenaltyFn,
  RiskPenaltyInput,
  SegmentId,
  SegmentRisk,
  SegmentRiskLookup,
  Severity,
} from "@/lib/contracts";
import { SEVERITIES, isActiveAt } from "@/lib/contracts";
import { createRiskPenaltyFn, type RiskPenaltyOptions } from "./penalty";

/** Overlay older than this is flagged `isStale`. */
export const DEFAULT_STALE_AFTER_MINUTES = 15;

/** Extra confidence granted by independent corroboration, saturating. */
export const CORROBORATION_CONFIDENCE_BONUS = 0.5;

/** Signals in these states no longer describe a live problem. */
const INACTIVE_STATUSES: ReadonlySet<DisruptionSignal["status"]> = new Set([
  "CLEARED",
  "REJECTED",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Whole minutes between two ISO instants, clamped at 0. Pure. */
export function minutesBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 60000));
}

/* ------------------------------------------------------------------ *
 * Building the overlay
 * ------------------------------------------------------------------ */

export interface BuildRiskOverlayOptions {
  signals: readonly DisruptionSignal[];
  /** Injected "now". ISO-8601. Nothing in this module reads the wall clock. */
  nowIso: string;
  /** Defaults to "live". Use "cache" when serving a stored overlay offline. */
  source?: "live" | "cache";
  /** Age above which the overlay is flagged stale. Defaults to 15 minutes. */
  staleAfterMinutes?: number;
  /**
   * A previously-built overlay. Required to make `source: "cache"` meaningful:
   * its `asOf` becomes this overlay's `asOf`, so the UI can say
   * "as of HH:MM, N min ago" and never present stale data as live.
   */
  cached?: RiskOverlay;
  /** Drop signals whose window has ended. Default true. */
  activeOnly?: boolean;
}

export interface RiskOverlayDiagnostics {
  overlay: RiskOverlay;
  /** Signals that contributed to at least one segment. */
  contributingSignalIds: string[];
  /** UNRESOLVED signals: recorded, never assigned to a segment. */
  unresolvedSignalIds: string[];
  /** CLEARED/REJECTED, or outside their active window. */
  ignoredSignalIds: string[];
}

interface SegmentContribution {
  signal: DisruptionSignal;
}

/**
 * Build the overlay, plus the diagnostics the Impact agent needs to explain what
 * it did and did not use.
 */
export function buildRiskOverlayWithDiagnostics(
  options: BuildRiskOverlayOptions,
): RiskOverlayDiagnostics {
  const {
    signals,
    nowIso,
    source = "live",
    staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES,
    cached,
    activeOnly = true,
  } = options;

  const now = new Date(nowIso);
  const contributing: string[] = [];
  const unresolved: string[] = [];
  const ignored: string[] = [];

  const bySegment = new Map<SegmentId, SegmentContribution[]>();

  for (const signal of [...signals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (INACTIVE_STATUSES.has(signal.status)) {
      ignored.push(signal.id);
      continue;
    }
    if (activeOnly && !isActiveAt(signal, now)) {
      ignored.push(signal.id);
      continue;
    }
    if (signal.resolution === "UNRESOLVED" || signal.segmentIds.length === 0) {
      // Never silently pick a candidate segment.
      unresolved.push(signal.id);
      continue;
    }
    contributing.push(signal.id);
    for (const segmentId of signal.segmentIds) {
      const list = bySegment.get(segmentId);
      if (list) list.push({ signal });
      else bySegment.set(segmentId, [{ signal }]);
    }
  }

  const segments: SegmentRisk[] = [...bySegment.entries()]
    .map(([segmentId, contributions]) => fuseSegment(segmentId, contributions, source))
    .sort((a, b) => (a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : 0));

  const asOf = source === "cache" ? (cached?.asOf ?? nowIso) : nowIso;
  const stalenessMinutes = source === "cache" ? minutesBetween(asOf, nowIso) : 0;

  const overlay: RiskOverlay = {
    generatedAt: nowIso,
    asOf,
    stalenessMinutes,
    isStale: stalenessMinutes > staleAfterMinutes,
    source,
    segments,
  };

  return {
    overlay,
    contributingSignalIds: contributing,
    unresolvedSignalIds: unresolved,
    ignoredSignalIds: ignored,
  };
}

/** Convenience wrapper when only the overlay is needed. */
export function buildRiskOverlay(options: BuildRiskOverlayOptions): RiskOverlay {
  return buildRiskOverlayWithDiagnostics(options).overlay;
}

function fuseSegment(
  segmentId: SegmentId,
  contributions: readonly SegmentContribution[],
  source: "live" | "cache",
): SegmentRisk {
  let inverseProbability = 1;
  const sourceIds = new Set<string>();
  let evidenceCount = 0;
  let severity: Severity = "INFO";
  let severityRank = -1;
  let issueType: IssueType = "UNKNOWN";
  let issueConfidence = -1;
  let lastUpdated = "";

  for (const { signal } of contributions) {
    const value = clamp01(signal.confidence.value);
    inverseProbability *= 1 - value;
    evidenceCount += 1;

    if (signal.sources.length > 0) {
      for (const ref of signal.sources) sourceIds.add(ref.id);
    }
    if (signal.updatedAt > lastUpdated) lastUpdated = signal.updatedAt;

    const rank = SEVERITIES.indexOf(signal.severity);
    if (
      rank > severityRank ||
      (rank === severityRank && value > issueConfidence) ||
      (rank === severityRank && value === issueConfidence && signal.issueType < issueType)
    ) {
      severity = signal.severity;
      severityRank = rank;
      issueType = signal.issueType;
      issueConfidence = value;
    }
  }

  const degradationProbability = clamp01(1 - inverseProbability);
  const distinctSources = sourceIds.size > 0 ? sourceIds.size : evidenceCount;
  const corroboration =
    CORROBORATION_CONFIDENCE_BONUS * (1 - Math.exp(-Math.max(0, distinctSources - 1) / 2));
  const confidence = clamp01(degradationProbability + corroboration);

  return {
    segmentId,
    degradationProbability,
    confidence,
    severity,
    issueType,
    sourceCount: distinctSources,
    lastUpdated: lastUpdated || "",
    stale: source === "cache",
  };
}

/** An overlay with no disruptions — the healthy baseline. */
export function emptyRiskOverlay(nowIso: string, source: "live" | "cache" = "live"): RiskOverlay {
  return {
    generatedAt: nowIso,
    asOf: nowIso,
    stalenessMinutes: 0,
    isStale: false,
    source,
    segments: [],
  };
}

/* ------------------------------------------------------------------ *
 * Consuming the overlay
 * ------------------------------------------------------------------ */

/**
 * O(1) lookup for the router. Returns `undefined` for a healthy segment, which
 * is exactly the frozen `SegmentRiskLookup` contract.
 */
export function createSegmentRiskLookup(overlay: RiskOverlay): SegmentRiskLookup {
  const index = new Map<SegmentId, SegmentRisk>();
  for (const segment of overlay.segments) index.set(segment.segmentId, segment);
  return (segmentId: SegmentId): SegmentRisk | undefined => index.get(segmentId);
}

/**
 * A `RiskPenaltyFn` bound to an overlay: the router's drop-in option. This is the
 * wiring S1 needs — `planJourneys({ graph, query, riskLookup, riskPenalty })`
 * where both come from one overlay.
 */
export function createOverlayRiskPenaltyFn(
  overlay: RiskOverlay,
  options: RiskPenaltyOptions = {},
): RiskPenaltyFn {
  const lookup = createSegmentRiskLookup(overlay);
  const base = createRiskPenaltyFn(options);

  return (input: RiskPenaltyInput): RiskPenalty => {
    const risk = lookup(input.segmentId);
    if (!risk) {
      // The overlay is the authority on which segments are degraded. A segment it
      // does not mention is healthy, so it is priced at zero regardless of what
      // the caller put in the input's severity/confidence placeholders.
      return base({ ...input, severity: "INFO", issueType: "UNKNOWN", confidence: 0 });
    }
    return base({
      ...input,
      severity: risk.severity,
      issueType: risk.issueType,
      // A caller-supplied confidence can only raise the overlay's, never suppress
      // it.
      confidence: Math.max(clamp01(input.confidence), risk.confidence),
    });
  };
}
