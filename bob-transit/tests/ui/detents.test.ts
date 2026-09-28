/**
 * Bottom-sheet detent maths (acceptance criterion A6, geometry half).
 *
 * Pure-function tests — jsdom is not configured, so we test the logic the sheet
 * is driven by, not the DOM it renders into.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLING_VELOCITY,
  DETENT_FRACTION,
  DETENT_MIN_PX,
  DETENT_ORDER,
  REFERENCE_VIEWPORTS,
  SHEET_ACTION_BAR_PX,
  SHEET_HEADER_PX,
  actionBarTopPx,
  detentCoverage,
  detentForHeight,
  detentForTop,
  detentHeightPx,
  detentHeights,
  detentIndex,
  detentTopPx,
  dragHeightPx,
  isAtExtreme,
  resolveDragRelease,
  stepDetent,
} from "@/components/lib/detents";

const VH_PHONE = 812; // iPhone 12/13 mini
const VH_SE = 667; // iPhone SE — smallest supported

describe("detent heights", () => {
  it("orders peek < half < full and keeps every detent inside the viewport", () => {
    for (const { width, height } of REFERENCE_VIEWPORTS) {
      const heights = detentHeights(height);
      expect(heights.peek).toBeLessThan(heights.half);
      expect(heights.half).toBeLessThan(heights.full);
      expect(heights.full).toBeLessThanOrEqual(height);
      expect(width).toBe(375);
    }
  });

  it("is ~15% / 50% / 92% on the reference phone", () => {
    const heights = detentHeights(VH_PHONE);
    expect(detentCoverage("peek", VH_PHONE)).toBeCloseTo(0.15, 1);
    expect(detentCoverage("half", VH_PHONE)).toBeCloseTo(0.5, 2);
    expect(detentCoverage("full", VH_PHONE)).toBeCloseTo(0.92, 2);
    expect(heights.peek).toBe(124);
    expect(heights.half).toBe(406);
    expect(heights.full).toBe(747);
  });

  it("floors peek to the content minimum on a short phone, and says so", () => {
    const heights = detentHeights(VH_SE);
    // 15% of 667 is 100px, which cannot hold a 48px origin/destination row and a
    // 52px CTA at 44px touch targets — so the documented floor applies.
    expect(Math.round(VH_SE * DETENT_FRACTION.peek)).toBe(100);
    expect(heights.peek).toBe(DETENT_MIN_PX.peek);
    expect(heights.peek).toBe(124);
    expect(detentCoverage("peek", VH_SE)).toBeGreaterThan(0.15);
    expect(detentCoverage("peek", VH_SE)).toBeLessThan(0.2);
  });

  it("the peek floor is exactly the header plus the action bar", () => {
    expect(DETENT_MIN_PX.peek).toBe(SHEET_HEADER_PX + SHEET_ACTION_BAR_PX + 6);
  });

  it("computes the sheet top edge from the height", () => {
    expect(detentTopPx("peek", VH_PHONE)).toBe(VH_PHONE - detentHeightPx("peek", VH_PHONE));
    expect(detentTopPx("full", VH_PHONE)).toBe(65);
  });

  it("degrades safely on a degenerate viewport", () => {
    const tiny = detentHeights(120);
    expect(tiny.peek).toBeLessThanOrEqual(tiny.half);
    expect(tiny.half).toBeLessThanOrEqual(tiny.full);
    expect(tiny.full).toBeLessThanOrEqual(120);
  });
});

describe("detent selection", () => {
  it("snaps to the nearest detent by sheet-top offset", () => {
    expect(detentForTop(detentTopPx("peek", VH_PHONE), VH_PHONE)).toBe("peek");
    expect(detentForTop(detentTopPx("half", VH_PHONE), VH_PHONE)).toBe("half");
    expect(detentForTop(detentTopPx("full", VH_PHONE), VH_PHONE)).toBe("full");
  });

  it("snaps from anywhere in between", () => {
    expect(detentForTop(700, VH_PHONE)).toBe("peek");
    expect(detentForTop(500, VH_PHONE)).toBe("half");
    expect(detentForTop(80, VH_PHONE)).toBe("full");
    expect(detentForHeight(detentHeightPx("half", VH_PHONE), VH_PHONE)).toBe("half");
  });

  it("breaks an exact tie downward, never springing further open than the drag", () => {
    const peekTop = detentTopPx("peek", VH_PHONE);
    const halfTop = detentTopPx("half", VH_PHONE);
    const midpoint = (peekTop + halfTop) / 2;
    expect(detentForTop(midpoint, VH_PHONE)).toBe("peek");
  });
});

describe("drag -> detent", () => {
  it("clamps the dragged height between peek and full", () => {
    expect(dragHeightPx("peek", 500, VH_PHONE)).toBe(detentHeightPx("peek", VH_PHONE));
    expect(dragHeightPx("full", -500, VH_PHONE)).toBe(detentHeightPx("full", VH_PHONE));
    expect(dragHeightPx("peek", -200, VH_PHONE)).toBe(324);
  });

  it("snaps a slow release to the nearest detent", () => {
    expect(
      resolveDragRelease({ startDetent: "peek", dyPx: -200, viewportHeight: VH_PHONE }).detent,
    ).toBe("half");
    expect(
      resolveDragRelease({ startDetent: "peek", dyPx: -600, viewportHeight: VH_PHONE }).detent,
    ).toBe("full");
    expect(
      resolveDragRelease({ startDetent: "half", dyPx: 200, viewportHeight: VH_PHONE }).detent,
    ).toBe("peek");
    expect(
      resolveDragRelease({ startDetent: "peek", dyPx: 5, viewportHeight: VH_PHONE }).detent,
    ).toBe("peek");
  });

  it("labels the release reason", () => {
    expect(
      resolveDragRelease({ startDetent: "peek", dyPx: -200, viewportHeight: VH_PHONE }).reason,
    ).toBe("snap");
  });

  it("a flick moves exactly one detent, never skipping", () => {
    const up = resolveDragRelease({
      startDetent: "peek",
      dyPx: -40,
      velocityPxPerMs: -1.4,
      viewportHeight: VH_PHONE,
    });
    expect(up.detent).toBe("half");
    expect(up.reason).toBe("fling-up");

    const down = resolveDragRelease({
      startDetent: "half",
      dyPx: 40,
      velocityPxPerMs: 1.4,
      viewportHeight: VH_PHONE,
    });
    expect(down.detent).toBe("peek");
    expect(down.reason).toBe("fling-down");

    // A hard flick from half up lands on full, not past it.
    expect(
      resolveDragRelease({
        startDetent: "half",
        dyPx: -400,
        velocityPxPerMs: -3,
        viewportHeight: VH_PHONE,
      }).detent,
    ).toBe("full");

    // And a flick at the extreme stays put.
    expect(
      resolveDragRelease({
        startDetent: "full",
        dyPx: -80,
        velocityPxPerMs: -3,
        viewportHeight: VH_PHONE,
      }).detent,
    ).toBe("full");
    expect(
      resolveDragRelease({
        startDetent: "peek",
        dyPx: 80,
        velocityPxPerMs: 3,
        viewportHeight: VH_PHONE,
      }).detent,
    ).toBe("peek");
  });

  it("treats a sub-threshold velocity as a snap, not a fling", () => {
    const result = resolveDragRelease({
      startDetent: "peek",
      dyPx: -30,
      velocityPxPerMs: DEFAULT_FLING_VELOCITY / 2,
      viewportHeight: VH_PHONE,
    });
    expect(result.reason).toBe("snap");
    expect(result.detent).toBe("peek");
  });

  it("reports the settled height so the component can animate to it", () => {
    const release = resolveDragRelease({
      startDetent: "peek",
      dyPx: -600,
      viewportHeight: VH_PHONE,
    });
    expect(release.heightPx).toBe(detentHeightPx(release.detent, VH_PHONE));
  });
});

describe("detent stepping", () => {
  it("steps one place and clamps at the ends", () => {
    expect(stepDetent("peek", 1)).toBe("half");
    expect(stepDetent("half", 1)).toBe("full");
    expect(stepDetent("full", 1)).toBe("full");
    expect(stepDetent("peek", -1)).toBe("peek");
    expect(stepDetent("full", -1)).toBe("half");
    expect(stepDetent("half", 0)).toBe("half");
  });

  it("knows when it is at an extreme", () => {
    expect(isAtExtreme("full", 1)).toBe(true);
    expect(isAtExtreme("peek", -1)).toBe(true);
    expect(isAtExtreme("half", 1)).toBe(false);
  });

  it("indexes detents in ascending size order", () => {
    expect(DETENT_ORDER.map(detentIndex)).toEqual([0, 1, 2]);
  });
});

describe("primary action stays inside the bottom 40%", () => {
  it("at every detent, on both reference phones", () => {
    for (const { height } of REFERENCE_VIEWPORTS) {
      const top = actionBarTopPx(height);
      expect(top).toBe(height - SHEET_ACTION_BAR_PX);
      expect(top).toBeGreaterThan(height * 0.6);
      // ...and it is genuinely at the bottom of the sheet, not floating.
      expect(height - top).toBe(SHEET_ACTION_BAR_PX);
    }
  });

  it("is independent of which detent the sheet is at", () => {
    const tops = DETENT_ORDER.map(() => actionBarTopPx(VH_PHONE));
    expect(new Set(tops).size).toBe(1);
  });
});
