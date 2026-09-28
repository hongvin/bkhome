/**
 * Bottom-sheet detent maths — pure, no DOM, no React.
 *
 * The sheet is anchored to the bottom of the viewport and grows upward by
 * changing its HEIGHT (not a transform), because at `peek` the pinned action bar
 * must stay on screen and anchored to the bottom edge. Height also keeps
 * `env(safe-area-inset-bottom)` padding correct at every detent.
 *
 * Three detents, Google Maps / Waze style:
 *   peek  15% of viewport height  — origin/destination + the primary CTA
 *   half  50%                     — route options
 *   full  92%                     — detail, alerts, sources
 *
 * A 15% peek on a short phone cannot fit a 44px handle, a 48px origin/destination
 * row, a 52px CTA and the safe-area padding, so `DETENT_MIN_PX.peek` floors it.
 * The floor is part of the maths (and therefore tested), not a CSS afterthought.
 *
 * Unit-tested in tests/ui/detents.test.ts.
 */

export type DetentName = "peek" | "half" | "full";

/** Ordered smallest to largest. Index order is load-bearing for fling stepping. */
export const DETENT_ORDER: readonly DetentName[] = ["peek", "half", "full"] as const;

/** Nominal fraction of viewport height for each detent. */
export const DETENT_FRACTION: Readonly<Record<DetentName, number>> = {
  peek: 0.15,
  half: 0.5,
  full: 0.92,
};

/**
 * Content floors, in CSS px, measured from the rendered sheet chrome:
 *   peek = handle strip (4 + 4 + 4) + origin/destination row (48)
 *        + action bar (6 + 52) + gutter (6)  = 124
 *   half = three 96px route cards partly visible, plus the action bar.
 * A bare 15% peek is 100px on a 667px phone, which cannot hold a 48px
 * origin/destination row and a 52px CTA at 44px touch targets — so the floor is
 * part of the maths and is asserted in tests/ui/detents.test.ts.
 */
export const DETENT_MIN_PX: Readonly<Record<DetentName, number>> = {
  peek: 124,
  half: 300,
  full: 0,
};

/** Height in CSS px the sheet occupies at each detent, for a given viewport. */
export function detentHeights(viewportHeight: number): Record<DetentName, number> {
  const vh = Math.max(0, viewportHeight);
  const peek = Math.max(vh * DETENT_FRACTION.peek, DETENT_MIN_PX.peek);
  const half = Math.max(vh * DETENT_FRACTION.half, DETENT_MIN_PX.half);
  const full = Math.max(vh * DETENT_FRACTION.full, DETENT_MIN_PX.full);

  // Keep the three heights ordered and inside the viewport even on tiny screens.
  const fullClamped = Math.min(vh, Math.max(full, half, peek));
  const halfClamped = Math.min(half, fullClamped);
  const peekClamped = Math.min(peek, halfClamped);

  return {
    peek: Math.round(peekClamped),
    half: Math.round(halfClamped),
    full: Math.round(fullClamped),
  };
}

/** Distance from the top of the viewport to the top edge of the sheet. */
export function detentTopPx(detent: DetentName, viewportHeight: number): number {
  return Math.max(0, viewportHeight - detentHeights(viewportHeight)[detent]);
}

export function detentHeightPx(detent: DetentName, viewportHeight: number): number {
  return detentHeights(viewportHeight)[detent];
}

export function detentIndex(detent: DetentName): number {
  return DETENT_ORDER.indexOf(detent);
}

export function detentAt(index: number): DetentName {
  const clamped = Math.min(DETENT_ORDER.length - 1, Math.max(0, index));
  return DETENT_ORDER[clamped] ?? "peek";
}

/** One step up (direction > 0, sheet grows) or down (direction < 0, sheet shrinks). */
export function stepDetent(detent: DetentName, direction: number): DetentName {
  if (direction === 0) return detent;
  return detentAt(detentIndex(detent) + (direction > 0 ? 1 : -1));
}

/** True when the sheet is already at the extreme in that direction. */
export function isAtExtreme(detent: DetentName, direction: number): boolean {
  return stepDetent(detent, direction) === detent;
}

/**
 * Nearest detent to an arbitrary sheet-top offset. Ties resolve DOWNWARD (to the
 * smaller sheet) so a release exactly between two detents never springs the
 * sheet further open than the user dragged it.
 */
export function detentForTop(topPx: number, viewportHeight: number): DetentName {
  const heights = detentHeights(viewportHeight);
  const vh = viewportHeight;
  let best: DetentName = "peek";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const detent of DETENT_ORDER) {
    const distance = Math.abs(topPx - (vh - heights[detent]));
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = detent;
    }
  }
  return best;
}

/** Same as `detentForTop` but from a height, which is what drags produce. */
export function detentForHeight(heightPx: number, viewportHeight: number): DetentName {
  return detentForTop(viewportHeight - heightPx, viewportHeight);
}

/** Sheet height during an in-progress drag, clamped to [peek, full]. */
export function dragHeightPx(
  startDetent: DetentName,
  dyPx: number,
  viewportHeight: number,
): number {
  const heights = detentHeights(viewportHeight);
  const raw = heights[startDetent] - dyPx;
  return Math.min(heights.full, Math.max(heights.peek, raw));
}

/** Default fling threshold: 0.6 px/ms is a deliberate, not accidental, flick. */
export const DEFAULT_FLING_VELOCITY = 0.6;

export interface DragRelease {
  /** Detent the sheet should settle at. */
  detent: DetentName;
  /** Sheet height at that detent, for the transition target. */
  heightPx: number;
  /** Why it settled there — surfaced in tests and in the a11y live region. */
  reason: "fling-up" | "fling-down" | "snap";
}

export interface DragReleaseInput {
  /** Detent the drag started from. */
  startDetent: DetentName;
  /** Vertical drag delta in px. Negative = finger moved up = sheet grows. */
  dyPx: number;
  /** Vertical velocity in px/ms. Negative = upward flick. */
  velocityPxPerMs?: number;
  viewportHeight: number;
  /** Absolute velocity above which a flick moves exactly one detent. */
  flingVelocity?: number;
}

/**
 * Where the sheet settles after the finger lifts.
 *
 * A flick always moves exactly ONE detent in the direction of travel — it never
 * skips a detent, which is what makes the gesture predictable on a phone. A
 * slow release snaps to whichever detent is nearest.
 */
export function resolveDragRelease(input: DragReleaseInput): DragRelease {
  const { startDetent, dyPx, viewportHeight } = input;
  const velocity = input.velocityPxPerMs ?? 0;
  const fling = input.flingVelocity ?? DEFAULT_FLING_VELOCITY;

  let detent: DetentName;
  let reason: DragRelease["reason"];

  if (velocity <= -fling) {
    detent = stepDetent(startDetent, 1);
    reason = "fling-up";
  } else if (velocity >= fling) {
    detent = stepDetent(startDetent, -1);
    reason = "fling-down";
  } else {
    detent = detentForHeight(dragHeightPx(startDetent, dyPx, viewportHeight), viewportHeight);
    reason = "snap";
  }

  return { detent, heightPx: detentHeightPx(detent, viewportHeight), reason };
}

/** Fraction of the viewport the sheet covers, for reporting and assertions. */
export function detentCoverage(detent: DetentName, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0;
  return detentHeightPx(detent, viewportHeight) / viewportHeight;
}

/** Sheet transition, used by the component so the CSS and the tests agree. */
export const SHEET_TRANSITION_MS = 260;
export const SHEET_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * Fixed chrome heights, in CSS px, matching `BottomSheet.tsx`:
 *   header  = 4 (pt) + 4 (bar) + 4 (mb) + 48 (origin/destination row)  = 60
 *   action  = 6 (pt) + 52 (CTA)                                        = 58
 * plus `env(safe-area-inset-bottom)` below the action bar, added by CSS on top
 * of the detent height rather than inside it.
 *
 * The action bar is pinned to the bottom of the sheet, and the sheet's bottom
 * edge is the viewport's bottom edge, so its top edge is `viewportHeight -
 * SHEET_ACTION_BAR_PX` at EVERY detent. That is what keeps the primary CTA
 * inside the bottom 40% of the viewport (one-handed reach) no matter where the
 * sheet is.
 */
export const SHEET_HEADER_PX = 60;
export const SHEET_ACTION_BAR_PX = 58;

/** Top edge of the pinned action bar. Independent of detent, by construction. */
export function actionBarTopPx(viewportHeight: number): number {
  return viewportHeight - SHEET_ACTION_BAR_PX;
}

/** Fraction of the viewport below the action bar's top edge. */
export function actionBarBottomFraction(viewportHeight: number): number {
  if (viewportHeight <= 0) return 0;
  return SHEET_ACTION_BAR_PX / viewportHeight;
}

/**
 * Viewports the design is pinned to. 375x667 is the smallest phone we support
 * (iPhone SE) and 375x812 is the reference modern phone; both must render with
 * no horizontal scroll.
 */
export const REFERENCE_VIEWPORTS = [
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "iPhone 12/13 mini", width: 375, height: 812 },
] as const;
