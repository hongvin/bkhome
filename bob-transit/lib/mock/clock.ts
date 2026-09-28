/**
 * Demo clock.
 *
 * Everything the demo asserts is anchored to a fixed Monday-morning instant so
 * results are reproducible: no test and no fixture reads the wall clock.
 * Functions that need "now" take it as a parameter (brief §5.7).
 *
 * Malaysia has no DST, so a fixed +08:00 offset is exact.
 */
import { TZ_OFFSET_SECONDS } from "@/lib/contracts";

/** Monday 17 March 2025, 08:26 Asia/Kuala_Lumpur — the morning peak. */
export const DEMO_NOW_ISO = "2025-03-17T08:26:00+08:00";
export const DEMO_NOW_MS = Date.parse(DEMO_NOW_ISO);

/** Minutes between the freshest upstream data and `DEMO_NOW_MS`. */
export const DEMO_STALENESS_MINUTES = 14;

export function demoNow(): Date {
  return new Date(DEMO_NOW_MS);
}

export function demoNowIso(): string {
  return DEMO_NOW_ISO;
}

/** `DEMO_NOW` minus `minutes`, as an ISO string in +08:00. */
export function isoMinutesBeforeDemoNow(minutes: number): string {
  return toKlIso(DEMO_NOW_MS - minutes * 60_000);
}

/** Seconds after local midnight in Asia/Kuala_Lumpur. */
export function localSecondsOfDay(ms: number): number {
  const shifted = ms + TZ_OFFSET_SECONDS * 1000;
  const d = new Date(shifted);
  return (
    d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
  );
}

/** 0 = Sunday, matching JS `Date#getDay()` and `RouteQuery.serviceWeekday`. */
export function localWeekday(ms: number): number {
  return new Date(ms + TZ_OFFSET_SECONDS * 1000).getUTCDay();
}

/** `HH:MM` in Asia/Kuala_Lumpur. */
export function formatKlTime(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_SECONDS * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Seconds-after-midnight to `HH:MM`, wrapping past midnight. */
export function formatKlTimeOfDay(secondsOfDay: number): string {
  const s = ((Math.round(secondsOfDay) % 86_400) + 86_400) % 86_400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Epoch milliseconds to an ISO string carrying the +08:00 offset. */
export function toKlIso(ms: number): string {
  const shifted = new Date(ms + TZ_OFFSET_SECONDS * 1000);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}+08:00`;
}

/** ISO string on the demo's service day at the given seconds-after-midnight. */
export function klIsoAtSecondsOfDay(secondsOfDay: number): string {
  const midnightKlMs = DEMO_NOW_MS - localSecondsOfDay(DEMO_NOW_MS) * 1000;
  return toKlIso(midnightKlMs + secondsOfDay * 1000);
}
