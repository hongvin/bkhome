"use client";

/**
 * The draggable bottom sheet — the only chrome in the app.
 *
 * Three detents, Google Maps / Waze style:
 *   peek  ~15%  origin/destination + the primary CTA
 *   half  ~50%  route options
 *   full  ~92%  detail, alerts, sources
 *
 * There is NO top navigation. Everything the rider needs is either in this
 * sheet or floating on the map.
 *
 * Structure is fixed at every detent:
 *   [ header: drag handle strip + origin/destination row + swap ]  60px
 *   [ scrollable content ]                                         flex-1
 *   [ pinned action bar: primary CTA + language toggle ]           58px
 *
 * The action bar is pinned to the BOTTOM of the sheet, so the primary action is
 * in the bottom ~15-20% of the viewport at every detent — inside the bottom 40%
 * the one-handed requirement asks for. The sheet's own height includes
 * `env(safe-area-inset-bottom)` on top of the detent height, so the CTA clears
 * the home indicator on a notched phone.
 */
import type { ReactNode } from "react";

import type { Station } from "@/lib/contracts";

import { useLocale } from "@/components/LocaleProvider";
import { SHEET_EASING, SHEET_TRANSITION_MS } from "@/components/lib/detents";
import { touchStyle } from "@/components/lib/touch";
import type { SheetDragHandlers } from "@/components/sheet/useSheetDrag";

export interface BottomSheetProps {
  heightPx: number;
  isDragging: boolean;
  dragHandlers: SheetDragHandlers;
  origin: Station | undefined;
  destination: Station | undefined;
  onPickOrigin: () => void;
  onPickDestination: () => void;
  onSwap: () => void;
  onPrimaryAction: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
  children: ReactNode;
}

export function BottomSheet({
  heightPx,
  isDragging,
  dragHandlers,
  origin,
  destination,
  onPickOrigin,
  onPickDestination,
  onSwap,
  onPrimaryAction,
  primaryLabel,
  primaryDisabled,
  children,
}: BottomSheetProps) {
  const { locale, t, toggleLocale } = useLocale();

  const originLabel = origin
    ? locale === "ms"
      ? origin.nameMs
      : origin.name
    : t("search.pickOrigin");
  const destinationLabel = destination
    ? locale === "ms"
      ? destination.nameMs
      : destination.name
    : t("search.pickDestination");

  return (
    <section
      data-testid="bottom-sheet"
      data-detent-height={heightPx}
      aria-label={t("a11y.sheet")}
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-white/10 bg-slate-900/95 shadow-[0_-12px_40px_rgba(0,0,0,0.55)] backdrop-blur-xl"
      style={{
        height: `calc(${heightPx}px + env(safe-area-inset-bottom, 0px))`,
        transition: isDragging
          ? "none"
          : `height ${SHEET_TRANSITION_MS}ms ${SHEET_EASING}`,
      }}
    >
      {/* ---------------- header (drag target) ---------------- */}
      <header
        {...dragHandlers}
        data-testid="sheet-header"
        style={{ ...touchStyle("sheetHandle"), touchAction: "none" }}
        className="shrink-0 cursor-grab select-none px-3 pb-0 pt-1 active:cursor-grabbing"
      >
        <div
          className="mx-auto mb-1 h-1 w-10 rounded-full bg-white/25"
          aria-hidden
        />
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            data-no-drag
            data-testid="origin-field"
            onClick={onPickOrigin}
            style={touchStyle("originField")}
            className="flex min-w-0 flex-1 flex-col justify-center rounded-xl bg-white/[0.05] px-2.5 text-left ring-1 ring-white/10 active:bg-white/[0.09]"
          >
            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
              {t("search.from")}
            </span>
            <span className="truncate text-[13px] font-semibold text-slate-100">
              {originLabel}
            </span>
          </button>

          <button
            type="button"
            data-no-drag
            data-testid="swap-button"
            onClick={onSwap}
            aria-label={t("search.swap")}
            style={touchStyle("swapButton")}
            className="flex shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-slate-300 ring-1 ring-white/10 active:bg-white/[0.09]"
          >
            <span aria-hidden className="text-base leading-none">
              ⇄
            </span>
          </button>

          <button
            type="button"
            data-no-drag
            data-testid="destination-field"
            onClick={onPickDestination}
            style={touchStyle("destinationField")}
            className="flex min-w-0 flex-1 flex-col justify-center rounded-xl bg-white/[0.05] px-2.5 text-left ring-1 ring-white/10 active:bg-white/[0.09]"
          >
            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
              {t("search.to")}
            </span>
            <span className="truncate text-[13px] font-semibold text-slate-100">
              {destinationLabel}
            </span>
          </button>
        </div>
      </header>

      {/* ---------------- scrollable content ---------------- */}
      <div
        data-testid="sheet-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
      >
        {children}
      </div>

      {/* ---------------- pinned action bar ---------------- */}
      <footer
        data-testid="sheet-action-bar"
        className="shrink-0 border-t border-white/10 bg-slate-950/70 px-3 pt-1.5"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 6px)" }}
      >
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            data-no-drag
            data-testid="primary-cta"
            onClick={onPrimaryAction}
            disabled={primaryDisabled}
            style={touchStyle("primaryCta")}
            className="flex min-w-0 flex-1 items-center justify-center rounded-xl bg-emerald-400 px-4 text-[14px] font-bold text-slate-950 active:bg-emerald-300 disabled:opacity-50"
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            data-no-drag
            data-testid="locale-toggle"
            onClick={toggleLocale}
            aria-label={t("locale.toggle")}
            style={touchStyle("localeToggle")}
            className="flex shrink-0 items-center justify-center rounded-xl bg-white/[0.07] text-[13px] font-bold text-slate-100 ring-1 ring-white/15 active:bg-white/[0.12]"
          >
            {locale === "en" ? t("locale.ms") : t("locale.en")}
          </button>
        </div>
      </footer>
    </section>
  );
}
