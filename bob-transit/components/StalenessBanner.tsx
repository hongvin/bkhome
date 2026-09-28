"use client";

/**
 * Freshness + offline disclosure.
 *
 * The rule: NEVER silently present cached data as live. Whenever the payload
 * came from cache, the exact "as of HH:MM, N min ago" sentence is on screen. The
 * minutes come from the SERVER's `meta.stalenessMinutes`, so a device with a
 * wrong clock cannot make stale data look fresh; only the extra minutes accrued
 * while the connection is down are measured locally.
 *
 * These are status chips floating over the map — deliberately NOT a top
 * navigation bar. They are non-interactive except for Retry.
 */
import { useLocale } from "@/components/LocaleProvider";
import { formatStaleness } from "@/components/lib/staleness";
import { touchStyle } from "@/components/lib/touch";

export interface StalenessChipProps {
  asOf: string;
  stalenessMinutes: number;
  cached: boolean;
  offline: boolean;
  offlineExtraMinutes: number;
  onRetry?: () => void;
}

export function StalenessChip({
  asOf,
  stalenessMinutes,
  cached,
  offline,
  offlineExtraMinutes,
  onRetry,
}: StalenessChipProps) {
  const { locale, t } = useLocale();
  const result = formatStaleness({
    asOf,
    stalenessMinutes,
    locale,
    offlineExtraMinutes,
    includeLivePrefix: cached,
  });

  return (
    <div className="flex flex-col items-start gap-1.5" aria-live="polite">
      <div
        data-testid="staleness-chip"
        data-freshness={result.key}
        aria-label={t("a11y.staleness")}
        className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-slate-950/80 px-3 py-1.5 text-[11px] font-medium text-slate-200 shadow-lg backdrop-blur"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            result.isFresh ? "bg-emerald-400" : "bg-amber-400"
          }`}
          aria-hidden
        />
        <span className="truncate tabular-nums">{result.text}</span>
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-slate-300">
          {cached ? t("stale.cached") : t("stale.live")}
        </span>
      </div>

      {offline ? (
        <div
          data-testid="offline-chip"
          aria-label={t("a11y.offlineNotice")}
          className="flex max-w-full items-center gap-2 rounded-2xl border border-amber-400/30 bg-amber-950/70 px-3 py-2 text-[11px] text-amber-100 shadow-lg backdrop-blur"
        >
          <span className="shrink-0 font-semibold">{t("offline.offline")}</span>
          <span className="min-w-0">
            <span className="block truncate">{t("offline.banner")}</span>
            <span className="block text-[10px] text-amber-200/80">
              {t("offline.confidenceReduced")} · {t("offline.stillWorks")}
            </span>
          </span>
          {onRetry ? (
            <button
              type="button"
              data-no-drag
              onClick={onRetry}
              style={touchStyle("retryButton")}
              className="shrink-0 rounded-full bg-amber-400/20 px-3 text-[11px] font-semibold text-amber-50 active:bg-amber-400/30"
            >
              {t("offline.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
