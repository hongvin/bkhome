/**
 * Ingest normalisation: heterogeneous source records -> one common candidate.
 *
 * The output shape (`IngestCandidate`) is the contract between ingest and
 * verify. Nothing downstream re-parses raw text; if a fact is not on the
 * candidate, the verifier does not get to guess it.
 */

import type { SourceRef } from "@/lib/contracts";
import { calibrateConfidence } from "@/lib/signals/calibration";
import { sha256Hex } from "@/lib/signals/hash";
import type {
  AuthenticityAssessment,
  ClaimedLocation,
  ClaimedTime,
  IngestCandidate,
  PhraseParse,
  RawSourceRecord,
} from "@/lib/signals/types";

import { detectLanguage } from "./language";
import { parseMalayDisruptionPhrases } from "./malay-phrases";
import { assessSocialAuthenticity } from "./social-authenticity";

const URL_RE = /https?:\/\/\S+/g;
const RT_PREFIX_RE = /^\s*(?:RT|RP|FWD?)\s*@[A-Za-z0-9_]+[:\s-]*/;
const LEADING_MENTIONS_RE = /^(?:\s*@[A-Za-z0-9_]+\s*[:,-]?\s*)+/;
const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;

/**
 * Produce the text the parser and the hash operate on: repost scaffolding and
 * URLs removed so that a repost of the same original hashes identically to the
 * original, and whitespace collapsed.
 */
export function normalizeSourceText(raw: string): string {
  return raw
    .replace(ZERO_WIDTH_RE, "")
    .replace(RT_PREFIX_RE, "")
    .replace(LEADING_MENTIONS_RE, "")
    .replace(URL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 of the normalised text — the contract's `contentHash`. */
export function contentHashOf(raw: string): string {
  return sha256Hex(normalizeSourceText(raw));
}

function claimedTimeFrom(parse: PhraseParse, publishedAt: string): ClaimedTime {
  let at: string | null = null;
  if (parse.impliedDaysAgo === 0) at = publishedAt;
  else if (parse.impliedDaysAgo !== null && parse.impliedDaysAgo > 0) {
    at = new Date(Date.parse(publishedAt) - parse.impliedDaysAgo * 86_400_000).toISOString();
  }
  return {
    at,
    raw: parse.timeExpression,
    ongoing: parse.ongoing,
    historical: parse.historical,
    daysAgo: parse.impliedDaysAgo,
  };
}

function claimedLocationFrom(parse: PhraseParse): ClaimedLocation {
  const stationMentions = [...parse.stationMentions];
  const lineMentions = [...parse.lineMentions];
  if (parse.betweenMention) {
    stationMentions.push(parse.betweenMention[0], parse.betweenMention[1]);
  }
  let kind: ClaimedLocation["kind"] = "NONE";
  if (parse.betweenMention) kind = "SEGMENT";
  else if (stationMentions.length > 0) kind = "STATION";
  else if (lineMentions.length > 0) kind = "LINE";
  else if (parse.roadOrWeather) kind = "ROAD";
  return {
    kind,
    mentions: [...new Set([...stationMentions, ...lineMentions])],
    lineMentions: [...new Set(lineMentions)],
    stationMentions: [...new Set(stationMentions)],
    between: parse.betweenMention,
  };
}

export interface IngestContext {
  /** Reference instant for staleness. Defaults to the record's `retrievedAt`. */
  now?: string;
  /** Overrides `retrievedAt` as the moment our pipeline first saw the record. */
  firstSeenAt?: string;
}

/**
 * Normalise one source record.
 *
 * The `ingestConfidence` on the result is deliberately *neutral*: it counts the
 * evidence this single record carries and applies no quality penalties. The
 * Verifier is what turns volume into (or refuses to turn it into) confidence.
 */
export function ingestSource(record: RawSourceRecord, ctx: IngestContext = {}): IngestCandidate {
  const normalizedText = normalizeSourceText(record.text);
  const now = ctx.now ?? record.retrievedAt;
  const parse = parseMalayDisruptionPhrases(normalizedText, now);

  const authenticity: AuthenticityAssessment = assessSocialAuthenticity({
    text: normalizedText,
    authorId: record.authorId,
    authorHandle: record.authorHandle,
    originalAuthorId: record.originalAuthorId,
    originalAuthorHandle: record.originalAuthorHandle,
    repostOfId: record.repostOfId,
    parse,
    now,
  });

  const detection = detectLanguage(normalizedText);
  const language = record.language ?? detection.language;

  const source: SourceRef = {
    id: record.id,
    sourceClass: record.sourceClass,
    rawText: record.text,
    publishedAt: record.publishedAt,
    retrievedAt: record.retrievedAt,
    language,
    contentHash: contentHashOf(record.text),
  };
  if (record.url !== undefined) source.url = record.url;
  if (record.authorId !== undefined) source.authorId = record.authorId;
  if (record.authorHandle !== undefined) source.authorHandle = record.authorHandle;
  if (record.title !== undefined) source.title = record.title;

  const ingestConfidence = calibrateConfidence({
    socialDistinctAuthors: record.sourceClass === "SOCIAL" ? 1 : 0,
    officialStatementCount: record.sourceClass === "OFFICIAL_STATEMENT" ? 1 : 0,
    realtimeObservationCount:
      record.sourceClass === "OFFICIAL_REALTIME" &&
      (record.observation === "VEHICLE_STALLED" || record.observation === "PLATFORM_CROWD")
        ? 1
        : 0,
  });

  const candidate: IngestCandidate = {
    id: record.id,
    source,
    sourceClass: record.sourceClass,
    rawText: record.text,
    normalizedText,
    language,
    firstSeenAt: ctx.firstSeenAt ?? record.retrievedAt,
    publishedAt: record.publishedAt,
    location: claimedLocationFrom(parse),
    claimedTime: claimedTimeFrom(parse, record.publishedAt),
    parse,
    authenticity,
    ingestConfidence: ingestConfidence.value,
  };
  if (record.observation !== undefined) candidate.observation = record.observation;
  if (record.observedStationId !== undefined) candidate.observedStationId = record.observedStationId;
  if (record.observedLineId !== undefined) candidate.observedLineId = record.observedLineId;
  return candidate;
}

/** Normalise a whole batch, preserving input order. */
export function ingestBatch(records: RawSourceRecord[], ctx: IngestContext = {}): IngestCandidate[] {
  return records.map((r) => ingestSource(r, ctx));
}
