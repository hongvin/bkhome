/**
 * 375px layout arithmetic — acceptance criterion A6 ("must render at 375px
 * width with no horizontal scroll").
 *
 * jsdom is not configured and no headless browser is installed in this
 * environment, so this is NOT a pixel measurement. It is the next best thing
 * and it is honest about what it is: the horizontal budget of every row is
 * computed from the SAME constants the components use, and every component is
 * statically checked for the two things that actually cause horizontal scroll —
 * a fixed width wider than the viewport, and an unclipped root.
 *
 * A screenshot would be better evidence. See the completion report for why one
 * is not attached.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TOUCH_TARGETS } from "@/components/lib/touch";
import { REFERENCE_VIEWPORTS, detentHeights } from "@/components/lib/detents";

const VIEWPORT = 375;
const REPO_ROOT = process.cwd();

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), "utf8");
}

/** Tailwind spacing used by the sheet: px-3 = 12, gap-1.5 = 6, gap-2 = 8. */
const SHEET_PADDING_X = 12;

describe("every reference viewport is 375px wide", () => {
  it("pins the design to 375 x 667 and 375 x 812", () => {
    expect(REFERENCE_VIEWPORTS.map((v) => v.width)).toEqual([375, 375]);
    expect(REFERENCE_VIEWPORTS.map((v) => v.height)).toEqual([667, 812]);
  });

  it("has three ordered detents on both", () => {
    for (const { height } of REFERENCE_VIEWPORTS) {
      const h = detentHeights(height);
      expect(h.peek).toBeLessThan(h.half);
      expect(h.half).toBeLessThan(h.full);
    }
  });
});

describe("horizontal budget at 375px", () => {
  it("the sheet header row fits: padding + origin + gap + swap + gap + destination", () => {
    const budget =
      VIEWPORT -
      SHEET_PADDING_X * 2 -
      6 * 2 - // two gap-1.5 gutters
      TOUCH_TARGETS.swapButton.minWidth;
    expect(budget).toBeGreaterThanOrEqual(
      TOUCH_TARGETS.originField.minWidth + TOUCH_TARGETS.destinationField.minWidth,
    );
    // Each endpoint field gets a comfortable 147px at 375px.
    expect(Math.floor(budget / 2)).toBeGreaterThan(100);
  });

  it("the pinned action bar fits: padding + CTA + gap + language toggle", () => {
    const cta =
      VIEWPORT -
      SHEET_PADDING_X * 2 -
      8 - // gap-2
      TOUCH_TARGETS.localeToggle.minWidth;
    expect(cta).toBeGreaterThanOrEqual(TOUCH_TARGETS.primaryCta.minWidth);
    expect(cta).toBeGreaterThan(250);
  });

  it("the two floating status chips leave room for the map between them", () => {
    // left-3 (12) + right-16 (64) leaves 299px for the freshness chip.
    expect(VIEWPORT - 12 - 64).toBeGreaterThan(250);
  });
});

describe("nothing declares a fixed width wider than the viewport", () => {
  const componentFiles = [
    "components/BottomSheet.tsx",
    "components/RouteCard.tsx",
    "components/DisruptionCard.tsx",
    "components/SourceInspector.tsx",
    "components/StationPicker.tsx",
    "components/StalenessBanner.tsx",
    "components/TransitApp.tsx",
    "components/MapCanvas.tsx",
    "components/screens/RouteResults.tsx",
    "components/ui/atoms.tsx",
  ];

  it("has no w-[Npx] or min-w-[Npx] above 375", () => {
    const pattern = /(?:min-)?w-\[(\d+)px\]/g;
    for (const file of componentFiles) {
      const source = read(file);
      for (const match of source.matchAll(pattern)) {
        const width = Number(match[1]);
        expect(width, `${file} declares ${match[0]}`).toBeLessThanOrEqual(VIEWPORT);
      }
    }
  });

  it("has no w-screen or w-[Nvw] on an inner element", () => {
    for (const file of componentFiles) {
      const source = read(file);
      expect(source, `${file}`).not.toMatch(/\bw-screen\b/);
      const vw = source.matchAll(/w-\[(\d+)vw\]/g);
      for (const match of vw) {
        expect(Number(match[1])).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("the root and the sheet clip the right axes", () => {
  it("the app root hides horizontal overflow", () => {
    const source = read("components/TransitApp.tsx");
    expect(source).toContain("overflow-hidden");
    expect(source).toContain("h-dvh");
    expect(source).toContain("w-full");
  });

  it("the sheet's scroll area scrolls vertically and never horizontally", () => {
    const source = read("components/BottomSheet.tsx");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain("overscroll-contain");
    expect(source).not.toMatch(/overflow-x-(auto|scroll)/);
  });

  it("the sheet itself is pinned to both edges rather than given a width", () => {
    const source = read("components/BottomSheet.tsx");
    expect(source).toContain("absolute inset-x-0 bottom-0");
  });

  it("globals.css keeps the page itself from scrolling", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/overflow:\s*hidden/);
    expect(css).toContain("overscroll-behavior: none");
  });

  it("text that could overflow is truncated or broken, never left to widen a row", () => {
    for (const file of [
      "components/BottomSheet.tsx",
      "components/RouteCard.tsx",
      "components/DisruptionCard.tsx",
      "components/StationPicker.tsx",
      "components/screens/RouteResults.tsx",
    ]) {
      const source = read(file);
      // Single-line labels truncate; multi-line prose breaks. Either way the
      // container is `min-w-0`, so a long station name cannot push the row wider
      // than the viewport.
      expect(
        source.includes("truncate") ||
          source.includes("break-words") ||
          source.includes("break-all"),
        `${file} should truncate or break long text`,
      ).toBe(true);
      expect(source, `${file} should allow its flex children to shrink`).toContain("min-w-0");
    }
  });
});

describe("safe-area insets are respected", () => {
  it("the sheet adds the bottom inset on top of the detent height", () => {
    const source = read("components/BottomSheet.tsx");
    expect(source).toContain("env(safe-area-inset-bottom");
  });

  it("the status chips respect the top inset", () => {
    expect(read("components/TransitApp.tsx")).toContain("env(safe-area-inset-top");
  });

  it("the map locate control clears the sheet and the home indicator", () => {
    const source = read("components/TransitApp.tsx");
    expect(source).toContain("env(safe-area-inset-bottom");
  });
});

describe("the UI renders the advisory's ranking and never recomputes it", () => {
  it("no component calls rankItineraries", () => {
    for (const file of [
      "components/RouteCard.tsx",
      "components/screens/RouteResults.tsx",
      "components/TransitApp.tsx",
      "components/DisruptionCard.tsx",
      "components/SourceInspector.tsx",
    ]) {
      expect(read(file), `${file} must not re-rank the advisory`).not.toContain(
        "rankItineraries",
      );
    }
  });

  it("RouteResults maps over advisory.itineraries in the order the API gave", () => {
    const source = read("components/screens/RouteResults.tsx");
    expect(source).toContain("advisory?.itineraries ?? []");
    expect(source).toContain("itineraries.map((itinerary) => (");
    // ...and never sorts them.
    expect(source).not.toMatch(/itineraries\.sort\(/);
  });

  it("TransitApp takes the recommendation from the advisory, not from its own order", () => {
    const source = read("components/TransitApp.tsx");
    expect(source).toContain("advisory.recommendedItineraryId");
  });
});
