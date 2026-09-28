/**
 * Contract-typed fixtures for the offline tests. Everything here satisfies the
 * frozen contracts exactly; nothing is imported from another subagent's module.
 */

import {
  CONTRACTS_VERSION,
  TZ_NAME,
  makeSegmentId,
  type Connection,
  type Line,
  type Segment,
  type Station,
  type TransitGraph,
} from "@/lib/contracts/network";
import type { DisruptionSignal, SourceRef } from "@/lib/contracts/signal";
import type { RiskOverlay, SegmentRisk } from "@/lib/contracts/risk";

export const TEST_NOW = new Date("2025-01-02T00:42:00.000Z");

const LINES: Line[] = [
  {
    id: "KJ",
    shortName: "KJ",
    longName: "Kelana Jaya Line",
    longNameMs: "Laluan Kelana Jaya",
    color: "D50032",
    mode: "LRT",
  },
  {
    id: "KGL",
    shortName: "KGL",
    longName: "MRT Kajang Line",
    longNameMs: "Laluan MRT Kajang",
    color: "007A33",
    mode: "MRT",
  },
];

const STATIONS: Station[] = [
  {
    id: "KJ10",
    name: "KLCC",
    nameMs: "KLCC",
    lat: 3.1579,
    lon: 101.7116,
    lineIds: ["KJ"],
    isInterchange: false,
    isAccessible: true,
  },
  {
    id: "KJ13",
    name: "Masjid Jamek",
    nameMs: "Masjid Jamek",
    lat: 3.1487,
    lon: 101.6964,
    lineIds: ["KJ"],
    isInterchange: true,
    isAccessible: true,
  },
  {
    id: "KGL15",
    name: "Merdeka",
    nameMs: "Merdeka",
    lat: 3.1452,
    lon: 101.6997,
    lineIds: ["KGL"],
    isInterchange: true,
    isAccessible: true,
  },
];

function segment(
  lineId: string,
  from: string,
  to: string,
  fromSequence: number,
  toSequence: number,
): Segment {
  return {
    id: makeSegmentId(lineId, from, to),
    lineId,
    fromStationId: from,
    toStationId: to,
    fromSequence,
    toSequence,
    scheduledRunSeconds: 150,
    scheduledDwellSeconds: 30,
    shape: [
      { lat: 3.1579, lon: 101.7116 },
      { lat: 3.1487, lon: 101.6964 },
    ],
    lengthMeters: 2100,
  };
}

const SEGMENTS: Segment[] = [
  segment("KJ", "KJ10", "KJ13", 1, 2),
  segment("KGL", "KJ13", "KGL15", 3, 4),
];

const CONNECTIONS: Connection[] = [
  {
    tripId: "KJ-1",
    lineId: "KJ",
    serviceId: "WEEKDAY",
    fromStationId: "KJ10",
    toStationId: "KJ13",
    segmentId: SEGMENTS[0].id,
    departureTime: 8 * 3600,
    arrivalTime: 8 * 3600 + 180,
  },
  {
    tripId: "KGL-1",
    lineId: "KGL",
    serviceId: "WEEKDAY",
    fromStationId: "KJ13",
    toStationId: "KGL15",
    segmentId: SEGMENTS[1].id,
    departureTime: 8 * 3600 + 300,
    arrivalTime: 8 * 3600 + 480,
  },
];

export function makeGraph(overrides: Partial<TransitGraph> = {}): TransitGraph {
  return {
    contractsVersion: CONTRACTS_VERSION,
    builtAt: "2025-01-01T00:00:00.000Z",
    timezone: TZ_NAME,
    lines: LINES,
    stations: STATIONS,
    segments: SEGMENTS,
    services: [
      {
        serviceId: "WEEKDAY",
        weekdays: [false, true, true, true, true, true, false],
        startDate: "20250101",
        endDate: "20251231",
      },
    ],
    frequencies: [
      {
        tripId: "KJ-1",
        serviceId: "WEEKDAY",
        lineId: "KJ",
        startTime: 6 * 3600,
        endTime: 23 * 3600,
        headwaySeconds: 240,
      },
    ],
    connections: CONNECTIONS,
    stats: {
      stationCount: STATIONS.length,
      lineCount: LINES.length,
      segmentCount: SEGMENTS.length,
      connectionCount: CONNECTIONS.length,
      serviceDayCount: 1,
    },
    warnings: [],
    ...overrides,
  };
}

export const SEGMENT_KJ = SEGMENTS[0].id;
export const SEGMENT_KGL = SEGMENTS[1].id;

function source(id: string, overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    id,
    sourceClass: "SOCIAL",
    authorId: `author-${id}`,
    authorHandle: `@${id}`,
    rawText: "LRT Kelana Jaya lambat 20 minit di KLCC.",
    publishedAt: "2025-01-02T00:30:00.000Z",
    retrievedAt: "2025-01-02T00:31:00.000Z",
    language: "ms",
    contentHash: `hash-${id}`,
    ...overrides,
  };
}

export interface SignalOverrides {
  status?: DisruptionSignal["status"];
  severity?: DisruptionSignal["severity"];
  confidence?: number;
  updatedAt?: string;
  segmentIds?: string[];
  issueType?: DisruptionSignal["issueType"];
  degradedByOfflineCache?: boolean;
  sources?: SourceRef[];
  windowEndsAt?: string | null;
}

export function makeSignal(id: string, overrides: SignalOverrides = {}): DisruptionSignal {
  const confidence = overrides.confidence ?? 0.72;
  return {
    id,
    createdAt: "2025-01-02T00:30:00.000Z",
    updatedAt: overrides.updatedAt ?? "2025-01-02T00:35:00.000Z",
    status: overrides.status ?? "REPORTED",
    segmentIds: overrides.segmentIds ?? [SEGMENT_KJ],
    stationIds: ["KJ10"],
    lineIds: ["KJ"],
    resolution: "RESOLVED",
    issueType: overrides.issueType ?? "DELAY",
    severity: overrides.severity ?? "MAJOR",
    confidence: {
      value: confidence,
      calibrationVersion: "cal-v1",
      factors: [
        { name: "social_distinct_authors", weight: 0.4, contribution: 0.3, note: "3 authors" },
      ],
      band: confidence >= 0.65 ? "HIGH" : confidence >= 0.4 ? "MODERATE" : "LOW",
      degradedByOfflineCache: overrides.degradedByOfflineCache ?? false,
    },
    firstSeenAt: "2025-01-02T00:30:00.000Z",
    lastSeenAt: "2025-01-02T00:35:00.000Z",
    operatorNotifiedAt: null,
    leadTimeMinutes: null,
    corroboratingSources: {
      official: 0,
      socialDistinctAuthors: 3,
      realtimeObservations: 0,
    },
    sources: overrides.sources ?? [source(`${id}-s1`), source(`${id}-s2`)],
    reasoning: "Three distinct commuters reported the same delay within four minutes.",
    wouldAHumanCheckThis: false,
    window: {
      startsAt: "2025-01-02T00:30:00.000Z",
      endsAt: overrides.windowEndsAt ?? null,
    },
    provenance: [
      {
        hop: "INGEST",
        at: "2025-01-02T00:31:00.000Z",
        confidence: 0.5,
        summary: "2 social posts ingested",
      },
      {
        hop: "VERIFY",
        at: "2025-01-02T00:32:00.000Z",
        confidence,
        summary: "Corroborated by distinct authors",
      },
    ],
  };
}

export function makeSegmentRisk(
  segmentId: string,
  overrides: Partial<SegmentRisk> = {},
): SegmentRisk {
  return {
    segmentId,
    degradationProbability: 0.6,
    confidence: 0.7,
    severity: "MAJOR",
    issueType: "DELAY",
    sourceCount: 3,
    lastUpdated: "2025-01-02T00:35:00.000Z",
    stale: false,
    ...overrides,
  };
}

export function makeOverlay(overrides: Partial<RiskOverlay> = {}): RiskOverlay {
  return {
    generatedAt: "2025-01-02T00:35:00.000Z",
    asOf: "2025-01-02T00:35:00.000Z",
    stalenessMinutes: 0,
    isStale: false,
    source: "live",
    segments: [makeSegmentRisk(SEGMENT_KJ), makeSegmentRisk(SEGMENT_KGL, { severity: "MINOR" })],
    ...overrides,
  };
}
