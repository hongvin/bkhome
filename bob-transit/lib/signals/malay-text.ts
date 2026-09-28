/**
 * Shared Bahasa Malaysia text folding and place-name trimming.
 *
 * Both the phrase parser (lib/agents/ingest) and the entity resolver
 * (lib/signals) need to turn "Tren berhenti antara KLCC dan Ampang Park sejak
 * 10 minit" into the two place names "KLCC" and "AMPANG PARK". Doing that twice,
 * differently, is how the two halves of the pipeline drift apart — so it lives
 * here once.
 */

/** Uppercase, strip diacritics, keep apostrophes and hyphens, collapse spaces. */
export function foldMalay(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^A-Z0-9'\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokens that end (or, at the start, precede) a place name. Without these,
 * "antara KLCC dan Ampang Park sejak 10 minit" captures "AMPANG PARK SEJAK 10".
 */
export const PLACE_STOPWORDS: ReadonlySet<string> = new Set([
  "DAN", "AND", "KE", "DI", "YANG", "BERHENTI", "TERJEJAS", "ROS", "ROSAK", "GANGGUAN",
  "SEKARANG", "KINI", "MASIH", "TIDAK", "TIADA", "ADA", "SEKAT", "SINI", "ITU", "INI",
  "PADA", "AKAN", "SUDAH", "DAH", "TELAH", "SEHINGGA", "SANGAT", "PULA", "LAH", "UNTUK",
  "DARI", "SEBAB", "SEJAK", "PUKUL", "JAM", "MINIT", "MINUTES", "HOURS", "LAMA", "KIRA",
  "SILA", "GUNA", "LALUAN", "STESEN", "SEBELAH", "ARAH", "HINGGA", "SAMPAI", "SELEPAS",
  "KERANA", "SEMENTARA", "BAGI", "SAHAJA", "LAGI", "BELUM", "BUKAN", "IKUT", "NAIK",
  "ANTARA", "BETWEEN", "MELALUI", "SERTA", "JUGA", "AKAN", "SEDANG", "DILAPORKAN", "TELAH",
]);

/** Keep at most `maxTokens` leading tokens, dropping a trailing clause. */
export function trimPlaceMention(raw: string, maxTokens = 4): string {
  const toks = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  const kept: string[] = [];
  for (const t of toks) {
    if (PLACE_STOPWORDS.has(t)) {
      // Leading connectives ("STESEN LRT KL SENTRAL") are skipped, not fatal.
      if (kept.length === 0) continue;
      break;
    }
    kept.push(t);
    if (kept.length >= maxTokens) break;
  }
  return kept.join(" ");
}

/**
 * Extract an "antara X dan Y" / "between X and Y" pair from folded text.
 * Returns null when the sentence does not contain a clean two-place claim.
 */
export function extractBetweenMention(folded: string): [string, string] | null {
  const marker = /\b(?:ANTARA|BETWEEN)\s+(.+)$/.exec(folded);
  if (!marker) return null;
  const sentence = marker[1].split(/[.!?;]/)[0];
  const parts = sentence.split(/\s+(?:DAN|AND|HINGGA|TO)\s+/);
  if (parts.length < 2) return null;
  const left = trimPlaceMention(parts[0]);
  const right = trimPlaceMention(parts[1]);
  if (!left || !right) return null;
  return [left, right];
}

/** Extract place names following a keyword such as LALUAN or STESEN. */
export function extractAfterKeyword(folded: string, keywords: string[]): string[] {
  const out: string[] = [];
  const kw = keywords.join("|");
  const re = new RegExp(`\\b(?:${kw})\\s+([A-Z0-9][A-Z0-9'\\- ]{2,60})`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(folded)) !== null) {
    const trimmed = trimPlaceMention(m[1]);
    if (trimmed) out.push(trimmed);
  }
  return out;
}
