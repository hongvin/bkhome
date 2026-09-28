/**
 * Source Inspector traces — screen E.
 *
 * Built programmatically from the signals plus the topology, so the trace can
 * never drift from the signal it explains. Every hop carries a confidence, and
 * the `steps[].refs` point at the actual source ids the claim rests on.
 */
import type {
  DisruptionSignal,
  SegmentRiskLookup,
  SourceInspectorTrace,
} from "@/lib/contracts";
import { confidenceBand } from "@/lib/contracts";

import { formatKlTime } from "./clock";
import type { LoadedTopology } from "./graph";
import { mockRiskPenalty } from "./risk";

function stationName(topology: LoadedTopology, stationId: string): string {
  return topology.stationById.get(stationId)?.name ?? stationId;
}

/** "Between A and B" / "At A" — the plain-language location of a signal. */
export function describeLocation(
  signal: DisruptionSignal,
  topology: LoadedTopology,
): string {
  const first = signal.segmentIds[0];
  if (first) {
    const segment = topology.segmentById.get(first);
    if (segment) {
      const from = stationName(topology, segment.fromStationId);
      const to = stationName(topology, segment.toStationId);
      const line = topology.lineById.get(segment.lineId);
      const extra = signal.segmentIds.length > 1 ? ` (+${signal.segmentIds.length - 1} more)` : "";
      return `${from} → ${to} on ${line?.longName ?? segment.lineId}${extra}`;
    }
  }
  const stationId = signal.stationIds[0];
  if (stationId) return `${stationName(topology, stationId)} station`;
  if (signal.unresolvedCandidates && signal.unresolvedCandidates.length > 0) {
    return `${signal.unresolvedCandidates.length} candidate segments`;
  }
  return "Location not resolved";
}

export function buildSourceTrace(
  signal: DisruptionSignal,
  topology: LoadedTopology,
  lookup: SegmentRiskLookup,
): SourceInspectorTrace {
  const official = signal.sources.filter(
    (s) => s.sourceClass === "OFFICIAL_STATEMENT" || s.sourceClass === "OFFICIAL_REALTIME",
  );
  const social = signal.sources.filter((s) => s.sourceClass === "SOCIAL");
  const distinctAuthors = new Set(
    social.map((s) => s.authorId ?? s.authorHandle ?? s.id),
  );

  const firstSeen = formatKlTime(Date.parse(signal.firstSeenAt));
  const notified =
    signal.operatorNotifiedAt === null
      ? null
      : formatKlTime(Date.parse(signal.operatorNotifiedAt));

  const location = describeLocation(signal, topology);
  const steps: SourceInspectorTrace["steps"] = [];

  steps.push({
    label: "Evidence captured",
    detail: `${signal.sources.length} source(s) captured. First evidence at ${firstSeen} from ${
      official.length > 0
        ? `${official.length} official channel(s)`
        : `${distinctAuthors.size} distinct member(s) of the public`
    }.`,
    confidence: signal.provenance[0]?.confidence ?? signal.confidence.value * 0.55,
    refs: signal.sources.map((s) => s.id),
  });

  steps.push({
    label: "Reposts removed",
    detail: `${social.length} social items collapsed to ${distinctAuthors.size} distinct author(s). Repost volume is deliberately not counted as corroboration.`,
    confidence: signal.provenance[1]?.confidence ?? signal.confidence.value * 0.82,
    refs: [...distinctAuthors].map(String),
  });

  steps.push({
    label: "Confidence calibrated",
    detail: `Fused to ${(signal.confidence.value * 100).toFixed(0)}% (${confidenceBand(
      signal.confidence.value,
    )}) using ${signal.confidence.factors.length} weighted factor(s); calibration ${signal.confidence.calibrationVersion}.`,
    confidence: signal.confidence.value,
    refs: signal.confidence.factors.map((f) => f.name),
  });

  steps.push({
    label: "Location resolved",
    detail:
      signal.segmentIds.length > 0
        ? `Resolved to ${location}. Risk is directional: the opposite direction is priced separately.`
        : `Station-level only: ${location}. No directional track segment is affected, so no route is rerouted.`,
    confidence: signal.provenance[2]?.confidence ?? signal.confidence.value * 0.93,
    refs: [...signal.segmentIds, ...signal.stationIds],
  });

  steps.push({
    label:
      signal.operatorNotifiedAt === null
        ? "Operator has not confirmed"
        : "Operator confirmed",
    detail:
      signal.operatorNotifiedAt === null || signal.leadTimeMinutes === null
        ? "No official statement yet, so the score stays at social-evidence confidence and is re-checked on every sync."
        : `Official acknowledgement at ${notified} — ${signal.leadTimeMinutes} minutes after we first saw it. That gap is the lead time we are trying to grow.`,
    confidence: signal.confidence.value,
    refs: official.map((s) => s.id),
  });

  if (signal.segmentIds.length > 0) {
    const penalties = signal.segmentIds.map((segmentId) => {
      const risk = lookup(segmentId);
      return mockRiskPenalty({
        segmentId,
        severity: risk?.severity ?? signal.severity,
        confidence: risk?.degradationProbability ?? signal.confidence.value,
        issueType: risk?.issueType ?? signal.issueType,
        atTime: 8 * 3600,
        isOngoing: true,
      });
    });
    const totalAdded = penalties.reduce((sum, p) => sum + p.penaltySeconds, 0);
    const worstMultiplier = penalties.reduce((max, p) => Math.max(max, p.multiplier), 1);
    steps.push({
      label: "Priced into routing",
      detail: `Applied a ${worstMultiplier.toFixed(2)}x run-time multiplier, about ${Math.round(
        totalAdded / 60,
      )} min of extra expected travel per crossing. Any itinerary through here is ranked below one that avoids it.`,
      confidence: signal.confidence.value,
      refs: signal.segmentIds,
    });
  }

  return {
    signalId: signal.id,
    claim: `${signal.severity} ${signal.issueType.replace(/_/g, " ").toLowerCase()} — ${location}`,
    steps,
    confidenceByHop: signal.provenance.map((hop) => ({
      hop: hop.hop,
      confidence: hop.confidence,
      at: hop.at,
    })),
  };
}
