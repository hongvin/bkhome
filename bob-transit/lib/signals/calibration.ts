/**
 * Deterministic confidence calibration.
 *
 * This is the number the whole product hangs on, so it is a pure function of
 * counted evidence — no randomness, no wall clock, no model call. Every score
 * carries the named factors that produced it, and each factor's `contribution`
 * is a real leave-one-out ablation of the final value, not a decorative label.
 *
 * The reasoning behind the constants lives in ./CALIBRATION.md, which is a
 * deliverable: if you change a constant here, change the table there.
 */

import {
  type ConfidenceFactor,
  type ConfidenceScore,
  confidenceBand,
} from "@/lib/contracts";

/** Bump when any constant below changes; scores are only comparable within a version. */
export const CALIBRATION_VERSION = "s3-calib-1.0.0";

/**
 * Below this calibrated probability we emit NOTHING. Silence is a valid answer:
 * a false positive sends thousands of commuters onto worse routes.
 */
export const REPORTABLE_CONFIDENCE = 0.3;

/**
 * Social channel: distinct-author count -> evidence strength.
 *
 * Justification (see CALIBRATION.md):
 *  - 1 post is an anecdote. It is evidence that *someone said something*, not
 *    that a train stopped.
 *  - 3 independent posts on one segment in one window is the smallest cluster
 *    where the "everyone is stuck" explanation beats "three unrelated people
 *    had a bad morning".
 *  - The channel saturates at 0.60: social evidence alone must never reach the
 *    HIGH band, because a rumour, a retweeted joke or a single misread sign can
 *    all produce a crowd. Only an official source may cross that line.
 */
export const SOCIAL_AUTHOR_TABLE: ReadonlyArray<{ authors: number; strength: number }> = [
  { authors: 0, strength: 0.0 },
  { authors: 1, strength: 0.18 },
  { authors: 2, strength: 0.32 },
  { authors: 3, strength: 0.45 },
  { authors: 4, strength: 0.53 },
  { authors: 5, strength: 0.58 },
  { authors: 6, strength: 0.6 },
];

/** Social strength for a distinct-author count. Monotone non-decreasing. */
export function socialChannelStrength(distinctAuthors: number): number {
  const n = Math.max(0, Math.floor(distinctAuthors));
  const table = SOCIAL_AUTHOR_TABLE;
  if (n >= table[table.length - 1].authors) return table[table.length - 1].strength;
  for (const row of table) if (n === row.authors) return row.strength;
  return table[table.length - 1].strength;
}

/**
 * Official statement channel. An OFFICIAL_STATEMENT is high-precision and high
 * latency: it is a *confirmation*, so its content is trusted fully.
 */
export const OFFICIAL_STATEMENT_BASE = 0.9;

/**
 * OFFICIAL_REALTIME channel. Trust for POSITION, not for HEALTH. A single stalled
 * vehicle is weak evidence of a service fault; the absence of a vehicle is not
 * evidence of a fault at all (it contributes zero observations, not negative
 * ones). The cap keeps realtime-only evidence inside the VERY_LOW band.
 */
export const REALTIME_PER_OBSERVATION = 0.05;
export const REALTIME_CHANNEL_CAP = 0.15;

/** A claim whose location we could not pin down can never be HIGH. */
export const UNRESOLVED_MULTIPLIER = 0.8;
export const UNRESOLVED_CAP = 0.45;

/** An official source explicitly reporting normal service dominates social claims. */
export const OFFICIAL_DENIAL_MULTIPLIER = 0.25;

/** Scores computed from cached state while offline are visibly degraded. */
export const OFFLINE_CACHE_MULTIPLIER = 0.85;

/** Evidence older than the window decays linearly to this floor over 3 windows. */
export const STALE_FLOOR = 0.15;
export const DEFAULT_WINDOW_MINUTES = 90;

export interface CalibrationInput {
  /** DISTINCT, independent, non-repost authors clustered on ONE segment. */
  socialDistinctAuthors: number;
  /** Genuine OFFICIAL_STATEMENT sources (confirmation). */
  officialStatementCount: number;
  /** OFFICIAL_REALTIME observations. Position evidence; weak health evidence. */
  realtimeObservationCount: number;
  /** 0..1 multiplier from authenticity analysis (sarcasm/stale/joke). Default 1. */
  socialQuality?: number;
  /** 0..1 multiplier from official-statement specificity. Default 1. */
  officialQuality?: number;
  /** 0..1 multiplier from realtime relevance. Default 1. */
  realtimeQuality?: number;
  /** Age in minutes of the newest social evidence. */
  newestSocialAgeMinutes?: number | null;
  /** Reporting window length in minutes. */
  windowMinutes?: number;
  /** Location could not be disambiguated to a segment. */
  unresolved?: boolean;
  /** An official source explicitly reports normal service. */
  officialDenial?: boolean;
  /** The score was computed from cached state while offline. */
  degradedByOfflineCache?: boolean;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** Probabilistic sum: independent channels reinforce without ever exceeding 1. */
function noisyOr(channels: number[]): number {
  let inverse = 1;
  for (const c of channels) inverse *= 1 - clamp01(c);
  return 1 - inverse;
}

export interface ChannelBreakdown {
  social: number;
  official: number;
  realtime: number;
  recency: number;
  unresolved: number;
  officialDenial: number;
  offline: number;
}

/** Raw (pre-ablation) channel values, exported so the UI can explain a score. */
export function calibrationChannels(input: CalibrationInput): ChannelBreakdown {
  const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const socialQuality = clamp01(input.socialQuality ?? 1);
  const recency = recencyMultiplier(input.newestSocialAgeMinutes ?? null, windowMinutes);
  return {
    social: clamp01(socialChannelStrength(input.socialDistinctAuthors) * socialQuality * recency),
    official: clamp01(OFFICIAL_STATEMENT_BASE * clamp01(input.officialQuality ?? 1)),
    realtime: clamp01(
      Math.min(REALTIME_CHANNEL_CAP, REALTIME_PER_OBSERVATION * Math.max(0, input.realtimeObservationCount)) *
        clamp01(input.realtimeQuality ?? 1),
    ),
    recency,
    unresolved: input.unresolved ? UNRESOLVED_MULTIPLIER : 1,
    officialDenial: input.officialDenial ? OFFICIAL_DENIAL_MULTIPLIER : 1,
    offline: input.degradedByOfflineCache ? OFFLINE_CACHE_MULTIPLIER : 1,
  };
}

/** Linear decay to STALE_FLOOR over three windows. Fresh evidence is unaffected. */
export function recencyMultiplier(ageMinutes: number | null, windowMinutes: number): number {
  if (ageMinutes === null) return 1;
  const w = Math.max(1, windowMinutes);
  if (ageMinutes <= w) return 1;
  const over = (ageMinutes - w) / (3 * w);
  return Math.max(STALE_FLOOR, 1 - over * (1 - STALE_FLOOR));
}

function rawValue(input: CalibrationInput): number {
  const ch = calibrationChannels(input);
  const combined = noisyOr([ch.social, ch.official, ch.realtime]);
  let value = combined * ch.unresolved * ch.officialDenial * ch.offline;
  if (input.unresolved) value = Math.min(value, UNRESOLVED_CAP);
  return clamp01(value);
}

/** Neutralise exactly one factor, for leave-one-out attribution. */
function ablate(input: CalibrationInput, factor: string): CalibrationInput {
  switch (factor) {
    case "social_distinct_authors":
      return { ...input, socialDistinctAuthors: 0 };
    case "official_statement":
      return { ...input, officialStatementCount: 0 };
    case "realtime_observation":
      return { ...input, realtimeObservationCount: 0 };
    case "social_quality":
      return { ...input, socialQuality: 1 };
    case "official_quality":
      return { ...input, officialQuality: 1 };
    case "realtime_quality":
      return { ...input, realtimeQuality: 1 };
    case "recency":
      return { ...input, newestSocialAgeMinutes: null };
    case "location_resolution":
      return { ...input, unresolved: false };
    case "official_denial":
      return { ...input, officialDenial: false };
    case "offline_cache":
      return { ...input, degradedByOfflineCache: false };
    default:
      return input;
  }
}

/**
 * Calibrate a ConfidenceScore.
 *
 * Monotonicity guarantees (tested):
 *  - increasing `socialDistinctAuthors` never decreases the value,
 *  - adding an official statement raises the value sharply,
 *  - realtime observations alone can never exceed the VERY_LOW band.
 */
export function calibrateConfidence(input: CalibrationInput): ConfidenceScore {
  const value = rawValue(input);
  const ch = calibrationChannels(input);

  const definitions: Array<{ name: string; weight: number; note: string }> = [
    {
      name: "social_distinct_authors",
      weight: input.socialDistinctAuthors,
      note:
        `${input.socialDistinctAuthors} distinct independent author(s) -> social channel ` +
        `${ch.social.toFixed(3)} (repost volume is excluded by construction)`,
    },
    {
      name: "official_statement",
      weight: input.officialStatementCount,
      note:
        `${input.officialStatementCount} official statement(s); trusted as confirmation ` +
        `(base ${OFFICIAL_STATEMENT_BASE})`,
    },
    {
      name: "realtime_observation",
      weight: input.realtimeObservationCount,
      note:
        `${input.realtimeObservationCount} realtime observation(s); position evidence only, ` +
        `capped at ${REALTIME_CHANNEL_CAP}`,
    },
    {
      name: "social_quality",
      weight: clamp01(input.socialQuality ?? 1),
      note: "sarcasm / stale-quote / joke down-weighting applied to the social channel",
    },
    {
      name: "official_quality",
      weight: clamp01(input.officialQuality ?? 1),
      note: "how specific and on-topic the official statement is",
    },
    {
      name: "realtime_quality",
      weight: clamp01(input.realtimeQuality ?? 1),
      note: "how relevant the realtime observation is to the claimed segment",
    },
    {
      name: "recency",
      weight: ch.recency,
      note:
        input.newestSocialAgeMinutes === null || input.newestSocialAgeMinutes === undefined
          ? "no social evidence to age"
          : `newest social evidence ${input.newestSocialAgeMinutes} min old vs ` +
            `${input.windowMinutes ?? DEFAULT_WINDOW_MINUTES} min window`,
    },
    {
      name: "location_resolution",
      weight: input.unresolved ? UNRESOLVED_MULTIPLIER : 1,
      note: input.unresolved
        ? `location unresolved: x${UNRESOLVED_MULTIPLIER}, hard cap ${UNRESOLVED_CAP}`
        : "location resolved to at least one segment",
    },
    {
      name: "official_denial",
      weight: ch.officialDenial,
      note: input.officialDenial
        ? `an official source reports normal service: x${OFFICIAL_DENIAL_MULTIPLIER}`
        : "no official denial of service",
    },
    {
      name: "offline_cache",
      weight: ch.offline,
      note: input.degradedByOfflineCache
        ? `score computed from cached state: x${OFFLINE_CACHE_MULTIPLIER}`
        : "computed from live state",
    },
  ];

  const factors: ConfidenceFactor[] = definitions.map((d) => {
    const without = rawValue(ablate(input, d.name));
    return {
      name: d.name,
      weight: d.weight,
      contribution: Number((value - without).toFixed(6)),
      note: d.note,
    };
  });

  return {
    value: Number(value.toFixed(6)),
    calibrationVersion: CALIBRATION_VERSION,
    factors,
    band: confidenceBand(value),
    degradedByOfflineCache: input.degradedByOfflineCache === true,
  };
}

/** True when a calibrated score is strong enough to report at all. */
export function isReportable(score: ConfidenceScore): boolean {
  return score.value >= REPORTABLE_CONFIDENCE;
}
