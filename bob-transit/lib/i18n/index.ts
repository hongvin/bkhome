/**
 * i18n — Bahasa Malaysia / English.
 *
 * Pure and framework-free: no React, no DOM, no I/O, so it is safe to import
 * from server code, client components and tests alike.
 *
 * `en` is the canonical key set. `ms` is typed as a complete `Record` of it, so
 * a missing translation is a compile error; tests/ui/i18n.test.ts additionally
 * asserts key parity at runtime.
 *
 * Malaysia is multilingual and the alert text IS the product, so every
 * user-facing string — including severity, issue type and confidence band
 * labels — goes through here. Raw `reasoning` text from the pipeline is
 * deliberately NOT translated: it is evidence, and paraphrasing evidence would
 * be dishonest.
 */
import { en, type Dictionary, type TranslationKey } from "./en";
import { ms } from "./ms";

export const LOCALES = ["en", "ms"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const DICTIONARIES: Record<Locale, Dictionary> = { en, ms };

export const LOCALE_LABEL_KEY: Record<Locale, TranslationKey> = {
  en: "locale.name.en",
  ms: "locale.name.ms",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export type TranslateParams = Record<string, string | number>;

/** Replace `{name}` placeholders. Unknown placeholders are left untouched. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve a key. Falls back to English, then to the key itself, so a missing
 * string is visible in the UI rather than rendering as blank.
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: TranslateParams,
): string {
  const table = DICTIONARIES[locale] ?? en;
  const template = table[key] ?? en[key] ?? key;
  return interpolate(template, params);
}

/** Short alias used throughout the components. */
export const t = translate;

/** Locale-bound translator, e.g. `const tr = translator(locale); tr("search.from")`. */
export function translator(locale: Locale) {
  return (key: TranslationKey, params?: TranslateParams) => translate(locale, key, params);
}

export interface KeyParityReport {
  /** Keys present in `en` but missing from the other locale. */
  missing: TranslationKey[];
  /** Keys present in the other locale but absent from `en`. */
  extra: string[];
}

export function compareDictionaries(locale: Locale): KeyParityReport {
  const base = Object.keys(en) as TranslationKey[];
  const other = Object.keys(DICTIONARIES[locale]);
  const otherSet = new Set(other);
  const baseSet = new Set<string>(base);
  return {
    missing: base.filter((key) => !otherSet.has(key)),
    extra: other.filter((key) => !baseSet.has(key)),
  };
}

/** Every locale, every parity problem. Empty array means the dictionaries agree. */
export function allParityProblems(): Array<{ locale: Locale } & KeyParityReport> {
  return LOCALES.map((locale) => ({ locale, ...compareDictionaries(locale) })).filter(
    (report) => report.missing.length > 0 || report.extra.length > 0,
  );
}

/** All keys, for exhaustive tests and for the touch-target registry. */
export const TRANSLATION_KEYS = Object.keys(en) as TranslationKey[];

export { en, ms };
export type { Dictionary, TranslationKey };
