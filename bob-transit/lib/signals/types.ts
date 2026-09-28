/**
 * Internal types shared by the ingest and verify agents.
 *
 * These are NOT part of the frozen contract surface: nothing here is exported
 * across a module boundary except as an implementation detail. The externally
 * visible artefact is always `DisruptionSignal` from `@/lib/contracts`.
 */

import type {
  IssueType,
  Severity,
  SourceClass,
  SourceRef,
  SupportedLanguage,
} from "@/lib/contracts";

/** A captured source record exactly as it appears in `data/corpus/**`. */
export interface RawSourceRecord {
  id: string;
  sourceClass: SourceClass;
  text: string;
  publishedAt: string;
  retrievedAt: string;
  url?: string;
  /** Stable poster identity. Distinct authors — never reposts — drive social confidence. */
  authorId?: string;
  authorHandle?: string;
  title?: string;
  /** Reposts: the ORIGINAL author this post reproduces. */
  originalAuthorId?: string;
  originalAuthorHandle?: string;
  /** Reposts: corpus id of the record being reproduced. */
  repostOfId?: string;
  language?: SupportedLanguage;
  /** OFFICIAL_REALTIME only. */
  observedLineId?: string;
  observedStationId?: string;
  observation?: RealtimeObservationKind;
}

export type RealtimeObservationKind =
  /** A vehicle is not moving where it should be. Weak evidence of a fault. */
  | "VEHICLE_STALLED"
  /** No vehicle seen where one was expected. NOT evidence of a fault. */
  | "VEHICLE_ABSENT"
  /** Platform crowding measured at a station. */
  | "PLATFORM_CROWD"
  /** Operator telemetry says the line is running normally. */
  | "SERVICE_NORMAL";

export interface PhraseHit {
  /** Surface form as it appeared (normalised). */
  phrase: string;
  canonical: string;
  issueType?: IssueType;
  severity?: Severity;
  /** Weight of this hit when voting on the issue type. */
  weight: number;
}

export interface PhraseParse {
  hits: PhraseHit[];
  issueType: IssueType;
  /** 0..1 — how strongly the text supports `issueType`. */
  issueTypeConfidence: number;
  severity: Severity;
  severityConfidence: number;
  lineMentions: string[];
  stationMentions: string[];
  betweenMention: [string, string] | null;
  /** The text says the disruption is happening now / still ongoing. */
  ongoing: boolean;
  /** The text explicitly places the event in the past. */
  historical: boolean;
  /** The text says service has been restored. */
  recovery: boolean;
  /** Raw time expression found, e.g. "pagi tadi". */
  timeExpression: string | null;
  /** Days before "now" implied by `timeExpression`, when derivable. */
  impliedDaysAgo: number | null;
  /** Operator mentioned alternative/shuttle service. */
  alternativeService: boolean;
  /** Road/weather phrasing present even with no rail station. */
  roadOrWeather: boolean;
}

export interface AuthenticityAssessment {
  /** 0..1 — higher means the post is clearly ironic. */
  sarcasmScore: number;
  /** 0..1 — higher means the post is clearly a joke. */
  jokeScore: number;
  /** 0..1 — higher means the post quotes an old incident as if current. */
  staleQuoteScore: number;
  /** 0..1 — higher means the post is a repost/quote of another post. */
  repostScore: number;
  /**
   * 0..1 multiplier applied to the social channel. Posts below
   * `JUNK_QUALITY_THRESHOLD` are discarded from corroboration entirely.
   */
  qualityMultiplier: number;
  reasons: string[];
  isRepost: boolean;
  /** Who gets credit for this evidence once reposts are collapsed. */
  effectiveAuthorId: string | null;
  effectiveAuthorHandle: string | null;
}

export interface ClaimedTime {
  /** ISO instant the claim refers to, if resolvable. */
  at: string | null;
  raw: string | null;
  ongoing: boolean;
  historical: boolean;
  daysAgo: number | null;
}

export interface ClaimedLocation {
  kind: "STATION" | "LINE" | "SEGMENT" | "ROAD" | "NONE";
  mentions: string[];
  lineMentions: string[];
  stationMentions: string[];
  between: [string, string] | null;
}

/** The common candidate shape every heterogeneous source is normalised into. */
export interface IngestCandidate {
  id: string;
  source: SourceRef;
  sourceClass: SourceClass;
  rawText: string;
  /** Repost prefixes, URLs and quoted handles stripped. */
  normalizedText: string;
  language: SupportedLanguage;
  /** When OUR pipeline first saw this evidence. */
  firstSeenAt: string;
  publishedAt: string;
  location: ClaimedLocation;
  claimedTime: ClaimedTime;
  parse: PhraseParse;
  authenticity: AuthenticityAssessment;
  /** OFFICIAL_REALTIME only: the structured observation behind this record. */
  observation?: RealtimeObservationKind;
  /** OFFICIAL_REALTIME only: machine-provided location, which outranks text. */
  observedStationId?: string;
  observedLineId?: string;
  /**
   * Evidence-volume confidence BEFORE verification: counts only, with every
   * quality penalty set to neutral. The drop from this value to the verified
   * value is the Verifier's contribution and is visible in the provenance hops.
   */
  ingestConfidence: number;
}
