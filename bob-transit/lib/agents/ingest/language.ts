/**
 * Language detection for the four languages the Klang Valley actually produces.
 *
 * Script detection is exact for Chinese and Tamil; Malay and English are scored
 * by function-word frequency, because the two share the Latin alphabet and
 * Manglish mixes them in one sentence. The frozen contract's `SupportedLanguage`
 * is single-valued, so a mixed post is labelled with whichever language carries
 * more of its function words, and `unknown` is returned only when neither does.
 */

import type { SupportedLanguage } from "@/lib/contracts";

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const TAMIL = /[\u0b80-\u0bff]/;

const MALAY_STOPWORDS = new Set([
  "DAN", "YANG", "TIDAK", "TAK", "ADA", "DI", "KE", "DENGAN", "UNTUK", "SAYA", "AKU", "KAMI",
  "KITA", "SUDAH", "DAH", "BELUM", "MASIH", "INI", "ITU", "DARI", "PADA", "AKAN", "BILA",
  "KALAU", "JIKA", "SANGAT", "LAGI", "SEMUA", "ORANG", "TREN", "STESEN", "LALUAN", "PERKHIDMATAN",
  "GANGGUAN", "TERJEJAS", "KELEWATAN", "SEKARANG", "KINI", "TADI", "SINI", "SANA", "BAGI",
  "TELAH", "BOLEH", "KENA", "PUN", "LAH", "JE", "KOT", "SEBAB",
]);

const ENGLISH_STOPWORDS = new Set([
  "THE", "IS", "ARE", "WAS", "WERE", "AND", "OF", "TO", "IN", "ON", "FOR", "WITH", "THIS",
  "THAT", "NOT", "HAVE", "HAS", "HAD", "BEEN", "WILL", "WOULD", "CAN", "COULD", "AT", "BY",
  "FROM", "IT", "ITS", "AS", "BUT", "OR", "IF", "WHEN", "ALL", "PEOPLE", "TRAIN", "STATION",
  "LINE", "SERVICE", "DELAY", "AGAIN", "STILL",
]);

function tokenize(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z\u3400-\u9fff\u0b80-\u0bff]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export interface LanguageDetection {
  language: SupportedLanguage;
  malayScore: number;
  englishScore: number;
  script: "latin" | "cjk" | "tamil";
}

export function detectLanguage(text: string): LanguageDetection {
  if (CJK.test(text)) {
    return { language: "zh", malayScore: 0, englishScore: 0, script: "cjk" };
  }
  if (TAMIL.test(text)) {
    return { language: "ta", malayScore: 0, englishScore: 0, script: "tamil" };
  }

  const toks = tokenize(text);
  let ms = 0;
  let en = 0;
  for (const t of toks) {
    if (MALAY_STOPWORDS.has(t)) ms += 1;
    if (ENGLISH_STOPWORDS.has(t)) en += 1;
  }
  const malayScore = toks.length === 0 ? 0 : ms / toks.length;
  const englishScore = toks.length === 0 ? 0 : en / toks.length;

  let language: SupportedLanguage = "unknown";
  if (ms === 0 && en === 0) language = "unknown";
  else if (ms >= en) language = "ms";
  else language = "en";

  return { language, malayScore, englishScore, script: "latin" };
}
