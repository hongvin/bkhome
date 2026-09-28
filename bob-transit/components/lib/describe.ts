/**
 * Pure helpers that turn contract ids into human labels.
 *
 * Kept out of the components so the same phrasing is used on the route cards,
 * the disruption cards and the source inspector — and so it can be unit tested
 * without a DOM.
 */
import type {
  DisruptionSignal,
  Line,
  LineId,
  Segment,
  SegmentId,
  Station,
  StationId,
} from "@/lib/contracts";

export function stationLabel(
  stationId: StationId,
  stationById: ReadonlyMap<StationId, Station>,
  locale: "en" | "ms",
): string {
  const station = stationById.get(stationId);
  if (!station) return stationId;
  return locale === "ms" ? station.nameMs : station.name;
}

export function lineLabel(
  lineId: LineId,
  lineById: ReadonlyMap<LineId, Line>,
  locale: "en" | "ms",
): string {
  const line = lineById.get(lineId);
  if (!line) return lineId;
  return locale === "ms" ? line.longNameMs : line.longName;
}

export function lineShortName(
  lineId: LineId,
  lineById: ReadonlyMap<LineId, Line>,
): string {
  return lineById.get(lineId)?.shortName ?? lineId;
}

/** "Merdeka → Bukit Bintang" for a directional segment id. */
export function describeSegment(
  segmentId: SegmentId,
  segmentById: ReadonlyMap<SegmentId, Segment>,
  stationById: ReadonlyMap<StationId, Station>,
  locale: "en" | "ms",
): string {
  const segment = segmentById.get(segmentId);
  if (!segment) return segmentId;
  return `${stationLabel(segment.fromStationId, stationById, locale)} → ${stationLabel(
    segment.toStationId,
    stationById,
    locale,
  )}`;
}

/** Reverse index: which signal explains this segment. */
export function segmentToSignalIndex(
  signals: readonly DisruptionSignal[],
): Map<SegmentId, DisruptionSignal> {
  const index = new Map<SegmentId, DisruptionSignal>();
  for (const signal of signals) {
    for (const segmentId of signal.segmentIds) {
      const existing = index.get(segmentId);
      if (!existing || signal.confidence.value > existing.confidence.value) {
        index.set(segmentId, signal);
      }
    }
  }
  return index;
}

/** Ordered, de-duplicated station ids along a set of ride segments. */
export function stationsAlong(
  segmentIds: readonly SegmentId[],
  segmentById: ReadonlyMap<SegmentId, Segment>,
): StationId[] {
  const ordered: StationId[] = [];
  for (const segmentId of segmentIds) {
    const segment = segmentById.get(segmentId);
    if (!segment) continue;
    if (ordered[ordered.length - 1] !== segment.fromStationId) {
      ordered.push(segment.fromStationId);
    }
    ordered.push(segment.toStationId);
  }
  return ordered;
}
