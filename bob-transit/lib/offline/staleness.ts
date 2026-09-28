/**
 * Honest staleness.
 *
 * The product rule is absolute: cached disruption data must never be presented as
 * live. Every cached payload carries an `asOf` timestamp, and this module turns
 * that into the exact string the UI renders:
 *
 *     "as of 08:42, 12 min ago"      (en)
 *     "setakat 08:42, 12 minit lalu" (ms)
 *
 * `now` is always injected so the output is deterministic and testable; nothing
 * here reads the wall clock.
 */

import { TZ_OFFSET_SECONDS } from "@/lib/contracts";

export type StalenessLocale = "en" | "ms";

export interface Staleness {
  /** The timestamp the data is true as of (ISO-8601 UTC). */
  asOf: string;
  /** The injected "now" (ISO-8601 UTC). */
  now: string;
  /** Whole seconds elapsed; negative when `asOf` is in the future. */
  deltaSeconds: number;
  /** `floor(deltaSeconds / 60)`, clamped at 0. */
  minutes: number;
  /** Wall-clock time in the transit timezone, `HH:MM`. */
  clock: string;
  /** True when `asOf` is later than `now` (clock skew between device and server). */
  isFuture: boolean;
  /** True when the data is older than the caller's freshness budget. */
  isStale: boolean;
}

export interface StalenessOptions {
  /** Anything older than this is stale. Default 5 minutes. */
  staleAfterMinutes?: number;
  /** Seconds to add to UTC to get local wall time. Defaults to Asia/Kuala_Lumpur. */
  timeZoneOffsetSeconds?: number;
}

export const DEFAULT_STALE_AFTER_MINUTES = 5;

function parseInstant(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new RangeError(`${label} is not a valid ISO-8601 timestamp: ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Wall-clock `HH:MM` in the transit timezone (Asia/Kuala_Lumpur, fixed +08:00 —
 * Malaysia has no DST, so this is exact and host-timezone independent).
 */
export function formatClockTime(
  iso: string,
  timeZoneOffsetSeconds: number = TZ_OFFSET_SECONDS,
): string {
  const ms = parseInstant(iso, "iso");
  return new Date(ms + timeZoneOffsetSeconds * 1000).toISOString().slice(11, 16);
}

export function stalenessMinutes(asOf: string, now: Date | string): number {
  return computeStaleness(asOf, now).minutes;
}

export function computeStaleness(
  asOf: string,
  now: Date | string,
  options: StalenessOptions = {},
): Staleness {
  const asOfMs = parseInstant(asOf, "asOf");
  const nowMs = now instanceof Date ? now.getTime() : parseInstant(now, "now");
  const deltaMs = nowMs - asOfMs;
  const deltaSeconds = Math.floor(deltaMs / 1000);
  const minutes = Math.max(0, Math.floor(deltaMs / 60_000));
  const staleAfter = options.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;
  return {
    asOf,
    now: new Date(nowMs).toISOString(),
    deltaSeconds,
    minutes,
    clock: formatClockTime(asOf, options.timeZoneOffsetSeconds ?? TZ_OFFSET_SECONDS),
    isFuture: deltaMs < 0,
    // Compared on the exact elapsed time, not the floored minute count, so the
    // boundary is the instant the budget is exceeded rather than a minute later.
    isStale: deltaMs > staleAfter * 60_000,
  };
}

export interface StalenessFormatterOptions extends StalenessOptions {
  locale?: StalenessLocale;
}

/**
 * Renders the staleness sentence. The `en` form is exactly
 * `"as of HH:MM, N min ago"`; the `ms` form is `"setakat HH:MM, N minit lalu"`.
 */
export class StalenessFormatter {
  readonly locale: StalenessLocale;
  private readonly options: StalenessOptions;

  constructor(options: StalenessFormatterOptions = {}) {
    this.locale = options.locale ?? "en";
    this.options = {
      staleAfterMinutes: options.staleAfterMinutes,
      timeZoneOffsetSeconds: options.timeZoneOffsetSeconds,
    };
  }

  describe(asOf: string, now: Date | string): Staleness {
    return computeStaleness(asOf, now, this.options);
  }

  /** `"as of 08:42, 12 min ago"` / `"setakat 08:42, 12 minit lalu"`. */
  format(asOf: string, now: Date | string): string {
    const staleness = this.describe(asOf, now);
    return this.locale === "ms"
      ? `setakat ${staleness.clock}, ${staleness.minutes} minit lalu`
      : `as of ${staleness.clock}, ${staleness.minutes} min ago`;
  }

  /** Prefix used inside longer sentences, e.g. the offline reason string. */
  prefix(): string {
    return this.locale === "ms" ? "setakat" : "as of";
  }
}

export const stalenessFormatter = new StalenessFormatter({ locale: "en" });
export const stalenessFormatterMs = new StalenessFormatter({ locale: "ms" });

export function formatStaleness(
  asOf: string,
  now: Date | string,
  options: StalenessFormatterOptions = {},
): string {
  return new StalenessFormatter(options).format(asOf, now);
}
