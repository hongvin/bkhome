/**
 * Touch-target registry.
 *
 * Every interactive element in the app declares its rendered size here, and the
 * component reads the same constant it is asserted on. That is deliberate: the
 * test in tests/ui/touch-targets.test.ts asserts against this table, and a
 * component that hard-codes a smaller size would drift from it — so components
 * are required (by convention, and by the touch-target test's coverage list) to
 * spread these values into their `style`.
 *
 * Hard requirement: >= 44 x 44 CSS px, no hover-dependent interaction anywhere.
 */
import type { TranslationKey } from "@/lib/i18n";

export const MIN_TOUCH_PX = 44;

export interface TouchTargetSpec {
  /** Stable id, also used as the test's coverage list. */
  id: TouchTargetId;
  /** Accessible label key. */
  labelKey: TranslationKey;
  /** Minimum rendered height in CSS px. */
  minHeight: number;
  /** Minimum rendered width in CSS px. */
  minWidth: number;
  /** Where it lives, so a reviewer can find it without a browser. */
  where: string;
}

export const TOUCH_TARGETS = {
  sheetHandle: {
    id: "sheetHandle",
    labelKey: "a11y.dragHandle",
    minHeight: 44,
    minWidth: 88,
    where: "Top of the bottom sheet; drag to change detent, tap to cycle.",
  },
  originField: {
    id: "originField",
    labelKey: "search.pickOrigin",
    minHeight: 48,
    minWidth: 44,
    where: "Peek summary row, upper half.",
  },
  destinationField: {
    id: "destinationField",
    labelKey: "search.pickDestination",
    minHeight: 48,
    minWidth: 44,
    where: "Peek summary row, lower half.",
  },
  swapButton: {
    id: "swapButton",
    labelKey: "search.swap",
    minHeight: 44,
    minWidth: 44,
    where: "Right edge of the peek summary row.",
  },
  primaryCta: {
    id: "primaryCta",
    labelKey: "search.cta",
    minHeight: 52,
    minWidth: 44,
    where: "Pinned action bar at the bottom of the sheet, at every detent.",
  },
  localeToggle: {
    id: "localeToggle",
    labelKey: "locale.toggle",
    minHeight: 52,
    minWidth: 52,
    where: "Right of the primary CTA in the pinned action bar.",
  },
  routeCard: {
    id: "routeCard",
    labelKey: "results.select",
    minHeight: 96,
    minWidth: 44,
    where: "Each route card in the half/full detent results list.",
  },
  routeCardSelect: {
    id: "routeCardSelect",
    labelKey: "results.select",
    minHeight: 44,
    minWidth: 96,
    where: "The 'use this route' control inside a route card.",
  },
  alertCard: {
    id: "alertCard",
    labelKey: "alert.title",
    minHeight: 96,
    minWidth: 44,
    where: "Each disruption card in the full detent feed.",
  },
  explainButton: {
    id: "explainButton",
    labelKey: "alert.explain",
    minHeight: 44,
    minWidth: 44,
    where: "Every claim: route card, risk chip, disruption card, inspector hop.",
  },
  stationOption: {
    id: "stationOption",
    labelKey: "search.searchPlaceholder",
    minHeight: 56,
    minWidth: 44,
    where: "Station search result rows.",
  },
  detentTab: {
    id: "detentTab",
    labelKey: "sheet.handle",
    minHeight: 44,
    minWidth: 44,
    where: "Peek / half / full detent shortcuts in the sheet header.",
  },
  mapLocate: {
    id: "mapLocate",
    labelKey: "map.locate",
    minHeight: 48,
    minWidth: 48,
    where: "Floating map control, bottom-right, above the peek detent.",
  },
  closeButton: {
    id: "closeButton",
    labelKey: "common.close",
    minHeight: 44,
    minWidth: 44,
    where: "Source inspector header.",
  },
  backButton: {
    id: "backButton",
    labelKey: "source.back",
    minHeight: 44,
    minWidth: 44,
    where: "Source inspector header.",
  },
  retryButton: {
    id: "retryButton",
    labelKey: "offline.retry",
    minHeight: 44,
    minWidth: 44,
    where: "Offline banner.",
  },
} as const satisfies Record<string, TouchTargetSpec>;

export type TouchTargetId = keyof typeof TOUCH_TARGETS;

export const TOUCH_TARGET_IDS = Object.keys(TOUCH_TARGETS) as TouchTargetId[];

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
    const spec: TouchTargetSpec = TOUCH_TARGETS[id];
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
  const spec: TouchTargetSpec = TOUCH_TARGETS[id];
  return { minHeight: spec.minHeight, minWidth: spec.minWidth };
}
