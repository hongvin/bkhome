/**
 * Mock disruption signals.
 *
 * These are hand-authored fixtures, NOT live data — but every field is a real
 * `DisruptionSignal` and the geography (segment ids, station ids, line ids) is
 * real, taken from the committed GTFS topology. `firstSeenAt` /
 * `operatorNotifiedAt` are the product: the gap between them is the lead time.
 *
 * The headline fixture (SIG-KGL-TRACK) is the one that flips the ranking on the
 * default KLCC -> Kajang trip: the fastest route crosses it, so the slower but
 * safer route wins.
 */
import type { DisruptionSignal, IssueType, Severity, SourceRef } from "@/lib/contracts";
import { confidenceBand } from "@/lib/contracts";

import { isoMinutesBeforeDemoNow, toKlIso, DEMO_NOW_MS } from "./clock";

interface SourceSeed {
  id: string;
  sourceClass: SourceRef["sourceClass"];
  url?: string;
  authorId?: string;
  authorHandle?: string;
  title?: string;
  rawText: string;
  minutesBeforeNow: number;
  language: SourceRef["language"];
}

function source(seed: SourceSeed): SourceRef {
  const publishedMs = DEMO_NOW_MS - seed.minutesBeforeNow * 60_000;
  return {
    id: seed.id,
    sourceClass: seed.sourceClass,
    url: seed.url,
    authorId: seed.authorId,
    authorHandle: seed.authorHandle,
    title: seed.title,
    rawText: seed.rawText,
    publishedAt: toKlIso(publishedMs),
    retrievedAt: toKlIso(publishedMs + 90_000),
    language: seed.language,
    contentHash: hashLike(`${seed.id}:${seed.rawText}`),
  };
}

/** Stable, non-cryptographic content hash for fixture provenance only. */
function hashLike(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `sha256:${hex(h1)}${hex(h2)}${hex(h1 ^ h2)}${hex((h1 + h2) >>> 0)}`;
}

interface SignalSeed {
  id: string;
  issueType: IssueType;
  severity: Severity;
  segmentIds: string[];
  stationIds: string[];
  lineIds: string[];
  status: DisruptionSignal["status"];
  resolution: DisruptionSignal["resolution"];
  unresolvedCandidates?: string[];
  confidence: number;
  factors: DisruptionSignal["confidence"]["factors"];
  firstSeenMinutesBeforeNow: number;
  operatorNotifiedMinutesBeforeNow: number | null;
  official: number;
  socialDistinctAuthors: number;
  realtimeObservations: number;
  reasoning: string;
  wouldAHumanCheckThis: boolean;
  sources: SourceRef[];
}

function buildSignal(seed: SignalSeed): DisruptionSignal {
  const firstSeenMs = DEMO_NOW_MS - seed.firstSeenMinutesBeforeNow * 60_000;
  const notifiedMs =
    seed.operatorNotifiedMinutesBeforeNow === null
      ? null
      : DEMO_NOW_MS - seed.operatorNotifiedMinutesBeforeNow * 60_000;
  const leadTimeMinutes =
    notifiedMs === null
      ? null
      : Math.round((notifiedMs - firstSeenMs) / 60_000);
  const lastSeenMs = DEMO_NOW_MS - 2 * 60_000;

  const confidence = {
    value: seed.confidence,
    calibrationVersion: "mock-fixture-v1",
    factors: seed.factors,
    band: confidenceBand(seed.confidence),
    degradedByOfflineCache: false,
  };

  // Confidence RISES along the pipeline: a raw ingest is weak evidence, the
  // verified score is the calibrated one, and the advisory hop is where it has
  // been reconciled with everything else we know. A3 requires this trace.
  const hops: DisruptionSignal["provenance"] = [
    {
      hop: "INGEST",
      at: toKlIso(firstSeenMs),
      confidence: round3(seed.confidence * 0.55),
      summary:
        seed.official > 0
          ? `First evidence captured from ${seed.official} official source(s).`
          : `First evidence captured from ${seed.socialDistinctAuthors} distinct social author(s); no official source yet.`,
    },
    {
      hop: "VERIFY",
      at: toKlIso(firstSeenMs + 4 * 60_000),
      confidence: round3(seed.confidence * 0.82),
      summary: `Deduplicated reposts and calibrated to ${seed.confidence.toFixed(2)} (${confidence.band}).`,
    },
    {
      hop: "IMPACT",
      at: toKlIso(firstSeenMs + 6 * 60_000),
      confidence: round3(seed.confidence * 0.93),
      summary:
        seed.segmentIds.length > 0
          ? `Resolved to ${seed.segmentIds.length} directional segment(s) on ${seed.lineIds.join(", ")}.`
          : "Station-level only; no directional segment is affected.",
    },
    {
      hop: "ADVISORY",
      at: toKlIso(DEMO_NOW_MS - 14 * 60_000),
      confidence: seed.confidence,
      summary:
        seed.segmentIds.length > 0
          ? "Fed into the risk penalty used to rank routes."
          : "Recorded but does not change any route ranking.",
    },
  ];

  return {
    id: seed.id,
    createdAt: toKlIso(firstSeenMs),
    updatedAt: toKlIso(lastSeenMs),
    status: seed.status,
    segmentIds: seed.segmentIds,
    stationIds: seed.stationIds,
    lineIds: seed.lineIds,
    resolution: seed.resolution,
    unresolvedCandidates: seed.unresolvedCandidates,
    issueType: seed.issueType,
    severity: seed.severity,
    confidence,
    firstSeenAt: toKlIso(firstSeenMs),
    lastSeenAt: toKlIso(lastSeenMs),
    operatorNotifiedAt: notifiedMs === null ? null : toKlIso(notifiedMs),
    leadTimeMinutes,
    corroboratingSources: {
      official: seed.official,
      socialDistinctAuthors: seed.socialDistinctAuthors,
      realtimeObservations: seed.realtimeObservations,
    },
    sources: seed.sources,
    reasoning: seed.reasoning,
    wouldAHumanCheckThis: seed.wouldAHumanCheckThis,
    window: { startsAt: toKlIso(firstSeenMs), endsAt: null },
    provenance: hops,
  };
}

function round3(v: number): number {
  return Number(v.toFixed(3));
}

/* ------------------------------------------------------------------ */
/* 1. THE HEADLINE SIGNAL — a severe track fault on the MRT Kajang line */
/* ------------------------------------------------------------------ */

const SIG_KGL_TRACK = buildSignal({
  id: "SIG-KGL-TRACK-0317",
  issueType: "TRACK_FAULT",
  severity: "SEVERE",
  segmentIds: ["KGL:KG17->KG18A"],
  stationIds: ["KG17", "KG18A"],
  lineIds: ["KGL"],
  status: "CONFIRMED",
  resolution: "RESOLVED",
  confidence: 0.82,
  factors: [
    {
      name: "official_corroboration",
      weight: 0.4,
      contribution: 0.36,
      note: "Rapid KL issued a media statement naming the affected stretch.",
    },
    {
      name: "distinct_social_authors",
      weight: 0.3,
      contribution: 0.27,
      note: "6 distinct authors reported trains held between Merdeka and Bukit Bintang; reposts excluded.",
    },
    {
      name: "realtime_observations",
      weight: 0.2,
      contribution: 0.13,
      note: "3 consecutive headways missed at Bukit Bintang in the live feed.",
    },
    {
      name: "source_recency",
      weight: 0.1,
      contribution: 0.06,
      note: "Freshest observation is under 3 minutes old.",
    },
  ],
  firstSeenMinutesBeforeNow: 74,
  operatorNotifiedMinutesBeforeNow: 21,
  official: 1,
  socialDistinctAuthors: 6,
  realtimeObservations: 3,
  reasoning:
    "Six distinct riders reported trains held between Merdeka and Bukit Bintang from 07:12, and Rapid KL's 08:05 media statement names the same stretch. The operator confirmed 53 minutes after our first sighting, so the segment is priced as severely degraded.",
  wouldAHumanCheckThis: true,
  sources: [
    source({
      id: "SRC-KGL-TRACK-OFFICIAL",
      sourceClass: "OFFICIAL_STATEMENT",
      url: "https://myrapid.com.my/media-statement/mrt-kajang-17-mac",
      title: "KENYATAAN MEDIA — Gangguan perkhidmatan MRT Laluan Kajang",
      rawText:
        "KENYATAAN MEDIA: Gangguan perkhidmatan di antara stesen Merdeka dan Bukit Bintang akibat kerosakan landasan. Tren bergerak pada kelajuan terhad dan masa menunggu dijangka lebih lama. Pasukan teknikal sedang berada di lokasi.",
      minutesBeforeNow: 21,
      language: "ms",
    }),
    source({
      id: "SRC-KGL-TRACK-SOCIAL-1",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/1",
      authorId: "u-8812",
      authorHandle: "@farahrides",
      rawText:
        "MRT Kajang stall kat Bukit Bintang dah 20 minit tak bergerak. Announcement cakap track fault. Ramai orang turun cari Grab.",
      minutesBeforeNow: 74,
      language: "ms",
    }),
    source({
      id: "SRC-KGL-TRACK-SOCIAL-2",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/2",
      authorId: "u-4409",
      authorHandle: "@kjcommuter",
      rawText:
        "Train held before Bukit Bintang for 15 minutes. Driver says there is a track issue ahead. Nothing on the official channels yet.",
      minutesBeforeNow: 70,
      language: "en",
    }),
    source({
      id: "SRC-KGL-TRACK-SOCIAL-3",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/3",
      authorId: "u-2231",
      authorHandle: "@anna_kl",
      rawText:
        "Merdeka station pun sama, tren berhenti lama. Nampak orang teknikal pakai vest turun ke landasan.",
      minutesBeforeNow: 61,
      language: "ms",
    }),
    source({
      id: "SRC-KGL-TRACK-SOCIAL-4",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/4",
      authorId: "u-9917",
      authorHandle: "@transitwatch_my",
      rawText:
        "Third missed headway in a row at Bukit Bintang. Platform is filling up. #MRTKajang",
      minutesBeforeNow: 48,
      language: "en",
    }),
    source({
      id: "SRC-KGL-TRACK-SOCIAL-5",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/5",
      authorId: "u-3320",
      authorHandle: "@hafiz_work",
      rawText:
        "Kalau nak ke Kajang, elak naik dari Pasar Seni. Better turun Maluri. Track rosak depan Bukit Bintang.",
      minutesBeforeNow: 35,
      language: "ms",
    }),
    source({
      id: "SRC-KGL-TRACK-SOCIAL-6",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/6",
      authorId: "u-7712",
      authorHandle: "@chengkltravels",
      rawText:
        "Still crawling between TRX and Bukit Bintang. 25 minutes for one stop.",
      minutesBeforeNow: 12,
      language: "en",
    }),
    source({
      id: "SRC-KGL-TRACK-RT",
      sourceClass: "OFFICIAL_REALTIME",
      title: "Headway monitor — KG17/KG18A",
      rawText:
        "Observed headway 07:14 = 9m40s against 3m00s scheduled. 07:22 = 11m05s. 07:31 = 10m20s.",
      minutesBeforeNow: 55,
      language: "en",
    }),
  ],
});

/* ------------------------------------------------------- */
/* 2. The mild delay that sits on the SAFE alternative      */
/* ------------------------------------------------------- */

const SIG_AG_DELAY = buildSignal({
  id: "SIG-AG-DELAY-0317",
  issueType: "DELAY",
  severity: "MINOR",
  segmentIds: ["AG:AG9->AG10"],
  stationIds: ["AG9", "AG10"],
  lineIds: ["AG"],
  status: "REPORTED",
  resolution: "RESOLVED",
  confidence: 0.31,
  factors: [
    {
      name: "official_corroboration",
      weight: 0.4,
      contribution: 0,
      note: "No operator statement; Rapid KL has not mentioned Hang Tuah today.",
    },
    {
      name: "distinct_social_authors",
      weight: 0.3,
      contribution: 0.19,
      note: "3 distinct authors describe slow running between Hang Tuah and Pudu.",
    },
    {
      name: "realtime_observations",
      weight: 0.2,
      contribution: 0.05,
      note: "One headway slightly over schedule; within normal variation.",
    },
    {
      name: "source_recency",
      weight: 0.1,
      contribution: 0.07,
      note: "Reports are 20-30 minutes old and thinning out.",
    },
  ],
  firstSeenMinutesBeforeNow: 28,
  operatorNotifiedMinutesBeforeNow: null,
  official: 0,
  socialDistinctAuthors: 3,
  realtimeObservations: 1,
  reasoning:
    "Three riders describe slow running between Hang Tuah and Pudu, but there is no operator statement and only one weak headway deviation. Treated as minor and not hard-avoided.",
  wouldAHumanCheckThis: true,
  sources: [
    source({
      id: "SRC-AG-DELAY-SOCIAL-1",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/11",
      authorId: "u-5510",
      authorHandle: "@ampanglineuser",
      rawText:
        "LRT Ampang slow sikit antara Hang Tuah dengan Pudu pagi ni. Tambah 5 minit je, masih okay.",
      minutesBeforeNow: 28,
      language: "ms",
    }),
    source({
      id: "SRC-AG-DELAY-SOCIAL-2",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/12",
      authorId: "u-6642",
      authorHandle: "@pudu_pat",
      rawText: "Waiting longer than usual at Pudu, maybe 6 minutes. No announcement.",
      minutesBeforeNow: 22,
      language: "en",
    }),
    source({
      id: "SRC-AG-DELAY-SOCIAL-3",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/13",
      authorId: "u-1188",
      authorHandle: "@shahril_kl",
      rawText: "Ampang line ok je dari Chan Sow Lin, cuma slow dekat Pudu.",
      minutesBeforeNow: 15,
      language: "ms",
    }),
  ],
});

/* --------------------------------------------- */
/* 3. Off-route major: MRT Putrajaya breakdown   */
/* --------------------------------------------- */

const SIG_PYL_BREAKDOWN = buildSignal({
  id: "SIG-PYL-BREAKDOWN-0317",
  issueType: "VEHICLE_BREAKDOWN",
  severity: "MAJOR",
  segmentIds: ["PYL:PY18->PY19"],
  stationIds: ["PY18", "PY19"],
  lineIds: ["PYL"],
  status: "CONFIRMED",
  resolution: "RESOLVED",
  confidence: 0.71,
  factors: [
    {
      name: "official_corroboration",
      weight: 0.4,
      contribution: 0.31,
      note: "Operator acknowledged a stalled train at Hospital Kuala Lumpur.",
    },
    {
      name: "distinct_social_authors",
      weight: 0.3,
      contribution: 0.22,
      note: "4 distinct authors report a train held at the platform.",
    },
    {
      name: "realtime_observations",
      weight: 0.2,
      contribution: 0.12,
      note: "Two consecutive missed headways northbound.",
    },
    {
      name: "source_recency",
      weight: 0.1,
      contribution: 0.06,
      note: "Latest update is 4 minutes old.",
    },
  ],
  firstSeenMinutesBeforeNow: 51,
  operatorNotifiedMinutesBeforeNow: 34,
  official: 1,
  socialDistinctAuthors: 4,
  realtimeObservations: 2,
  reasoning:
    "A stalled train at Hospital Kuala Lumpur was reported by four riders at 07:35 and acknowledged by the operator 17 minutes later. Only the northbound direction is affected.",
  wouldAHumanCheckThis: true,
  sources: [
    source({
      id: "SRC-PYL-BREAKDOWN-OFFICIAL",
      sourceClass: "OFFICIAL_STATEMENT",
      url: "https://myrapid.com.my/media-statement/mrt-putrajaya-17-mac",
      title: "KENYATAAN MEDIA — Kelewatan MRT Laluan Putrajaya",
      rawText:
        "KENYATAAN MEDIA: Kelewatan dijangka di Laluan Putrajaya arah Kwasa Damansara berikutan tren yang mengalami kerosakan di Stesen Hospital Kuala Lumpur. Tren sedang dikeluarkan.",
      minutesBeforeNow: 34,
      language: "ms",
    }),
    source({
      id: "SRC-PYL-BREAKDOWN-SOCIAL-1",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/21",
      authorId: "u-2201",
      authorHandle: "@pyline_ rider",
      rawText: "Train stuck at Hospital KL for 12 minutes. Doors closed, no movement.",
      minutesBeforeNow: 51,
      language: "en",
    }),
    source({
      id: "SRC-PYL-BREAKDOWN-SOCIAL-2",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/22",
      authorId: "u-3345",
      authorHandle: "@kaklong_keja",
      rawText: "MRT Putrajaya arah Kwasa Damansara tersangkut dekat Hospital KL. Dah 2 tren lepas tak datang.",
      minutesBeforeNow: 44,
      language: "ms",
    }),
    source({
      id: "SRC-PYL-BREAKDOWN-SOCIAL-3",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/23",
      authorId: "u-8123",
      authorHandle: "@sentul_commuter",
      rawText: "Same issue again on the Putrajaya line northbound. Third time this week.",
      minutesBeforeNow: 30,
      language: "en",
    }),
    source({
      id: "SRC-PYL-BREAKDOWN-SOCIAL-4",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/24",
      authorId: "u-4410",
      authorHandle: "@jlnipoh_jenny",
      rawText: "Platform 2 quite crowded now. Staff saying the faulty train is being moved.",
      minutesBeforeNow: 16,
      language: "en",
    }),
  ],
});

/* ------------------------------------------------ */
/* 4. Off-route major: Kelana Jaya signal fault      */
/* ------------------------------------------------ */

const SIG_KJ_SIGNAL = buildSignal({
  id: "SIG-KJ-SIGNAL-0317",
  issueType: "SIGNAL_FAULT",
  severity: "MAJOR",
  segmentIds: ["KJ:KJ16->KJ15"],
  stationIds: ["KJ16", "KJ15"],
  lineIds: ["KJ"],
  status: "CONFIRMED",
  resolution: "RESOLVED",
  confidence: 0.64,
  factors: [
    {
      name: "official_corroboration",
      weight: 0.4,
      contribution: 0.26,
      note: "Operator posted a service update naming Bangsar.",
    },
    {
      name: "distinct_social_authors",
      weight: 0.3,
      contribution: 0.2,
      note: "3 distinct authors report signal-related holds.",
    },
    {
      name: "realtime_observations",
      weight: 0.2,
      contribution: 0.12,
      note: "Headways into KL Sentral stretched to 7 minutes.",
    },
    {
      name: "source_recency",
      weight: 0.1,
      contribution: 0.06,
      note: "Update refreshed 8 minutes ago.",
    },
  ],
  firstSeenMinutesBeforeNow: 38,
  operatorNotifiedMinutesBeforeNow: 12,
  official: 1,
  socialDistinctAuthors: 3,
  realtimeObservations: 2,
  reasoning:
    "A signalling problem between Bangsar and KL Sentral was reported by three riders at 07:48 and acknowledged by the operator 26 minutes later. Trains are running but headways into KL Sentral are stretched.",
  wouldAHumanCheckThis: false,
  sources: [
    source({
      id: "SRC-KJ-SIGNAL-OFFICIAL",
      sourceClass: "OFFICIAL_STATEMENT",
      url: "https://myrapid.com.my/media-statement/lrt-kj-17-mac",
      title: "Kemas kini perkhidmatan LRT Kelana Jaya",
      rawText:
        "Kemas kini: Perkhidmatan LRT Laluan Kelana Jaya mengalami kelewatan antara Bangsar dan KL Sentral akibat gangguan isyarat. Tren masih beroperasi.",
      minutesBeforeNow: 12,
      language: "ms",
    }),
    source({
      id: "SRC-KJ-SIGNAL-SOCIAL-1",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/31",
      authorId: "u-7781",
      authorHandle: "@bangsar_bound",
      rawText: "Signal fault between Bangsar and KL Sentral. Trains waiting at the platform.",
      minutesBeforeNow: 38,
      language: "en",
    }),
    source({
      id: "SRC-KJ-SIGNAL-SOCIAL-2",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/32",
      authorId: "u-9021",
      authorHandle: "@aisyahm",
      rawText: "LRT Kelana Jaya lambat masuk KL Sentral, dah 3 kali berhenti tengah jalan.",
      minutesBeforeNow: 27,
      language: "ms",
    }),
    source({
      id: "SRC-KJ-SIGNAL-SOCIAL-3",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/33",
      authorId: "u-1290",
      authorHandle: "@kjline_daily",
      rawText: "7 minute gap at Bangsar. Staff on the platform but no announcement.",
      minutesBeforeNow: 19,
      language: "en",
    }),
  ],
});

/* ------------------------------------------------------- */
/* 5. Off-route minor: Monorail crowding at Bukit Bintang  */
/* ------------------------------------------------------- */

const SIG_MR_CROWD = buildSignal({
  id: "SIG-MR-CROWD-0317",
  issueType: "CROWDING",
  severity: "MINOR",
  segmentIds: ["MR:MR6->MR7"],
  stationIds: ["MR6", "MR7"],
  lineIds: ["MR"],
  status: "REPORTED",
  resolution: "RESOLVED",
  confidence: 0.44,
  factors: [
    {
      name: "official_corroboration",
      weight: 0.4,
      contribution: 0,
      note: "No operator statement about Monorail crowding.",
    },
    {
      name: "distinct_social_authors",
      weight: 0.3,
      contribution: 0.28,
      note: "4 distinct authors describe full platforms at Bukit Bintang.",
    },
    {
      name: "realtime_observations",
      weight: 0.2,
      contribution: 0.1,
      note: "One platform occupancy reading above the crowding threshold.",
    },
    {
      name: "source_recency",
      weight: 0.1,
      contribution: 0.06,
      note: "Reports are under 10 minutes old.",
    },
  ],
  firstSeenMinutesBeforeNow: 24,
  operatorNotifiedMinutesBeforeNow: null,
  official: 0,
  socialDistinctAuthors: 4,
  realtimeObservations: 1,
  reasoning:
    "Four distinct riders report full platforms at Bukit Bintang Monorail with people left behind. No operator statement, so confidence stays moderate rather than high.",
  wouldAHumanCheckThis: true,
  sources: [
    source({
      id: "SRC-MR-CROWD-SOCIAL-1",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/41",
      authorId: "u-3001",
      authorHandle: "@monorail_may",
      rawText: "Bukit Bintang monorail platform is packed. Had to let two trains go.",
      minutesBeforeNow: 24,
      language: "en",
    }),
    source({
      id: "SRC-MR-CROWD-SOCIAL-2",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/42",
      authorId: "u-4102",
      authorHandle: "@nadia_naik",
      rawText: "Penuh sangat Monorail Bukit Bintang pagi ni. Tunggu 3 tren baru boleh naik.",
      minutesBeforeNow: 20,
      language: "ms",
    }),
    source({
      id: "SRC-MR-CROWD-SOCIAL-3",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/43",
      authorId: "u-5501",
      authorHandle: "@bukitbintang_b",
      rawText: "Monorail platform 3 deep. Staff holding people at the escalator.",
      minutesBeforeNow: 14,
      language: "en",
    }),
    source({
      id: "SRC-MR-CROWD-SOCIAL-4",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/44",
      authorId: "u-6612",
      authorHandle: "@izzat_kl",
      rawText: "Sesak gila di Monorail BB, tapi tren masih datang kerap.",
      minutesBeforeNow: 9,
      language: "ms",
    }),
  ],
});

/* ----------------------------------------------------------- */
/* 6. Station-level: lift outage at KLCC (accessibility)        */
/* ----------------------------------------------------------- */

const SIG_KLCC_LIFT = buildSignal({
  id: "SIG-KLCC-LIFT-0317",
  issueType: "ELEVATOR_FAULT",
  severity: "INFO",
  // Station facility issue: there is no directional track segment to attach it to.
  segmentIds: [],
  stationIds: ["KJ10"],
  lineIds: ["KJ"],
  status: "CONFIRMED",
  resolution: "RESOLVED",
  confidence: 0.9,
  factors: [
    {
      name: "official_station_notice",
      weight: 0.5,
      contribution: 0.55,
      note: "Station notice board confirms the lift is out of service.",
    },
    {
      name: "station_staff_report",
      weight: 0.3,
      contribution: 0.25,
      note: "Duty staff confirmed the outage at 07:05.",
    },
    {
      name: "source_recency",
      weight: 0.2,
      contribution: 0.1,
      note: "Notice is current as of this morning.",
    },
  ],
  firstSeenMinutesBeforeNow: 106,
  operatorNotifiedMinutesBeforeNow: 81,
  official: 1,
  socialDistinctAuthors: 1,
  realtimeObservations: 0,
  reasoning:
    "A station notice and duty staff confirm the KLCC concourse lift is out of service. Step-free access is via the Jalan Mayang entrance instead. No track segment is affected.",
  wouldAHumanCheckThis: false,
  sources: [
    source({
      id: "SRC-KLCC-LIFT-OFFICIAL",
      sourceClass: "OFFICIAL_STATEMENT",
      url: "https://myrapid.com.my/station-notice/klcc-lift",
      title: "Notis stesen — Lif KLCC tidak beroperasi",
      rawText:
        "Notis: Lif di aras concourse Stesen KLCC tidak beroperasi buat masa ini. Pengguna boleh menggunakan pintu masuk Jalan Mayang untuk akses tanpa tangga.",
      minutesBeforeNow: 106,
      language: "ms",
    }),
    source({
      id: "SRC-KLCC-LIFT-SOCIAL-1",
      sourceClass: "SOCIAL",
      url: "https://x.com/example/status/51",
      authorId: "u-8801",
      authorHandle: "@wheelchair_kl",
      rawText:
        "KLCC LRT lift still broken this morning. Use the Jalan Mayang side entrance if you need step-free access.",
      minutesBeforeNow: 81,
      language: "en",
    }),
  ],
});

export const MOCK_SIGNALS: DisruptionSignal[] = [
  SIG_KGL_TRACK,
  SIG_PYL_BREAKDOWN,
  SIG_KJ_SIGNAL,
  SIG_MR_CROWD,
  SIG_AG_DELAY,
  SIG_KLCC_LIFT,
];

export function mockSignalById(id: string): DisruptionSignal | undefined {
  return MOCK_SIGNALS.find((s) => s.id === id);
}

/** Segment ids that carry a material signal, for the risk overlay. */
export function mockRiskySegmentIds(): string[] {
  return MOCK_SIGNALS.flatMap((s) => s.segmentIds);
}

export { isoMinutesBeforeDemoNow };
