/**
 * Touch-target registry.
 *
 * Every interactive element in the app declares its rendered size here, and the
 * component reads the same constant it is asserted on. That is deliberate: the
 * test in tests/ui/touch-targets.test.ts asserts against this table, and a
 * component that hard-codes a smaller size would drift from it — so components
 * are required (by convention, and by the coverage test) to spread these values
 * into their `style`.
 *
 * Hard requirement: >= 44 x 44 CSS px, no hover-dependent interaction anywhere.
 */
import type { TranslationKey } from "@/lib/i18n";

export const MIN_TOUCH_PX = 44;

/** Canonical id list. The union below is derived from it — no circular types. */
export const TOUCH_TARGET_IDS = [
  "sheetHandle",
  "originField",
  "destinationField",
  "swapButton",
  "primaryCta",
  "localeToggle",
  "routeCard",
  "routeCardSelect",
  "alertCard",
  "explainButton",
  "stationOption",
  "detentTab",
  "mapLocate",
  "closeButton",
  "backButton",
  "retryButton",
] as const;

export type TouchTargetId = (typeof TOUCH_TARGET_IDS)[number];

export interface TouchTargetSpec {
  /** Accessible label key. */
  labelKey: TranslationKey;
  /** Minimum rendered height in CSS px. */
  minHeight: number;
  /** Minimum rendered width in CSS px. */
  minWidth: number;
  /** Where it lives, so a reviewer can find it without a browser. */
  where: string;
}

export const TOUCH_TARGETS: Record<TouchTargetId, TouchTargetSpec> = {
  sheetHandle: {
    labelKey: "a11y.dragHandle",
    minHeight: 44,
    minWidth: 88,
    where: "Top of the bottom sheet; drag to change detent, tap to cycle.",
  },
  originField: {
    labelKey: "search.pickOrigin",
    minHeight: 48,
    minWidth: 44,
    where: "Peek summary row, upper half.",
  },
  destinationField: {
    labelKey: "search.pickDestination",
    minHeight: 48,
    minWidth: 44,
    where: "Peek summary row, lower half.",
  },
  swapButton: {
    labelKey: "search.swap",
    minHeight: 44,
    minWidth: 44,
    where: "Right edge of the peek summary row.",
  },
  primaryCta: {
    labelKey: "search.cta",
    minHeight: 52,
    minWidth: 44,
    where: "Pinned action bar at the bottom of the sheet, at every detent.",
  },
  localeToggle: {
    labelKey: "locale.toggle",
    minHeight: 52,
    minWidth: 52,
    where: "Right of the primary CTA in the pinned action bar.",
  },
  routeCard: {
    labelKey: "results.select",
    minHeight: 96,
    minWidth: 44,
    where: "Each route card in the half/full detent results list.",
  },
  routeCardSelect: {
    labelKey: "results.select",
    minHeight: 44,
    minWidth: 96,
    where: "The 'use this route' control inside a route card.",
  },
  alertCard: {
    labelKey: "alert.title",
    minHeight: 96,
    minWidth: 44,
    where: "Each disruption card in the full detent feed.",
  },
  explainButton: {
    labelKey: "alert.explain",
    minHeight: 44,
    minWidth: 44,
    where: "Every claim: route card, risk chip, disruption card, inspector hop.",
  },
  stationOption: {
    labelKey: "search.searchPlaceholder",
    minHeight: 56,
    minWidth: 44,
    where: "Station search result rows.",
  },
  detentTab: {
    labelKey: "sheet.handle",
    minHeight: 44,
    minWidth: 44,
    where: "Peek / half / full detent shortcuts in the sheet header.",
  },
  mapLocate: {
    labelKey: "map.locate",
    minHeight: 48,
    minWidth: 48,
    where: "Floating map control, bottom-right, above the peek detent.",
  },
  closeButton: {
    labelKey: "common.close",
    minHeight: 44,
    minWidth: 44,
    where: "Source inspector header.",
  },
  backButton: {
    labelKey: "source.back",
    minHeight: 44,
    minWidth: 44,
    where: "Source inspector header.",
  },
  retryButton: {
    labelKey: "offline.retry",
    minHeight: 44,
    minWidth: 44,
    where: "Offline banner.",
  },
};

export interface TouchTargetViolation {
  id: TouchTargetId;
  minHeight: number;
  minWidth: number;
  reason: string;
}

/** Returns every declared target below the 44 px minimum. Empty array = compliant. */
export function findTouchTargetViolations(): TouchTargetViolation[] {
  const violations: TouchTargetViolation[] = [];
  for (const id of TOUCH_TARGET_IDS) {
    const spec = TOUCH_TARGETS[id];
    if (spec.minHeight < MIN_TOUCH_PX || spec.minWidth < MIN_TOUCH_PX) {
      violations.push({
        id,
        minHeight: spec.minHeight,
        minWidth: spec.minWidth,
        reason: `Declared ${spec.minWidth}x${spec.minHeight}, minimum is ${MIN_TOUCH_PX}x${MIN_TOUCH_PX}.`,
      });
    }
  }
  return violations;
}

/** Convenience for components: `style={touchStyle("primaryCta")}`. */
export function touchStyle(id: TouchTargetId): {
  minHeight: number;
  minWidth: number;
} {
  const spec = TOUCH_TARGETS[id];
  return { minHeight: spec.minHeight, minWidth: spec.minWidth };
}
