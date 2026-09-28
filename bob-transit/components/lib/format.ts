/**
 * Display formatting. Pure functions, locale-aware, no clock reads.
 */
import { TZ_OFFSET_SECONDS, type ArrivalWindow } from "@/lib/contracts";
import { translate, type Locale } from "@/lib/i18n";

/** "52 min" / "1 h 4 min" — rounds to the nearest minute, never shows 0 min. */
export function formatDuration(seconds: number, locale: Locale): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) {
    return translate(locale, "common.minutes", { n: totalMinutes });
  }
  return translate(locale, "common.hoursMinutes", {
    h: Math.floor(totalMinutes / 60),
    m: totalMinutes % 60,
  });
}

/** Seconds-after-local-midnight to "HH:MM". */
export function formatClockOfDay(secondsOfDay: number): string {
  const s = ((Math.round(secondsOfDay) % 86_400) + 86_400) % 86_400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Epoch ms to "HH:MM" in Asia/Kuala_Lumpur. */
export function formatClockFromMs(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_SECONDS * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** ISO timestamp to "HH:MM" in Asia/Kuala_Lumpur. */
export function formatClockFromIso(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatClockFromMs(ms) : "--:--";
}

export function formatPercent(value: number, digits = 0): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(digits)}%`;
}

/** "08:41 – 08:53" from the P50 and P90 of an arrival window. */
export function formatArrivalWindow(arrival: ArrivalWindow): string {
  return `${formatClockOfDay(arrival.p50Seconds)} – ${formatClockOfDay(arrival.p90Seconds)}`;
}

/** Minutes between two seconds-after-midnight values, rounded. */
export function minutesBetweenSeconds(from: number, to: number): number {
  return Math.round((to - from) / 60);
}

/** Signed minutes, e.g. "+9 min" / "-3 min". */
export function formatSignedMinutes(seconds: number, locale: Locale): string {
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return translate(locale, "common.minutes", { n: 0 });
  const sign = minutes > 0 ? "+" : "−";
  return `${sign}${translate(locale, "common.minutes", { n: Math.abs(minutes) })}`;
}

/** "2 transfers" / "1 transfer" / "No transfer". */
export function formatTransfers(count: number, locale: Locale): string {
  if (count <= 0) return translate(locale, "results.transfersNone");
  if (count === 1) return translate(locale, "results.transfersOne");
  return translate(locale, "results.transfers", { count });
}

/** Pretty-print a segment id for evidence lists: "KGL:KG17->KG18A". */
export function formatSegmentId(segmentId: string): string {
  return segmentId;
}

/** "3 min ago" style relative label, used inside evidence rows. */
export function formatAgeMinutes(minutes: number, locale: Locale): string {
  return translate(locale, "stale.asOf", {
    time: "",
    min: Math.max(0, Math.round(minutes)),
  })
    .replace(/^as of\s*,?\s*/i, "")
    .replace(/^setakat\s*,?\s*/i, "");
}
