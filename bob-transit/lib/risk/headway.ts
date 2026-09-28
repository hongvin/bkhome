/**
 * CUSTOM DOMAIN TOOL (A7, part 2 of 2)
 * ===================================
 * Severity -> headway-degradation model, grounded in the REAL GTFS
 * `frequencies.txt` of the Klang Valley rail feed.
 *
 * WHY THIS IS NOT A GENERIC HELPER
 * --------------------------------
 * The `rapid-rail-kl` feed is frequency-based, not timetable-based: there is no
 * "next departure at 08:14", only a headway per line per service period. A rider
 * therefore experiences a disruption as a *changed headway*: a MAJOR track fault
 * on the Kelana Jaya line does not add a fixed number of minutes, it turns a
 * 4-minute peak headway into a 13-minute one, and that is what makes a transfer
 * at Masjid Jamek become a coin flip. Every generic "add N minutes" penalty model
 * gets this wrong; this one is built from the actual published frequencies.
 *
 * PROVENANCE
 * ----------
 * `HEADWAY_PROFILES` below is a transcription of
 * `data/gtfs-static/rapid-rail-kl/frequencies.txt` (107 rows, 8 routes, 3 service
 * classes), reduced to a disjoint timeline per (line, service class) by taking,
 * at every instant, the WORST headway across the directions active then. Worst
 * rather than best is deliberate: understating a wait would understate a transfer
 * and make a risky connection look safe. `tests/risk/headway.test.ts` re-parses
 * the committed fixture and asserts this table matches it exactly, so the
 * transcription cannot silently drift.
 *
 * Real numbers this encodes (seconds):
 *   KJ  (Kelana Jaya)  peak 240  off-peak 420   weekend 420
 *   AG  (Ampang)       peak 180  off-peak 300   weekend 300
 *   PH  (Sri Petaling) peak 180  off-peak 300   weekend 300
 *   KGL (MRT Kajang)   peak 360  off-peak 600   weekend 600
 *   PYL (MRT Putrajaya)peak 300  off-peak 600   weekend 600
 *   MR  (Monorail)     peak 420  off-peak 600   weekend 720
 *   BRT (Sunway)       peak 240  off-peak 480   weekend 360
 *   SA  (Shah Alam)    peak 480  off-peak 600   weekend 600
 */

import type { IssueType, Severity } from "@/lib/contracts";
import { excessMultiplier } from "./penalty";

export type HeadwayServiceClass = "WEEKDAY" | "SATURDAY" | "SUNDAY";

export interface HeadwayWindow {
  /** Inclusive start, local seconds after midnight. */
  startSeconds: number;
  /** Exclusive end, local seconds after midnight. */
  endSeconds: number;
  headwaySeconds: number;
}

export interface HeadwayProfile {
  lineId: string;
  service: HeadwayServiceClass;
  windows: readonly HeadwayWindow[];
}

/** Transcribed from `frequencies.txt`; see the provenance note above. */
export const HEADWAY_PROFILES: readonly HeadwayProfile[] = [
  { lineId: "AG", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 32400, headwaySeconds: 180 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 300 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 180 },
    { startSeconds: 68400, endSeconds: 84300, headwaySeconds: 300 },
  ] },
  { lineId: "AG", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 84300, headwaySeconds: 300 },
  ] },
  { lineId: "AG", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 84300, headwaySeconds: 300 },
  ] },

  { lineId: "KJ", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 25200, headwaySeconds: 420 },
    { startSeconds: 25200, endSeconds: 32400, headwaySeconds: 240 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 420 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 240 },
    { startSeconds: 68400, endSeconds: 83700, headwaySeconds: 420 },
  ] },
  { lineId: "KJ", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 83700, headwaySeconds: 420 },
  ] },
  { lineId: "KJ", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 83700, headwaySeconds: 420 },
  ] },

  { lineId: "PH", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 32400, headwaySeconds: 180 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 300 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 180 },
    { startSeconds: 68400, endSeconds: 86400, headwaySeconds: 300 },
  ] },
  { lineId: "PH", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 86400, headwaySeconds: 300 },
  ] },
  { lineId: "PH", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 86400, headwaySeconds: 300 },
  ] },

  { lineId: "KGL", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 32400, headwaySeconds: 360 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 600 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 360 },
    { startSeconds: 68400, endSeconds: 86400, headwaySeconds: 600 },
  ] },
  { lineId: "KGL", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 82500, headwaySeconds: 600 },
  ] },
  { lineId: "KGL", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 82500, headwaySeconds: 600 },
  ] },

  { lineId: "PYL", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 25200, headwaySeconds: 600 },
    { startSeconds: 25200, endSeconds: 32400, headwaySeconds: 300 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 600 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 300 },
    { startSeconds: 68400, endSeconds: 79200, headwaySeconds: 600 },
    { startSeconds: 79200, endSeconds: 86400, headwaySeconds: 840 },
  ] },
  { lineId: "PYL", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 82500, headwaySeconds: 600 },
  ] },
  { lineId: "PYL", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 82500, headwaySeconds: 600 },
  ] },

  { lineId: "MR", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 32400, headwaySeconds: 420 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 600 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 420 },
    { startSeconds: 68400, endSeconds: 84600, headwaySeconds: 600 },
  ] },
  { lineId: "MR", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 84600, headwaySeconds: 720 },
  ] },
  { lineId: "MR", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 84600, headwaySeconds: 720 },
  ] },

  { lineId: "BRT", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 25200, headwaySeconds: 480 },
    { startSeconds: 25200, endSeconds: 32400, headwaySeconds: 240 },
    { startSeconds: 32400, endSeconds: 61200, headwaySeconds: 480 },
    { startSeconds: 61200, endSeconds: 68400, headwaySeconds: 240 },
    { startSeconds: 68400, endSeconds: 86400, headwaySeconds: 480 },
  ] },
  { lineId: "BRT", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 86400, headwaySeconds: 360 },
  ] },
  { lineId: "BRT", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 86400, headwaySeconds: 360 },
  ] },

  { lineId: "SA", service: "WEEKDAY", windows: [
    { startSeconds: 21600, endSeconds: 25200, headwaySeconds: 600 },
    { startSeconds: 25200, endSeconds: 32400, headwaySeconds: 480 },
    { startSeconds: 32400, endSeconds: 59400, headwaySeconds: 600 },
    { startSeconds: 59400, endSeconds: 70200, headwaySeconds: 480 },
    { startSeconds: 70200, endSeconds: 86400, headwaySeconds: 600 },
  ] },
  { lineId: "SA", service: "SATURDAY", windows: [
    { startSeconds: 21600, endSeconds: 86400, headwaySeconds: 600 },
  ] },
  { lineId: "SA", service: "SUNDAY", windows: [
    { startSeconds: 21600, endSeconds: 84600, headwaySeconds: 600 },
  ] },
];

/** Service day starts at 06:00 local in this feed; nothing runs before it. */
export const SERVICE_DAY_START_SECONDS = 21600;

/**
 * A disruption cannot stretch a headway without limit: past this multiplier the
 * line is effectively not running, and the 0.7 avoid-threshold should already
 * have removed it from consideration.
 */
export const HEADWAY_DEGRADATION_MAX_MULTIPLIER = 6;

/** 0 = Sunday, matching `Date#getDay()` and `RouteQuery.serviceWeekday`. */
export function serviceClassForWeekday(serviceWeekday: number): HeadwayServiceClass {
  const day = ((Math.trunc(serviceWeekday) % 7) + 7) % 7;
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

export function headwayWindowsFor(
  lineId: string,
  serviceWeekday: number,
): readonly HeadwayWindow[] {
  const service = serviceClassForWeekday(serviceWeekday);
  return HEADWAY_PROFILES.find((p) => p.lineId === lineId && p.service === service)?.windows ?? [];
}

/**
 * Published headway for a line at a local time of day. `null` means "no service
 * at this hour" (before 06:00 or after the last window), which callers must
 * handle rather than silently inventing a wait.
 */
export function baseHeadwaySeconds(
  lineId: string,
  atTime: number,
  serviceWeekday: number,
): number | null {
  for (const window of headwayWindowsFor(lineId, serviceWeekday)) {
    if (atTime >= window.startSeconds && atTime < window.endSeconds) {
      return window.headwaySeconds;
    }
  }
  return null;
}

export interface HeadwayDegradationInput {
  severity: Severity;
  issueType: IssueType;
  /** Confidence that the disruption is real, in [0,1]. */
  confidence: number;
  atTime: number;
  isOngoing: boolean;
}

/**
 * The multiplier a disruption applies to a published headway. Identical in shape
 * to the run-time penalty (`1 + severity x issueType x confidenceWeight`) so the
 * two models cannot disagree about how bad a SEVERE track fault is; the only
 * difference is the unit it is applied to (headway instead of run time).
 */
export function headwayDegradationMultiplier(input: HeadwayDegradationInput): number {
  const raw = 1 + excessMultiplier(input);
  return Math.min(raw, HEADWAY_DEGRADATION_MAX_MULTIPLIER);
}

/** Headway actually experienced while the disruption is active, seconds. */
export function degradedHeadwaySeconds(
  publishedHeadwaySeconds: number,
  input: HeadwayDegradationInput,
): number {
  return publishedHeadwaySeconds * headwayDegradationMultiplier(input);
}

/**
 * Fraction of the published service still running. 1.0 = unaffected, 0.25 = one
 * train for every four scheduled. Useful for a UI "service at 25%" chip.
 */
export function throughputFraction(
  publishedHeadwaySeconds: number,
  input: HeadwayDegradationInput,
): number {
  if (publishedHeadwaySeconds <= 0) return 1;
  return publishedHeadwaySeconds / degradedHeadwaySeconds(publishedHeadwaySeconds, input);
}

/**
 * Expected wait for a randomly-arriving rider at a station served on a fixed
 * headway: headway / 2. This is the platform-wait term the interchange model
 * adds to an in-station walk.
 */
export function expectedPlatformWaitSeconds(headwaySeconds: number): number {
  return Math.max(0, headwaySeconds) / 2;
}
