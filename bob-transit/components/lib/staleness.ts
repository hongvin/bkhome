/**
 * Staleness formatting — "as of HH:MM, N min ago".
 *
 * The rule this exists to enforce: never silently present cached data as live.
 * Every cached payload renders one of these strings, and it is always computed
 * from the SERVER's `asOf` + `stalenessMinutes` (not the device clock), so a
 * phone with a wrong clock cannot make stale data look fresh.
 *
 * Pure: `now` is never read, only passed. Unit-tested in tests/ui/staleness.test.ts.
 */
import { TZ_OFFSET_SECONDS } from "@/lib/contracts";

import { translate, type Locale, type TranslateParams } from "@/lib/i18n";

/** `HH:MM` in Asia/Kuala_Lumpur for an ISO timestamp or epoch ms. */
export function klClock(instant: string | number): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return "--:--";
  const shifted = new Date(ms + TZ_OFFSET_SECONDS * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Whole minutes between two instants, floored and never negative. */
export function minutesBetween(
  from: string | number,
  to: string | number,
): number {
  const a = typeof from === "number" ? from : Date.parse(from);
  const b = typeof to === "number" ? to : Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 60_000));
}

export interface StalenessInput {
  /** Server timestamp of the data being shown. */
  asOf: string | number;
  /** Server-computed age in minutes. Authoritative — do not recompute from a device clock. */
  stalenessMinutes: number;
  locale: Locale;
  /**
   * Extra whole minutes accrued on the device since the connection dropped.
   * Real elapsed time, measured by the client, added on top of the server figure.
   */
  offlineExtraMinutes?: number;
  /**
   * True when the payload came from cache. Defaults to `true`, and that default
   * is the point: the formatter fails safe. Unless a caller explicitly says the
   * data is live, it renders the "as of …" sentence rather than claiming
   * freshness. `cached: false` is the ONLY way to get "Live".
   */
  cached?: boolean;
}

export interface StalenessResult {
  /** The full sentence, e.g. "as of 08:12, 14 min ago". */
  text: string;
  /** Just the clock part, e.g. "08:12". */
  clock: string;
  /** Effective age in whole minutes, server figure plus offline drift. */
  totalMinutes: number;
  /** True when there is nothing to disclose (fresh, live data). */
  isFresh: boolean;
  /** Key used, for tests and for a11y labelling. */
  key: "stale.asOf" | "stale.asOfJustNow" | "stale.asOfHours" | "stale.live";
}

/**
 * Build the disclosure string. Always returns the same shape for the same
 * inputs — the tests pin the exact English output.
 */
export function formatStaleness(input: StalenessInput): StalenessResult {
  const clock = klClock(input.asOf);
  const cached = input.cached ?? true;
  const totalMinutes = Math.max(
    0,
    Math.floor(input.stalenessMinutes) + Math.floor(input.offlineExtraMinutes ?? 0),
  );

  if (!cached && totalMinutes <= 0) {
    return {
      text: translate(input.locale, "stale.live"),
      clock,
      totalMinutes,
      isFresh: true,
      key: "stale.live",
    };
  }

  if (totalMinutes < 1) {
    const params: TranslateParams = { time: clock };
    return {
      text: translate(input.locale, "stale.asOfJustNow", params),
      clock,
      totalMinutes,
      isFresh: false,
      key: "stale.asOfJustNow",
    };
  }

  if (totalMinutes < 60) {
    const params: TranslateParams = { time: clock, min: totalMinutes };
    return {
      text: translate(input.locale, "stale.asOf", params),
      clock,
      totalMinutes,
      isFresh: false,
      key: "stale.asOf",
    };
  }

  const params: TranslateParams = {
    time: clock,
    h: Math.floor(totalMinutes / 60),
    m: totalMinutes % 60,
  };
  return {
    text: translate(input.locale, "stale.asOfHours", params),
    clock,
    totalMinutes,
    isFresh: false,
    key: "stale.asOfHours",
  };
}

/**
 * Confidence multiplier applied to every displayed confidence while offline.
 * The UI must SHOW that confidence is reduced, not just quietly reduce it.
 */
export const OFFLINE_CONFIDENCE_MULTIPLIER = 0.6;

export function reduceConfidenceForOffline(
  value: number,
  isOffline: boolean,
): number {
  const v = isOffline ? value * OFFLINE_CONFIDENCE_MULTIPLIER : value;
  return Math.min(1, Math.max(0, Number(v.toFixed(3))));
}
