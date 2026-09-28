"use client";

/**
 * Station picker. Replaces the sheet's scroll area while choosing an endpoint.
 *
 * Search is an ordinary text input with a 48px hit area; the result rows are
 * 56px tall. There is no autocomplete-on-hover and no hover-revealed action.
 */
import { useMemo, useState } from "react";

import type { Line, Station } from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import { POPULAR_TRIPS, searchStations } from "@/components/lib/station-search";
import { touchStyle } from "@/components/lib/touch";
import { CARD } from "@/components/ui/tokens";

export interface StationPickerProps {
  mode: "origin" | "destination";
  stations: Station[];
  lines: Line[];
  currentStationId: string;
  onPick: (stationId: string) => void;
  onPickPopular: (origin: string, destination: string) => void;
  onCancel: () => void;
}

export function StationPicker({
  mode,
  stations,
  lines,
  currentStationId,
  onPick,
  onPickPopular,
  onCancel,
}: StationPickerProps) {
  const { locale, t } = useLocale();
  const [query, setQuery] = useState("");
  const results = useMemo(
    () => searchStations(stations, lines, query),
    [stations, lines, query],
  );
  const lineById = new Map(lines.map((l) => [l.id, l]));

  return (
    <section data-testid="station-picker" data-mode={mode} className="flex flex-col gap-3 p-3.5 pt-0">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">
          {mode === "origin" ? t("search.pickOrigin") : t("search.pickDestination")}
        </h2>
        <button
          type="button"
          data-no-drag
          onClick={onCancel}
          style={touchStyle("closeButton")}
          className="flex shrink-0 items-center justify-center rounded-xl bg-white/[0.07] px-3 text-[11px] font-semibold text-slate-200 ring-1 ring-white/10 active:opacity-80"
        >
          {t("common.close")}
        </button>
      </header>

      <input
        type="search"
        inputMode="search"
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("search.searchPlaceholder")}
        aria-label={t("search.searchPlaceholder")}
        style={touchStyle("stationOption")}
        className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/50 focus:outline-none"
      />

      {query.trim() === "" ? (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {t("search.popular")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {POPULAR_TRIPS.map((trip) => {
              const from = stations.find((s) => s.id === trip.origin);
              const to = stations.find((s) => s.id === trip.destination);
              if (!from || !to) return null;
              const label = `${locale === "ms" ? from.nameMs : from.name} → ${
                locale === "ms" ? to.nameMs : to.name
              }`;
              return (
                <button
                  key={`${trip.origin}-${trip.destination}`}
                  type="button"
                  data-no-drag
                  onClick={() => onPickPopular(trip.origin, trip.destination)}
                  style={touchStyle("stationOption")}
                  className="rounded-full border border-white/10 bg-white/[0.04] px-3 text-[11px] text-slate-200 active:opacity-80"
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {results.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-400">{t("search.noResults")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {results.map((station) => {
            const selected = station.id === currentStationId;
            return (
              <li key={station.id}>
                <button
                  type="button"
                  data-no-drag
                  data-testid="station-option"
                  data-station-id={station.id}
                  onClick={() => onPick(station.id)}
                  style={touchStyle("stationOption")}
                  className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left active:opacity-80 ${
                    selected
                      ? "border-cyan-400/40 bg-cyan-400/10"
                      : "border-white/10 bg-white/[0.03]"
                  }`}
                >
                  <span className="flex shrink-0 gap-0.5" aria-hidden>
                    {station.lineIds.slice(0, 4).map((lineId) => (
                      <span
                        key={lineId}
                        className="h-6 w-1.5 rounded-full"
                        style={{
                          backgroundColor: `#${lineById.get(lineId)?.color ?? "64748b"}`,
                        }}
                      />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-slate-100">
                      {locale === "ms" ? station.nameMs : station.name}
                    </span>
                    <span className="block truncate text-[10px] text-slate-400">
                      {station.id}
                      {station.isInterchange ? ` · ${t("search.interchange")}` : ""}
                      {station.isAccessible ? ` · ${t("search.accessible")}` : ""}
                    </span>
                  </span>
                  {selected ? (
                    <span className="shrink-0 text-[10px] font-semibold text-cyan-200">
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className={`${CARD} px-3 py-2 text-[10px] leading-snug text-slate-500`}>
        {t("search.lines")}: {lines.map((l) => l.shortName).join(" · ")}
      </p>
    </section>
  );
}
