/**
 * CUSTOM DOMAIN TOOL (A7, part 1 of 2)
 * ===================================
 * KL rail interchange transfer-time model.
 *
 * WHY THIS IS NOT A GENERIC HELPER
 * --------------------------------
 * In the Klang Valley GTFS feed an interchange is NOT a node. Masjid Jamek is
 * three separate `stop_id`s — `AG7`, `SP7` and `KJ13` — with three separate
 * platform records, and the graph therefore contains no edge connecting them.
 * Any router that treats "same station" as an equality test will either fail to
 * find the transfer or, worse, invent a zero-second one. A rider changing from
 * the Kelana Jaya line to the Ampang line at Masjid Jamek walks the concourse,
 * crosses to the other platform and waits for the next train; that is 3–5 minutes
 * of real journey time, and on a bad day it is the difference between making the
 * connection and not.
 *
 * This module encodes that reality:
 *
 *   transferSeconds = in-station walk + expected platform wait
 *
 *   - The in-station walk is `max(coordinate-derived distance model,
 *     curated published-layout minimum)`. The coordinate term is data-backed:
 *     platform lat/lon are transcribed from the committed
 *     `data/gtfs-static/rapid-rail-kl/stops.txt` and re-verified by
 *     `tests/risk/interchange.test.ts`. The curated term covers the fact that
 *     straight-line distance systematically understates the walk at the big
 *     interchanges, where the path goes up a level, along a linkway and down
 *     again (Masjid Jamek AG/SP <-> KJ is 69 m apart but a ~3-minute walk).
 *   - The platform wait is `headway / 2` for the connecting line, taken from the
 *     real published frequencies in `lib/risk/headway.ts`, and can be degraded by
 *     an active disruption so a transfer onto a disrupted line is priced as the
 *     long, uncertain wait it actually is.
 *
 * HONESTY NOTE: the curated walk minima are engineering estimates calibrated to
 * published station layouts and typical walk speeds. They are NOT field-measured.
 * The coordinate term is measured. Both are stated in the returned estimate so
 * the UI and the Source Inspector can show which basis was used.
 *
 * GTFS QUIRK HANDLED HERE: `stops.txt` labels MRT Kajang platforms with
 * `route_id = "MRT"` while `routes.txt` calls the line `"KGL"`. The canonical
 * line id is used throughout; `STOP_ROUTE_ID_TO_LINE_ID` records the alias.
 */

import type { IssueType, LineId, Severity, StationId } from "@/lib/contracts";
import {
  SERVICE_DAY_START_SECONDS,
  baseHeadwaySeconds,
  degradedHeadwaySeconds,
  expectedPlatformWaitSeconds,
} from "./headway";

/* ------------------------------------------------------------------ *
 * Physical model constants
 * ------------------------------------------------------------------ */

/** Vertical circulation (one escalator flight or stairs) before any walking. */
export const CIRCULATION_BASE_SECONDS = 45;
/** In-station walking speed, m/s. Slower than street walking: crowds, bags, stairs. */
export const WALK_SPEED_MPS = 1.1;
/** Crossing the platform to the other side of the same island. */
export const SAME_PLATFORM_WALK_SECONDS = 45;
/** Fallback platform wait when the line's headway is unknown (no service window). */
export const UNKNOWN_HEADWAY_FALLBACK_SECONDS = 600;

/** `stops.txt` route_id -> canonical line id from `routes.txt`. */
export const STOP_ROUTE_ID_TO_LINE_ID: Readonly<Record<string, LineId>> = {
  MRT: "KGL", // stops.txt calls the MRT Kajang line "MRT"; routes.txt calls it "KGL"
};

/* ------------------------------------------------------------------ *
 * The interchange table
 * ------------------------------------------------------------------ */

export interface InterchangePlatform {
  stationId: StationId;
  /** Canonical line id (see STOP_ROUTE_ID_TO_LINE_ID). */
  lineId: LineId;
  /** Transcribed from `data/gtfs-static/rapid-rail-kl/stops.txt`. */
  lat: number;
  lon: number;
}

export interface InterchangeCluster {
  name: string;
  platforms: readonly InterchangePlatform[];
  /**
   * Line groups that share an island platform. `AG` and `PH` share the Ampang /
   * Sri Petaling city core, so changing between them is a step across, not a walk.
   */
  samePlatformGroups: readonly (readonly LineId[])[];
  /** Curated minimum walk for a cross-group change, seconds (engineering estimate). */
  curatedMinWalkSeconds: number;
  /** Optional per-pair overrides, key `"A>B"` with A < B lexicographically. */
  pairWalkSeconds?: Readonly<Record<string, number>>;
  note: string;
}

export const INTERCHANGE_CLUSTERS: readonly InterchangeCluster[] = [
  {
    name: "AMPANG PARK",
    platforms: [
      { stationId: "KJ9", lineId: "KJ", lat: 3.159894, lon: 101.719017 },
      { stationId: "PY20", lineId: "PYL", lat: 3.16225, lon: 101.71781 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 300,
    note: "KJ and PYL platforms are linked by a long paid-area linkway.",
  },
  {
    name: "BANDAR UTAMA",
    platforms: [
      { stationId: "KG09", lineId: "KGL", lat: 3.14671, lon: 101.618599 },
      { stationId: "SA1", lineId: "SA", lat: 3.144722, lon: 101.618611 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 180,
    note: "MRT Kajang to Shah Alam Line interchange at 1 Utama.",
  },
  {
    name: "BANDARAYA - UOB",
    platforms: [
      { stationId: "AG6", lineId: "AG", lat: 3.155567, lon: 101.694485 },
      { stationId: "SP6", lineId: "PH", lat: 3.155567, lon: 101.694485 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "AG/PH share the same island platform on the city core.",
  },
  {
    name: "BUKIT BINTANG",
    platforms: [
      { stationId: "KG18A", lineId: "KGL", lat: 3.146503, lon: 101.710947 },
      { stationId: "MR6", lineId: "MR", lat: 3.146022, lon: 101.7115 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 120,
    note: "MRT Kajang to Monorail, linked across Jalan Bukit Bintang.",
  },
  {
    name: "CHAN SOW LIN",
    platforms: [
      { stationId: "AG11", lineId: "AG", lat: 3.128105, lon: 101.715637 },
      { stationId: "SP11", lineId: "PH", lat: 3.128105, lon: 101.715637 },
      { stationId: "PY24", lineId: "PYL", lat: 3.12839, lon: 101.71663 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: 180,
    note: "AG/PH island platform to the MRT Putrajaya platforms.",
  },
  {
    name: "HANG TUAH",
    platforms: [
      { stationId: "AG9", lineId: "AG", lat: 3.140012, lon: 101.705984 },
      { stationId: "SP9", lineId: "PH", lat: 3.140012, lon: 101.705984 },
      { stationId: "MR4", lineId: "MR", lat: 3.140511, lon: 101.706029 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: 150,
    note: "AG/PH island platform to the Monorail, across a link bridge.",
  },
  {
    name: "KL SENTRAL",
    platforms: [
      { stationId: "KJ15", lineId: "KJ", lat: 3.13442, lon: 101.68625 },
      { stationId: "MR1", lineId: "MR", lat: 3.132852, lon: 101.687817 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 240,
    note: "KJ and Monorail termini are at opposite ends of the Sentral complex.",
  },
  {
    name: "KWASA DAMANSARA",
    platforms: [
      { stationId: "KG04", lineId: "KGL", lat: 3.176146, lon: 101.572052 },
      { stationId: "PY01", lineId: "PYL", lat: 3.1763324, lon: 101.5721456 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 90,
    note: "Shared terminus; MRT Kajang and Putrajaya platforms are adjacent.",
  },
  {
    name: "MALURI",
    platforms: [
      { stationId: "AG13", lineId: "AG", lat: 3.12329, lon: 101.727283 },
      { stationId: "KG22", lineId: "KGL", lat: 3.123623, lon: 101.727809 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 150,
    note: "Ampang Line to MRT Kajang, linked by a pedestrian bridge.",
  },
  {
    name: "MASJID JAMEK",
    platforms: [
      { stationId: "AG7", lineId: "AG", lat: 3.14927, lon: 101.696377 },
      { stationId: "SP7", lineId: "PH", lat: 3.14927, lon: 101.696377 },
      { stationId: "KJ13", lineId: "KJ", lat: 3.149714, lon: 101.696815 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: 180,
    note: "AG/SP share an island platform; KJ is a separate station 69 m away across the river.",
  },
  {
    name: "PASAR SENI",
    platforms: [
      { stationId: "KJ14", lineId: "KJ", lat: 3.142439, lon: 101.69531 },
      { stationId: "KG16", lineId: "KGL", lat: 3.142293265, lon: 101.6955642 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 150,
    note: "Kelana Jaya Line to MRT Kajang via the underground paid link.",
  },
  {
    name: "PLAZA RAKYAT",
    platforms: [
      { stationId: "AG8", lineId: "AG", lat: 3.144049, lon: 101.702105 },
      { stationId: "SP8", lineId: "PH", lat: 3.144049, lon: 101.702105 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "AG/PH share the same island platform on the city core.",
  },
  {
    name: "PUDU",
    platforms: [
      { stationId: "AG10", lineId: "AG", lat: 3.134879, lon: 101.711957 },
      { stationId: "SP10", lineId: "PH", lat: 3.134879, lon: 101.711957 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "AG/PH share the same island platform on the city core.",
  },
  {
    name: "PUTRA HEIGHTS",
    platforms: [
      { stationId: "KJ37", lineId: "KJ", lat: 2.996227, lon: 101.575462 },
      { stationId: "SP31", lineId: "PH", lat: 2.996016, lon: 101.575521 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 60,
    note: "Shared terminus; KJ and PH platforms are adjacent.",
  },
  {
    name: "PWTC",
    platforms: [
      { stationId: "AG4", lineId: "AG", lat: 3.166333, lon: 101.693586 },
      { stationId: "SP4", lineId: "PH", lat: 3.166333, lon: 101.693586 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "AG/PH share the same island platform on the city core.",
  },
  {
    name: "SENTUL TIMUR",
    platforms: [
      { stationId: "AG1", lineId: "AG", lat: 3.185897, lon: 101.695217 },
      { stationId: "SP1", lineId: "PH", lat: 3.185897, lon: 101.695217 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "Shared terminus of the Ampang and Sri Petaling lines.",
  },
  {
    name: "SENTUL",
    platforms: [
      { stationId: "AG2", lineId: "AG", lat: 3.178484, lon: 101.695542 },
      { stationId: "SP2", lineId: "PH", lat: 3.178484, lon: 101.695542 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "AG/PH share the same island platform on the city core.",
  },
  {
    name: "SULTAN ISMAIL",
    platforms: [
      { stationId: "AG5", lineId: "AG", lat: 3.161245, lon: 101.694109 },
      { stationId: "SP5", lineId: "PH", lat: 3.161245, lon: 101.694109 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: SAME_PLATFORM_WALK_SECONDS,
    note: "AG/PH share the same island platform on the city core.",
  },
  {
    name: "SUNGAI BESI",
    platforms: [
      { stationId: "SP16", lineId: "PH", lat: 3.063842, lon: 101.708062 },
      { stationId: "PY29", lineId: "PYL", lat: 3.063737, lon: 101.7084 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 180,
    note: "Sri Petaling Line to MRT Putrajaya, linked across the depot road.",
  },
  {
    name: "TITIWANGSA",
    platforms: [
      { stationId: "AG3", lineId: "AG", lat: 3.173497, lon: 101.695367 },
      { stationId: "SP3", lineId: "PH", lat: 3.173497, lon: 101.695367 },
      { stationId: "PY17", lineId: "PYL", lat: 3.17408, lon: 101.69581 },
      { stationId: "MR11", lineId: "MR", lat: 3.173192, lon: 101.696022 },
    ],
    samePlatformGroups: [["AG", "PH"]],
    curatedMinWalkSeconds: 240,
    pairWalkSeconds: {
      "AG3>MR11": 300,
      "AG3>PY17": 240,
      "MR11>PY17": 330,
    },
    note: "Four platforms; the Monorail is the furthest, reached by a covered walkway.",
  },
  {
    name: "TUN RAZAK EXCHANGE",
    platforms: [
      { stationId: "KG20", lineId: "KGL", lat: 3.142403, lon: 101.720156 },
      { stationId: "PY23", lineId: "PYL", lat: 3.14289, lon: 101.72034 },
    ],
    samePlatformGroups: [],
    curatedMinWalkSeconds: 120,
    note: "MRT Kajang to MRT Putrajaya, both underground and adjacent.",
  },
];

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

const CLUSTER_BY_STATION: ReadonlyMap<StationId, InterchangeCluster> = (() => {
  const map = new Map<StationId, InterchangeCluster>();
  for (const cluster of INTERCHANGE_CLUSTERS) {
    for (const platform of cluster.platforms) map.set(platform.stationId, cluster);
  }
  return map;
})();

export function findInterchangeCluster(stationId: StationId): InterchangeCluster | undefined {
  return CLUSTER_BY_STATION.get(stationId);
}

export function isInterchangeStation(stationId: StationId): boolean {
  const cluster = CLUSTER_BY_STATION.get(stationId);
  if (!cluster) return false;
  return cluster.platforms.length > 1;
}

/** Great-circle distance in meters. Pure. */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function pairKey(a: StationId, b: StationId): string {
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

function sameGroup(cluster: InterchangeCluster, a: LineId, b: LineId): boolean {
  if (a === b) return true;
  return cluster.samePlatformGroups.some((g) => g.includes(a) && g.includes(b));
}

export type WalkBasis = "same-platform" | "curated-minimum" | "distance-model";

export interface WalkEstimate {
  seconds: number;
  straightLineMeters: number;
  basis: WalkBasis;
  note: string;
}

/**
 * In-station walk between two platforms of the same interchange cluster.
 * Throws when the two stations are not in the same cluster: a transfer that does
 * not exist must never be priced as if it did.
 */
export function estimateWalkSeconds(from: StationId, to: StationId): WalkEstimate {
  const cluster = CLUSTER_BY_STATION.get(from);
  if (!cluster || CLUSTER_BY_STATION.get(to) !== cluster) {
    throw new Error(
      `estimateWalkSeconds: ${from} and ${to} are not platforms of the same interchange cluster`,
    );
  }
  const a = cluster.platforms.find((p) => p.stationId === from);
  const b = cluster.platforms.find((p) => p.stationId === to);
  if (!a || !b) {
    throw new Error(`estimateWalkSeconds: unknown platform in ${cluster.name}`);
  }

  const straightLineMeters = Math.round(haversineMeters(a, b));
  if (sameGroup(cluster, a.lineId, b.lineId)) {
    return {
      seconds: SAME_PLATFORM_WALK_SECONDS,
      straightLineMeters,
      basis: "same-platform",
      note: `${a.lineId}/${b.lineId} share an island platform at ${cluster.name}.`,
    };
  }

  const distanceModelSeconds = CIRCULATION_BASE_SECONDS + straightLineMeters / WALK_SPEED_MPS;
  const override = cluster.pairWalkSeconds?.[pairKey(from, to)];
  const curated = override ?? cluster.curatedMinWalkSeconds;
  const useCurated = curated > distanceModelSeconds;

  return {
    seconds: Math.round(useCurated ? curated : distanceModelSeconds),
    straightLineMeters,
    basis: useCurated ? "curated-minimum" : "distance-model",
    note: useCurated
      ? `${cluster.name}: curated ${curated} s in-station walk (${straightLineMeters} m straight line; ` +
        `${cluster.note})`
      : `${cluster.name}: ${straightLineMeters} m straight line at ${WALK_SPEED_MPS} m/s ` +
        `plus ${CIRCULATION_BASE_SECONDS} s circulation (${cluster.note})`,
  };
}

/* ------------------------------------------------------------------ *
 * Full transfer estimate
 * ------------------------------------------------------------------ */

export interface TransferEstimateInput {
  fromStationId: StationId;
  toStationId: StationId;
  /** Line being boarded. Defaults to the `to` platform's line. */
  connectingLineId?: LineId;
  /** Overrides the published headway (e.g. a degraded headway from a signal). */
  connectingHeadwaySeconds?: number;
  /** Local seconds after midnight of the transfer. */
  atTime?: number;
  /** 0 = Sunday. Defaults to Monday. */
  serviceWeekday?: number;
  /** When present, the connecting line's headway is degraded by this disruption. */
  disruption?: {
    severity: Severity;
    issueType: IssueType;
    confidence: number;
    isOngoing: boolean;
  };
}

export interface TransferEstimate {
  fromStationId: StationId;
  toStationId: StationId;
  clusterName: string;
  isSamePlatform: boolean;
  walkSeconds: number;
  straightLineMeters: number;
  walkBasis: WalkBasis;
  /** Published headway used for the wait, seconds. */
  headwaySeconds: number;
  /** True when `disruption` degraded the headway. */
  headwayDegraded: boolean;
  platformWaitSeconds: number;
  totalSeconds: number;
  note: string;
}

/**
 * Full interchange transfer time, or `null` when the two stations are not
 * platforms of the same interchange. Returning `null` rather than a number is
 * deliberate: the caller must decide what to do about an impossible transfer,
 * and must never silently price it as zero.
 */
export function estimateTransferSeconds(
  input: TransferEstimateInput,
): TransferEstimate | null {
  const cluster = CLUSTER_BY_STATION.get(input.fromStationId);
  if (!cluster || CLUSTER_BY_STATION.get(input.toStationId) !== cluster) return null;

  const toPlatform = cluster.platforms.find((p) => p.stationId === input.toStationId);
  if (!toPlatform) return null;

  const walk = estimateWalkSeconds(input.fromStationId, input.toStationId);
  const lineId = input.connectingLineId ?? toPlatform.lineId;
  const atTime = input.atTime ?? SERVICE_DAY_START_SECONDS;
  const serviceWeekday = input.serviceWeekday ?? 1;

  const published =
    input.connectingHeadwaySeconds ?? baseHeadwaySeconds(lineId, atTime, serviceWeekday);
  const headway = published ?? UNKNOWN_HEADWAY_FALLBACK_SECONDS;

  const degraded =
    input.disruption !== undefined
      ? degradedHeadwaySeconds(headway, {
          severity: input.disruption.severity,
          issueType: input.disruption.issueType,
          confidence: input.disruption.confidence,
          atTime,
          isOngoing: input.disruption.isOngoing,
        })
      : headway;

  const platformWaitSeconds = expectedPlatformWaitSeconds(degraded);
  const totalSeconds = Math.round(walk.seconds + platformWaitSeconds);
  const samePlatform = walk.basis === "same-platform";

  const parts = [
    `${cluster.name}: ${walk.seconds} s ${samePlatform ? "cross-platform" : "in-station"} walk (${walk.basis})`,
    `${Math.round(degraded)} s headway on ${lineId}${input.disruption ? " (degraded by an active disruption)" : ""}`,
    `${Math.round(platformWaitSeconds)} s expected platform wait`,
  ];

  return {
    fromStationId: input.fromStationId,
    toStationId: input.toStationId,
    clusterName: cluster.name,
    isSamePlatform: samePlatform,
    walkSeconds: walk.seconds,
    straightLineMeters: walk.straightLineMeters,
    walkBasis: walk.basis,
    headwaySeconds: degraded,
    headwayDegraded: input.disruption !== undefined && degraded > headway,
    platformWaitSeconds,
    totalSeconds,
    note: parts.join("; ") + ".",
  };
}
