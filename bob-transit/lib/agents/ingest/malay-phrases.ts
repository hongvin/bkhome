/**
 * CUSTOM TOOL — Bahasa Malaysia disruption-phrase parser.
 *
 * Why this cannot come from a template: the phrasing below is RapidKL's own
 * operational vocabulary (`GANGGUAN PERKHIDMATAN`, `TERJEJAS`, `TREN TERKANDAS`,
 * `LALUAN ...`, `STESEN ...`, `KEMAS KINI`, `PIES`, `LANDASAN`, `ISYARAT`). A
 * generic keyword search cannot map `TREN TERKANDAS` and `PINTU TIDAK DAPAT
 * DITUTUP` onto different ISSUE_TYPES, cannot tell a recovery notice from a
 * disruption notice, and cannot tell `SEMALAM` from `MASIH` — which is the
 * difference between a stale quote and a live incident.
 *
 * Every rule is ordered, weighted and unit-tested in
 * `tests/signals/malay-phrases.test.ts`.
 */

import type { IssueType, Severity } from "@/lib/contracts";

import {
  extractAfterKeyword,
  extractBetweenMention,
  foldMalay,
} from "@/lib/signals/malay-text";
import { defineTool } from "@/lib/signals/tool";
import type { PhraseHit, PhraseParse } from "@/lib/signals/types";

export { foldMalay };

interface PhraseRule {
  /** Regex over the folded text. */
  re: RegExp;
  canonical: string;
  issueType?: IssueType;
  severity?: Severity;
  weight: number;
}

/**
 * Ordered most-specific first. The first matching rule for a family wins so that
 * "TREN TERKANDAS" is not swallowed by the generic "GANGGUAN PERKHIDMATAN".
 */
const ISSUE_RULES: PhraseRule[] = [
  // ---- vehicle ----
  { re: /\bTREN\s+TERKANDAS\b/, canonical: "TREN TERKANDAS", issueType: "VEHICLE_BREAKDOWN", severity: "MAJOR", weight: 3 },
  { re: /\bTRAIN\s+(?:IS\s+)?STUCK\b/, canonical: "TRAIN STUCK", issueType: "VEHICLE_BREAKDOWN", severity: "MAJOR", weight: 3 },
  { re: /\bTREN\s+(?:ROS[AK]+|GAGAL|MATI)\b/, canonical: "TREN ROSAK", issueType: "VEHICLE_BREAKDOWN", severity: "MAJOR", weight: 3 },
  { re: /\bKOMPONEN\s+BREK\b|\bBREK\s+(?:ROS[AK]+|GAGAL)\b/, canonical: "BREK ROSAK", issueType: "VEHICLE_BREAKDOWN", severity: "MAJOR", weight: 2 },
  { re: /\bTREN\s+TERBAKAR\b|\bTREN\s+BERASAP\b/, canonical: "TREN TERBAKAR", issueType: "VEHICLE_BREAKDOWN", severity: "SEVERE", weight: 3 },

  // ---- doors ----
  { re: /\bPINTU\s+(?:TREN\s+)?(?:ROS[AK]+|TERSEKAT|TIDAK\s+DAPAT\s+DITUTUP|GAGAL\s+DITUTUP)\b/, canonical: "PINTU ROSAK", issueType: "DOOR_FAULT", severity: "MINOR", weight: 3 },
  { re: /\bDOOR\s+(?:FAULT|PROBLEM|STUCK)\b/, canonical: "DOOR FAULT", issueType: "DOOR_FAULT", severity: "MINOR", weight: 3 },

  // ---- lifts / escalators ----
  { re: /\b(?:LIF|LIFT|ESKALATOR|ESCALATOR|ELEVATOR)\s+(?:ROS[AK]+|TIDAK\s+BERFUNGSI|GAGAL|MATI)\b/, canonical: "LIF ROSAK", issueType: "ELEVATOR_FAULT", severity: "MINOR", weight: 3 },
  { re: /\b(?:LIF|LIFT|ESKALATOR|ELEVATOR)\b/, canonical: "LIF", issueType: "ELEVATOR_FAULT", severity: "INFO", weight: 1 },

  // ---- signalling ----
  { re: /\b(?:SISTEM\s+)?ISYARAT\s+(?:ROS[AK]+|TERJEJAS|GAGAL|MASALAH|GANGGUAN)\b/, canonical: "ISYARAT ROSAK", issueType: "SIGNAL_FAULT", severity: "MAJOR", weight: 3 },
  { re: /\b(?:MASALAH|GANGGUAN|KEROSAKAN)\s+(?:SISTEM\s+)?ISYARAT\b/, canonical: "GANGGUAN ISYARAT", issueType: "SIGNAL_FAULT", severity: "MAJOR", weight: 3 },
  { re: /\bSIGNALL?ING\s+(?:PROBLEM|FAULT|ISSUE|FAILURE)\b/, canonical: "SIGNALLING PROBLEM", issueType: "SIGNAL_FAULT", severity: "MAJOR", weight: 3 },
  { re: /\bSIGNAL\s+(?:FAULT|FAILURE|PROBLEM)\b/, canonical: "SIGNAL FAULT", issueType: "SIGNAL_FAULT", severity: "MAJOR", weight: 3 },

  // ---- track ----
  { re: /\bLANDASAN\s+(?:ROS[AK]+|TERJEJAS|GAGAL)\b/, canonical: "LANDASAN ROSAK", issueType: "TRACK_FAULT", severity: "MAJOR", weight: 3 },
  { re: /\bGANGGUAN\s+SUIS\b|\bSUIS\s+(?:JEJAS|ROS[AK]+)\b/, canonical: "GANGGUAN SUIS", issueType: "TRACK_FAULT", severity: "MAJOR", weight: 3 },
  { re: /\bTRACK\s+(?:FAULT|PROBLEM|ISSUE)\b/, canonical: "TRACK FAULT", issueType: "TRACK_FAULT", severity: "MAJOR", weight: 3 },
  { re: /\bPIES\b|\bSISTEM\s+PIES\b/, canonical: "PIES", issueType: "TRACK_FAULT", severity: "MAJOR", weight: 2 },
  { re: /\bKERJA[- ]KERJA\s+BAIK\s+PULIH\b/, canonical: "KERJA BAIK PULIH", issueType: "TRACK_FAULT", severity: "MINOR", weight: 1 },

  // ---- crowding ----
  { re: /\bSESAK(?:AN)?\b|\bPENUH\s+SESAK\b|\bBERTIMBUN\b/, canonical: "SESAK", issueType: "CROWDING", severity: "MINOR", weight: 2 },
  { re: /\b(?:PLATFORM|PLATFORM)\s+(?:PENUH|SESAK)\b|\bCROWDED\b|\bPACKED\b/, canonical: "PLATFORM PENUH", issueType: "CROWDING", severity: "MINOR", weight: 2 },

  // ---- weather ----
  { re: /\bHUJAN\s+LEBAT\b|\bRIBUT\b|\bANGIN\s+KENCANG\b|\bCUACA\s+BURUK\b|\bHEAVY\s+RAIN\b|\bSTORM\b/, canonical: "HUJAN LEBAT", issueType: "WEATHER", severity: "MAJOR", weight: 2 },
  { re: /\bKILAT\b|\bPETIR\b|\bLIGHTNING\b/, canonical: "KILAT PETIR", issueType: "WEATHER", severity: "MAJOR", weight: 1 },
  { re: /\bBANJIR\b|\bFLOOD(?:ED|ING)?\b/, canonical: "BANJIR", issueType: "WEATHER", severity: "MAJOR", weight: 2 },

  // ---- road ----
  { re: /\bJALAN\s+(?:DITUTUP|TERSEKAT|SESAK)\b|\bROAD\s+(?:CLOSED|BLOCKED)\b/, canonical: "JALAN DITUTUP", issueType: "ROAD_BLOCKED", severity: "MINOR", weight: 2 },
  { re: /\bKEMALANGAN\b|\bACCIDENT\b/, canonical: "KEMALANGAN", issueType: "ROAD_BLOCKED", severity: "MINOR", weight: 2 },

  // ---- delay / generic service ----
  { re: /\bGANGGUAN\s+PERKHIDMATAN\b|\bSERVICE\s+DISRUPTION\b/, canonical: "GANGGUAN PERKHIDMATAN", issueType: "DELAY", severity: "MAJOR", weight: 2 },
  { re: /\bPERKHIDMATAN\s+TERJEJAS\b|\bTERJEJAS\s+(?:JADUAL|PERKHIDMATAN)\b/, canonical: "PERKHIDMATAN TERJEJAS", issueType: "DELAY", severity: "MAJOR", weight: 2 },
  { re: /\b(?:JADUAL\s+PERJALANAN|JADUAL)\s+TERJEJAS\b/, canonical: "JADUAL TERJEJAS", issueType: "DELAY", severity: "MINOR", weight: 2 },
  { re: /\bKELEWATAN\b|\bTERGENDALA\b|\bDELAY(?:ED|S)?\b|\bLAMBAT\b/, canonical: "KELEWATAN", issueType: "DELAY", severity: "MINOR", weight: 2 },
  { re: /\bPERKHIDMATAN\s+DIPENDEKKAN\b|\bSHORT(?:ENED)?\s+SERVICE\b|\bSHUTTLE\s+TRAIN\b/, canonical: "PERKHIDMATAN DIPENDEKKAN", issueType: "DELAY", severity: "MINOR", weight: 2 },
  { re: /\bTREN\s+TIDAK\s+BERHENTI\b|\bSKIP\s+STOP\b/, canonical: "TREN TIDAK BERHENTI", issueType: "DELAY", severity: "MINOR", weight: 2 },
  { re: /\bFREKUENSI\s+(?:JARANG|BERKURANGAN)\b|\bHEADWAY\s+(?:LONGER|INCREASED)\b/, canonical: "FREKUENSI JARANG", issueType: "DELAY", severity: "MINOR", weight: 2 },
  { re: /\b(?:MASALAH|GANGGUAN)\s+TEKNIKAL\b|\bTECHNICAL\s+(?:PROBLEM|ISSUE|FAULT)\b/, canonical: "GANGGUAN TEKNIKAL", issueType: "UNKNOWN", severity: "MINOR", weight: 1 },
  { re: /\bGANGGUAN\b|\bDISRUPTION\b|\bTERJEJAS\b/, canonical: "GANGGUAN", issueType: "UNKNOWN", severity: "MINOR", weight: 1 },
];

const SEVERITY_RULES: PhraseRule[] = [
  { re: /\bBERHENTI\s+SEPENUHNYA\b|\bTIDAK\s+BEROPERASI\b|\bPERKHIDMATAN\s+DIHENTIKAN\b|\bSUSPEND(?:ED|ED)?\b|\bTUTUP\s+SEPENUHNYA\b/, canonical: "TIDAK BEROPERASI", severity: "SEVERE", weight: 3 },
  { re: /\bSEMUA\s+STESEN\b|\bSELURUH\s+LALUAN\b|\bSEPANJANG\s+LALUAN\b|\bWHOLE\s+LINE\b/, canonical: "SELURUH LALUAN", severity: "SEVERE", weight: 3 },
  { re: /\bSANGAT\s+TERUK\b|\bTERUK\b|\bSEVERE\b|\bMAJOR\b|\bKRITIKAL\b|\bCRITICAL\b/, canonical: "TERUK", severity: "MAJOR", weight: 2 },
  { re: /\bSEKURANG[- ]KURANGNYA\s+(\d+)\s*(?:MINIT|MINUTES?|JAM|HOURS?)\b/, canonical: "TEMPOH PANJANG", severity: "MAJOR", weight: 2 },
  { re: /\bLEBIH\s+(?:SATU\s+)?JAM\b|\bMORE\s+THAN\s+AN?\s+HOUR\b/, canonical: "LEBIH SATU JAM", severity: "MAJOR", weight: 2 },
  { re: /\bSEDIKIT\b|\bRINGAN\b|\bMINOR\b|\bSEBENTAR\b|\bBRIEF(?:LY)?\b|\bSLIGHT\b/, canonical: "RINGAN", severity: "MINOR", weight: 2 },
  { re: /\bMAKLUMAN\b|\bNOTIS\b|\bPENGUMUMAN\b|\bHEADS?\s+UP\b|\bADVISORY\b/, canonical: "MAKLUMAN", severity: "INFO", weight: 1 },
];

const RECOVERY_RULES: RegExp[] = [
  /\bKEMBALI\s+BEROPERASI\b/,
  /\bBEROPERASI\s+SEPERTI\s+BIASA\b/,
  /\b(?:TELAH\s+|SUDAH\s+|BERJAYA\s+)?DIPULIHKAN\b/,
  /\bPULIH\s+SEMULA\b/,
  /\bSELESAI\b/,
  /\bNORMAL\s+SEMULA\b/,
  /\bSERVICE\s+(?:HAS\s+BEEN\s+)?RESUMED\b/,
  /\bBACK\s+TO\s+NORMAL\b/,
  /\bCLEARED\b/,
];

const ONGOING_RULES: RegExp[] = [
  /\bMASIH\b/,
  /\bSEHINGGA\s+SEKARANG\b/,
  /\bBELUM\s+PULIH\b/,
  /\bBERTERUSAN\b/,
  /\bBERPANJANGAN\b/,
  /\bSTILL\b/,
  /\bUNTIL\s+NOW\b/,
  /\bONGOING\b/,
  /\bSEDANG\s+(?:BERLAKU|TERJEJAS|TERKANDAS)\b/,
  /\bKEMAS\s+KINI\b/,
  /\bSTATUS\s+TERKINI\b/,
];

const NOW_RULES: RegExp[] = [
  /\bSEKARANG\b/,
  /\bKINI\b/,
  /\bBARU\s+SAHAJA\b/,
  /\bJUST\s+NOW\b/,
  /\bTADI\b/,
  /\bSEDANG\b/,
  /\bTENGAH\b/,
];

/** Explicit "this happened a while ago" markers — the stale-quote trigger. */
const HISTORICAL_RULES: Array<{ re: RegExp; daysAgo: number }> = [
  { re: /\bSEMALAM\b|\bYESTERDAY\b/, daysAgo: 1 },
  { re: /\bKELMARIN\b|\bTHE\s+DAY\s+BEFORE\b/, daysAgo: 2 },
  { re: /\bMINGGU\s+LEPAS\b|\bLAST\s+WEEK\b/, daysAgo: 7 },
  { re: /\bBULAN\s+LEPAS\b|\bLAST\s+MONTH\b/, daysAgo: 30 },
  { re: /\bTAHUN\s+LEPAS\b|\bLAST\s+YEAR\b/, daysAgo: 365 },
  { re: /\bDAHULU\b|\bZAMAN\s+DULU\b|\bMASA\s+TU\b|\bHARI\s+ITU\b|\bTHROWBACK\b|\bTBT\b/, daysAgo: 30 },
  { re: /\bINGAT\s+(?:TAK|LAGI)\b|\bKENANGAN\b|\bARWAH\b/, daysAgo: 30 },
];

/** Years that can only be in the past for this product. */
const PAST_YEAR_RE = /\b(20(?:1[5-9]|2[0-4]))\b/;

const LINE_KEYWORDS = ["LALUAN", "LINE", "ALIRAN", "ROUTE"];
const STATION_KEYWORDS = ["STESEN", "STATION", "HENTIAN"];

/* ------------------------------------------------------------------ *
 * The parser
 * ------------------------------------------------------------------ */

export interface PhraseParserInput {
  text: string;
  /**
   * Reference instant as ISO-8601. Only used to age a bare past year
   * ("2019"). When omitted, a past year is treated as 365 days old — which is
   * stale for every window this product uses — so the parser never reads the
   * wall clock on its own.
   */
  now?: string;
}

/** Days between an ISO instant and the start of the given year. */
function daysSinceYearStart(year: number, nowIso?: string): number {
  if (!nowIso) return 365;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return 365;
  const start = Date.UTC(year, 0, 1);
  return Math.max(0, Math.round((now - start) / 86_400_000));
}

/**
 * Parse one piece of text (Malay, English, or the usual Manglish mixture) into
 * an issue type, severity, location mentions and a time posture.
 */
export function parseMalayDisruptionPhrases(input: string, nowIso?: string): PhraseParse {
  const text = foldMalay(input);
  const hits: PhraseHit[] = [];

  for (const rule of ISSUE_RULES) {
    if (rule.re.test(text)) {
      hits.push({
        phrase: text.match(rule.re)?.[0] ?? rule.canonical,
        canonical: rule.canonical,
        issueType: rule.issueType,
        severity: rule.severity,
        weight: rule.weight,
      });
    }
  }
  for (const rule of SEVERITY_RULES) {
    if (rule.re.test(text)) {
      hits.push({
        phrase: text.match(rule.re)?.[0] ?? rule.canonical,
        canonical: rule.canonical,
        severity: rule.severity,
        weight: rule.weight,
      });
    }
  }

  // Issue type by weighted vote; ties go to the more specific (lower index).
  const issueWeights = new Map<IssueType, number>();
  const issueOrder = new Map<IssueType, number>();
  for (const h of hits) {
    if (!h.issueType) continue;
    issueWeights.set(h.issueType, (issueWeights.get(h.issueType) ?? 0) + h.weight);
    if (!issueOrder.has(h.issueType)) issueOrder.set(h.issueType, issueWeights.size);
  }
  let issueType: IssueType = "UNKNOWN";
  let topIssue = 0;
  let totalIssue = 0;
  for (const [type, w] of issueWeights) {
    totalIssue += w;
    const best = issueWeights.get(issueType) ?? -1;
    if (w > best || (w === best && (issueOrder.get(type) ?? 99) < (issueOrder.get(issueType) ?? 99))) {
      issueType = type;
      topIssue = w;
    }
  }
  const issueTypeConfidence = totalIssue === 0 ? 0 : Math.min(1, topIssue / totalIssue);

  // Severity: highest explicit cue, else the strongest issue-type default.
  const severityRank: Record<Severity, number> = { INFO: 0, MINOR: 1, MAJOR: 2, SEVERE: 3 };
  let severity: Severity = "INFO";
  let severityConfidence = 0;
  for (const h of hits) {
    if (!h.severity) continue;
    if (severityRank[h.severity] > severityRank[severity]) {
      severity = h.severity;
      severityConfidence = 0.5 + Math.min(0.4, h.weight / 10);
    } else if (h.severity === severity) {
      severityConfidence = Math.max(severityConfidence, 0.5 + Math.min(0.4, h.weight / 10));
    }
  }

  const recovery = RECOVERY_RULES.some((re) => re.test(text));

  let timeExpression: string | null = null;
  let impliedDaysAgo: number | null = null;
  for (const rule of HISTORICAL_RULES) {
    const m = rule.re.exec(text);
    if (m) {
      timeExpression = m[0];
      impliedDaysAgo = rule.daysAgo;
      break;
    }
  }
  if (impliedDaysAgo === null) {
    const y = PAST_YEAR_RE.exec(text);
    if (y) {
      timeExpression = y[1];
      impliedDaysAgo = daysSinceYearStart(Number(y[1]), nowIso);
    }
  }
  const historical = impliedDaysAgo !== null && impliedDaysAgo >= 1;

  if (timeExpression === null) {
    for (const re of NOW_RULES) {
      const m = re.exec(text);
      if (m) {
        timeExpression = m[0];
        impliedDaysAgo = 0;
        break;
      }
    }
  }

  // A bare time adverb ("sekarang", "kini") only implies an ONGOING incident when
  // the text is not explicitly about the past. "Minggu lepas ... sekarang dah ok
  // ke belum?" must not read as a live report.
  const ongoing =
    ONGOING_RULES.some((re) => re.test(text)) ||
    (NOW_RULES.some((re) => re.test(text)) && !historical && !recovery);

  const between = extractBetweenMention(text);

  return {
    hits,
    issueType,
    issueTypeConfidence,
    severity,
    severityConfidence,
    lineMentions: extractAfterKeyword(text, LINE_KEYWORDS),
    stationMentions: extractAfterKeyword(text, STATION_KEYWORDS),
    betweenMention: between,
    ongoing,
    historical,
    recovery,
    timeExpression,
    impliedDaysAgo,
    alternativeService: /\b(BAS\s+PERANTARA|PERKHIDMATAN\s+ALTERNATIF|SHUTTLE\s+BUS|BRIDGING\s+BUS|BAS\s+PERCUMA)\b/.test(text),
    roadOrWeather: /\b(JALAN|LEBUHRAYA|HIGHWAY|TRAFIK|TRAFFIC|HUJAN|BANJIR|RIBUT)\b/.test(text),
  };
}

export const malayDisruptionPhraseParser = defineTool<PhraseParserInput, PhraseParse>({
  name: "parse_malay_disruption_phrases",
  description:
    "Parse Bahasa Malaysia / Manglish transit text into ISSUE_TYPES, SEVERITIES, " +
    "location mentions and a time posture.",
  provenance:
    "Encodes RapidKL's real operational vocabulary (GANGGUAN PERKHIDMATAN, TERJEJAS, " +
    "TREN TERKANDAS, LANDASAN, ISYARAT, PIES, KEMAS KINI) and distinguishes recovery " +
    "notices from disruption notices. A generic keyword search cannot map phrases to " +
    "the frozen ISSUE_TYPES enum or separate SEMALAM from MASIH.",
  run: (input) => parseMalayDisruptionPhrases(input.text, input.now),
});
