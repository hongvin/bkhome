/**
 * i18n parity: no key may be missing between `en` and `ms`, and no placeholder
 * may disagree between them.
 *
 * The TypeScript type already forces `ms` to be a complete `Record<TranslationKey,
 * string>`, but this asserts the same property at runtime so a hand-edited
 * dictionary or a widened type cannot slip through.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  DICTIONARIES,
  LOCALES,
  TRANSLATION_KEYS,
  allParityProblems,
  compareDictionaries,
  interpolate,
  isLocale,
  t,
  translate,
  translator,
} from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { ms } from "@/lib/i18n/ms";

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("dictionary parity", () => {
  it("reports no problems in any locale", () => {
    expect(allParityProblems()).toEqual([]);
  });

  it("has exactly the same key set in en and ms", () => {
    const enKeys = Object.keys(en).sort();
    const msKeys = Object.keys(ms).sort();
    expect(msKeys).toEqual(enKeys);
    expect(compareDictionaries("ms")).toEqual({ missing: [], extra: [] });
  });

  it("has a non-empty string for every key in every locale", () => {
    for (const locale of LOCALES) {
      for (const key of TRANSLATION_KEYS) {
        const value = DICTIONARIES[locale][key];
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("uses the same interpolation placeholders in both languages", () => {
    for (const key of TRANSLATION_KEYS) {
      expect(placeholders(en[key]), key).toEqual(placeholders(ms[key]));
    }
  });

  it("declares at least the alert, severity and confidence vocabulary", () => {
    for (const key of [
      "alert.title",
      "alert.what",
      "alert.where",
      "alert.severity",
      "alert.confidence",
      "alert.sources",
      "alert.lead",
      "severity.INFO",
      "severity.MINOR",
      "severity.MAJOR",
      "severity.SEVERE",
      "issue.TRACK_FAULT",
      "confidence.HIGH",
      "stale.asOf",
      "offline.banner",
      "badge.AVOID",
    ] as const) {
      expect(TRANSLATION_KEYS).toContain(key);
    }
  });

  it("actually translates the severity and issue labels into Bahasa Malaysia", () => {
    // A dictionary that merely copies English would pass parity but fail the
    // product requirement. These must genuinely differ.
    for (const key of [
      "severity.SEVERE",
      "severity.MINOR",
      "issue.TRACK_FAULT",
      "issue.CROWDING",
      "alert.confidence",
      "alert.sources",
      "badge.AVOID",
      "search.from",
      "search.to",
      "offline.banner",
    ] as const) {
      expect(ms[key], `${key} should differ from English`).not.toBe(en[key]);
    }
  });
});

describe("translation lookup", () => {
  it("resolves a key in both locales", () => {
    expect(t("en", "search.from")).toBe("From");
    expect(t("ms", "search.from")).toBe("Dari");
  });

  it("interpolates named parameters", () => {
    expect(t("en", "common.minutes", { n: 14 })).toBe("14 min");
    expect(interpolate("{a} and {b}", { a: 1, b: 2 })).toBe("1 and 2");
  });

  it("leaves unknown placeholders untouched rather than printing undefined", () => {
    expect(interpolate("hello {missing}", {})).toBe("hello {missing}");
  });

  it("falls back to English for an unknown locale", () => {
    const bogus = "xx" as unknown as (typeof LOCALES)[number];
    expect(translate(bogus, "search.from")).toBe("From");
  });

  it("binds a locale through translator()", () => {
    const tr = translator("ms");
    expect(tr("severity.SEVERE")).toBe("Teruk");
    expect(tr("common.minutes", { n: 3 })).toBe("3 min");
  });

  it("validates locale tags", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ms")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("formats the staleness sentence in both languages", () => {
    expect(t("en", "stale.asOf", { time: "08:12", min: 14 })).toBe(
      "as of 08:12, 14 min ago",
    );
    expect(t("ms", "stale.asOf", { time: "08:12", min: 14 })).toBe(
      "setakat 08:12, 14 min lalu",
    );
  });
});
