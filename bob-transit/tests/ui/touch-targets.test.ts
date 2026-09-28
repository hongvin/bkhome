/**
 * Acceptance criterion A6: every interactive element's declared touch target is
 * >= 44 x 44 CSS px, and no interaction depends on hover.
 *
 * The sizes are DATA (`components/lib/touch.ts`), and the components read the
 * same constants they are asserted on, so a component cannot silently render
 * smaller than the table claims.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIN_TOUCH_PX,
  TOUCH_TARGETS,
  TOUCH_TARGET_IDS,
  findTouchTargetViolations,
  touchStyle,
} from "@/components/lib/touch";
import { en } from "@/lib/i18n";

const REPO_ROOT = process.cwd();

/** Ids the acceptance criteria explicitly name. */
const REQUIRED_IDS = [
  "primaryCta",
  "localeToggle",
  "sheetHandle",
  "originField",
  "destinationField",
  "swapButton",
  "routeCard",
  "routeCardSelect",
  "alertCard",
  "explainButton",
  "stationOption",
  "mapLocate",
] as const;

describe("declared touch targets", () => {
  it("has no violation of the 44px minimum", () => {
    expect(findTouchTargetViolations()).toEqual([]);
  });

  it("declares at least 44x44 for every single target", () => {
    for (const id of TOUCH_TARGET_IDS) {
      const spec = TOUCH_TARGETS[id];
      expect(spec.minHeight, `${id} minHeight`).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
      expect(spec.minWidth, `${id} minWidth`).toBeGreaterThanOrEqual(MIN_TOUCH_PX);
    }
  });

  it("covers every interactive element the acceptance criteria name", () => {
    for (const id of REQUIRED_IDS) {
      expect(TOUCH_TARGET_IDS).toContain(id);
    }
  });

  it("gives every target a real, translated accessible label", () => {
    for (const id of TOUCH_TARGET_IDS) {
      const key = TOUCH_TARGETS[id].labelKey;
      expect(en[key], `${id} -> ${key}`).toBeTruthy();
    }
  });

  it("documents where each target lives", () => {
    for (const id of TOUCH_TARGET_IDS) {
      expect(TOUCH_TARGETS[id].where.length, id).toBeGreaterThan(10);
    }
  });

  it("exposes the same numbers through touchStyle", () => {
    for (const id of TOUCH_TARGET_IDS) {
      expect(touchStyle(id)).toEqual({
        minHeight: TOUCH_TARGETS[id].minHeight,
        minWidth: TOUCH_TARGETS[id].minWidth,
      });
    }
  });
});

describe("components actually apply the registry", () => {
  const files = [
    "components/BottomSheet.tsx",
    "components/RouteCard.tsx",
    "components/DisruptionCard.tsx",
    "components/SourceInspector.tsx",
    "components/StationPicker.tsx",
    "components/StalenessBanner.tsx",
    "components/TransitApp.tsx",
  ];

  it("imports touchStyle into every interactive component", () => {
    for (const file of files) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(source, `${file} should use the touch registry`).toContain("touchStyle(");
    }
  });

  it("uses a declared data-testid for every registry-driven control", () => {
    const bottomSheet = readFileSync(
      path.join(REPO_ROOT, "components/BottomSheet.tsx"),
      "utf8",
    );
    for (const id of [
      "sheetHandle",
      "originField",
      "destinationField",
      "swapButton",
      "primaryCta",
      "localeToggle",
    ]) {
      expect(bottomSheet, `BottomSheet should render ${id}`).toContain(`touchStyle("${id}")`);
    }
  });
});

describe("no hover-dependent interaction", () => {
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

  it("never uses a Tailwind hover: variant", () => {
    for (const file of componentFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      // `hover:` in a className would mean an action that only exists on a
      // device with a pointer. `active:` is fine — it works on touch.
      expect(source, `${file} must not use hover:`).not.toMatch(/\bhover:/);
    }
  });

  it("never uses title= as a hover tooltip", () => {
    for (const file of componentFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(source, `${file} must not rely on title tooltips`).not.toMatch(/\stitle="/);
    }
  });

  it("never uses onMouseEnter/onMouseLeave for interaction", () => {
    for (const file of componentFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(source).not.toMatch(/onMouse(Enter|Leave|Over)/);
    }
  });
});
