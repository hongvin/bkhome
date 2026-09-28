/**
 * CUSTOM TOOL — social-post authenticity and sarcasm detector.
 *
 * Why this cannot come from a template: it encodes how Malaysian commuters
 * actually complain. The dangerous false positive in this product is not spam —
 * it is a *sincere-looking* post that is actually a joke ("TERBAIK LA RAPID,
 * 40 MINIT TUNGGU"), a repost that looks like a second witness, or a screenshot
 * of the 2021 Kelana Jaya closure shared as if it were happening now. A generic
 * sentiment model scores those as *negative*, which is exactly backwards: they
 * are the posts that must NOT become signals.
 *
 * Output is a 0..1 quality multiplier on the social channel plus a written
 * reason for every deduction. Posts below `JUNK_QUALITY_THRESHOLD` are dropped
 * from corroboration entirely, so a joke can never become a crowd.
 */

import { JUNK_QUALITY_THRESHOLD } from "@/lib/signals/calibration";
import { defineTool } from "@/lib/signals/tool";
import type { AuthenticityAssessment, PhraseParse } from "@/lib/signals/types";

export { JUNK_QUALITY_THRESHOLD };

interface Marker {
  re: RegExp;
  label: string;
  weight: number;
}

/** Irony, mock-praise and sarcasm markers. */
const SARCASM_MARKERS: Marker[] = [
  { re: /\/S\b/, label: "explicit /s sarcasm tag", weight: 1 },
  { re: /\b(?:HAHA|HAHAHA|HEHE|LOL|LMAO|ROFL)\b/, label: "laughter marker", weight: 0.6 },
  // Deliberately narrow: smiling/laughing emoji only. Crying and angry emoji are
  // genuine distress signals and must NOT be read as sarcasm.
  { re: /[\u{1F600}-\u{1F60A}\u{1F642}\u{1F643}\u{1F923}]/u, label: "smiling/laughing emoji", weight: 0.5 },
  { re: /\bSARKASTIK\b|\bSARCASM\b|\bSARKAS\b/, label: "self-declared sarcasm", weight: 1 },
  { re: /\bKONON(?:NYA)?\b|\bKATANYA\b|\bALLEGEDLY\b/, label: "dismissive 'kononnya'", weight: 0.8 },
  { re: /\b(?:BAGUS|TERBAIK|HEBAT|MENAKJUBKAN|EFEKTIF|CEKAP)\s*(?:LA|LAH|SANGAT|NYA|BETUL)?\b/, label: "mock praise", weight: 0.7 },
  { re: /\bTAHNIAH\b|\bSYABAS\b|\bCONGRATULATIONS\b/, label: "mock congratulation", weight: 0.7 },
  { re: /\bWOW\b|\bAMAZING\b|\bSPECTACULAR\b/, label: "mock awe", weight: 0.5 },
  { re: /\bMEMANG\s+(?:BAGUS|HEBAT|CEKAP|EFISIEN)\b/, label: "ironic 'memang bagus'", weight: 0.8 },
  { re: /\bPENCAPAIAN\b|\bREKOD\s+BARU\b|\bWORLD\s+CLASS\b/, label: "ironic achievement framing", weight: 0.6 },
  { re: /\bALHAMDULILLAH\b/, label: "ironic gratitude", weight: 0.4 },
  { re: /\b(?:ALAH|CIS|SIGH)\b/, label: "resignation marker", weight: 0.3 },
];

/** Outright jokes, memes and absurd alternatives. */
const JOKE_MARKERS: Marker[] = [
  { re: /\bPRANK\b|\bJOKE\b|\bMEME\b|\bLAWAK\b|\bJENAKA\b|\bKELAKAR\b/, label: "explicit joke framing", weight: 1 },
  { re: /\bKAHWIN\b|\bHAPPY\s+BIRTHDAY\b|\bSELAMAT\s+HARI\s+JADI\b/, label: "absurd event framing", weight: 0.9 },
  { re: /\bJALAN\s+KAKI\b|\bBASIKAL\b|\bBERENANG\b|\bSWIMMING\b|\bPENGUIN\b|\bKAPAL\b|\bPERAHU\b/, label: "absurd alternative transport", weight: 0.8 },
  { re: /\bPOKEMON\b|\bGAME\b|\bGIVEAWAY\b|\bLOTERI\b/, label: "game framing", weight: 0.7 },
  { re: /\bMAKAN\s+ANGIN\b|\bTIDUR\s+DI\s+STESEN\b|\bBERKHEMAH\b|\bCAMPING\b/, label: "absurd coping", weight: 0.7 },
  { re: /[\u{1F602}\u{1F923}]{2,}/u, label: "repeated laughing emoji", weight: 0.8 },
];

/** Screenshot-of-an-old-incident and throwback markers. */
const STALE_MARKERS: Marker[] = [
  { re: /\bTHROWBACK\b|\bTBT\b|\bFLASHBACK\b/, label: "throwback tag", weight: 1 },
  { re: /\bINGAT\s+(?:TAK|LAGI)\b|\bREMEMBER\s+WHEN\b/, label: "nostalgia prompt", weight: 0.9 },
  { re: /\bSEMALAM\b|\bKELMARIN\b|\bYESTERDAY\b/, label: "yesterday reference", weight: 0.7 },
  { re: /\bMINGGU\s+LEPAS\b|\bBULAN\s+LEPAS\b|\bTAHUN\s+LEPAS\b|\bLAST\s+(?:WEEK|MONTH|YEAR)\b/, label: "past period reference", weight: 0.9 },
  { re: /\bZAMAN\s+DULU\b|\bMASA\s+TU\b|\bHARI\s+ITU\b|\bDAHULU\b|\bDULU\b/, label: "past-tense framing", weight: 0.8 },
  { re: /\bKENANGAN\b|\bARWAH\b|\bR\.I\.P\b|\bALMARHUM\b/, label: "obituary/nostalgia framing", weight: 0.9 },
  { re: /\b(?:19|20)\d{2}\b/, label: "explicit past year", weight: 0.9 },
  { re: /\bSCREENSHOT\b|\bGAMBAR\s+LAMA\b|\bOLD\s+PHOTO\b/, label: "old screenshot", weight: 0.6 },
];

/** Markers that this post is a copy of someone else's. */
const REPOST_MARKERS: Marker[] = [
  { re: /^\s*RT\s*@/, label: "twitter-style RT prefix", weight: 1 },
  { re: /\bRT\s*@[A-Z0-9_]+/, label: "inline RT attribution", weight: 1 },
  { re: /\bREPOST(?:ED|ING)?\b|\bRE-?POST\b/, label: "explicit repost", weight: 1 },
  { re: /\bVIA\s*@[A-Z0-9_]+|\bCREDIT\s*(?:TO)?\s*:?|\bSUMBER\s*:/, label: "credit/source attribution", weight: 0.8 },
  { re: /\bFORWARD(?:ED)?\b|\bFWD\b|\bCOPIED\b|\bCOPYPASTA\b|\bSHARE\s+THIS\b/, label: "forwarded content", weight: 0.9 },
  { re: /\bAMBIL\s+DARI\b|\bSCREENSHOT\s+DARI\b/, label: "taken from another source", weight: 0.8 },
];

export interface AuthenticityInput {
  text: string;
  authorId?: string;
  authorHandle?: string;
  originalAuthorId?: string;
  originalAuthorHandle?: string;
  repostOfId?: string;
  /** Optional pre-computed parse, to avoid running the phrase parser twice. */
  parse?: PhraseParse;
  /** Reference instant (ISO) used to age explicit past references. */
  now?: string;
}

function scoreMarkers(folded: string, markers: Marker[]): { score: number; labels: string[] } {
  let total = 0;
  const labels: string[] = [];
  for (const m of markers) {
    if (m.re.test(folded)) {
      total += m.weight;
      labels.push(m.label);
    }
  }
  // Three independent strong markers saturate the score.
  return { score: Math.min(1, total / 3), labels };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export function assessSocialAuthenticity(input: AuthenticityInput): AuthenticityAssessment {
  const folded = input.text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  const sarcasm = scoreMarkers(folded, SARCASM_MARKERS);
  const joke = scoreMarkers(folded, JOKE_MARKERS);
  const stale = scoreMarkers(folded, STALE_MARKERS);
  const repost = scoreMarkers(folded, REPOST_MARKERS);

  const reasons: string[] = [];
  const hasStructuredRepost = Boolean(input.originalAuthorId || input.repostOfId);
  const isRepost = hasStructuredRepost || repost.score >= 0.5;

  let staleScore = stale.score;
  // A post that quotes the past but says the problem is STILL happening is a
  // live report with historical colour, not a stale quote.
  const ongoing = input.parse?.ongoing ?? /\b(MASIH|SEHINGGA SEKARANG|BELUM PULIH|STILL|BERTERUSAN)\b/.test(folded);
  if (ongoing && staleScore > 0) {
    reasons.push(
      `past reference present but the post states the problem is still ongoing — treated as live, not stale (stale ${staleScore.toFixed(2)} -> 0.30)`,
    );
    staleScore = Math.min(staleScore, 0.3);
  }
  if (input.parse?.historical && !ongoing) {
    staleScore = Math.max(staleScore, 0.7);
  }
  if (input.parse?.impliedDaysAgo !== null && input.parse?.impliedDaysAgo !== undefined) {
    if (input.parse.impliedDaysAgo >= 1 && !ongoing) {
      staleScore = Math.max(staleScore, Math.min(1, 0.5 + input.parse.impliedDaysAgo / 60));
    }
  }

  let quality = 1;
  if (staleScore >= JUNK_QUALITY_THRESHOLD) {
    quality *= 0.05;
    reasons.push(`stale/old-incident quote (${staleScore.toFixed(2)}): ${stale.labels.join(", ")}`);
  } else if (staleScore > 0) {
    quality *= 1 - 0.9 * staleScore;
    reasons.push(`possible stale reference (${staleScore.toFixed(2)}): ${stale.labels.join(", ")}`);
  }

  if (sarcasm.score >= JUNK_QUALITY_THRESHOLD) {
    quality *= 0.08;
    reasons.push(`sarcastic (${sarcasm.score.toFixed(2)}): ${sarcasm.labels.join(", ")}`);
  } else if (sarcasm.score > 0) {
    quality *= 1 - 0.85 * sarcasm.score;
    reasons.push(`mild irony markers (${sarcasm.score.toFixed(2)}): ${sarcasm.labels.join(", ")}`);
  }

  if (joke.score >= JUNK_QUALITY_THRESHOLD) {
    quality *= 0.1;
    reasons.push(`joke/meme (${joke.score.toFixed(2)}): ${joke.labels.join(", ")}`);
  } else if (joke.score > 0) {
    quality *= 1 - 0.8 * joke.score;
    reasons.push(`playful markers (${joke.score.toFixed(2)}): ${joke.labels.join(", ")}`);
  }

  if (isRepost) {
    reasons.push(
      hasStructuredRepost
        ? `repost of ${input.originalAuthorHandle ?? input.originalAuthorId ?? input.repostOfId} — carries no new independent evidence`
        : `looks like a repost (${repost.labels.join(", ")})`,
    );
  }
  if (reasons.length === 0) reasons.push("no irony, joke, stale-quote or repost markers detected");

  return {
    sarcasmScore: clamp01(sarcasm.score),
    jokeScore: clamp01(joke.score),
    staleQuoteScore: clamp01(staleScore),
    repostScore: clamp01(Math.max(repost.score, hasStructuredRepost ? 1 : 0)),
    qualityMultiplier: clamp01(Math.max(0.02, quality)),
    reasons,
    isRepost,
    effectiveAuthorId: input.originalAuthorId ?? input.authorId ?? null,
    effectiveAuthorHandle: input.originalAuthorHandle ?? input.authorHandle ?? null,
  };
}

export const socialAuthenticityDetector = defineTool<AuthenticityInput, AuthenticityAssessment>({
  name: "assess_social_authenticity",
  description:
    "Score a social post for sarcasm, joke framing, stale-incident quoting and " +
    "reposting, and return a 0..1 quality multiplier on the social channel.",
  provenance:
    "Built from real Malaysian commuter phrasing, including mock praise " +
    "('TERBAIK LA RAPID'), absurd-alternative jokes, and throwback screenshots of " +
    "past Kelana Jaya closures. A generic sentiment or keyword filter scores these " +
    "as strongly negative — i.e. as strong evidence — which is precisely the " +
    "false positive this product must not make.",
  run: assessSocialAuthenticity,
});
