/**
 * The local pipeline interface used by the eval.
 *
 * S3 owns the real Ingest/Verify agents under `lib/agents/**`. The eval must not
 * block on them and must not import them, so this module defines the narrow
 * interface the eval scores against and ships a deterministic, fixture-driven
 * REFERENCE implementation. Swapping in the real agents later means writing one
 * adapter that satisfies `EvalPipeline` — no change to the metrics or the report.
 *
 *   export interface EvalPipeline {
 *     ingest(evidence, opts): EvalCandidate[]
 *     verify(candidates, opts): EvalSignal[]
 *     run(evidence, opts): EvalSignal[]
 *   }
 *
 * The reference implementation is deliberately NOT a stub: it runs the real
 * Malay parser (`./parse`) over raw evidence text to recover lines, stations and
 * issue type, so a parser regression shows up as a recall/coverage regression.
 */

import type {
  ConfidenceScore,
  IssueType,
  Severity,
  SignalProvenanceHop,
  SignalStatus,
  SourceClass,
  SupportedLanguage,
} from "@/lib/contracts";
import { confidenceBand } from "@/lib/contracts";
import { extractIssueType, extractLineIds, extractSeverity, extractStations } from "./parse";
import { stationIndex, type StationIndex } from "./stations";
import { shortHash } from "./text";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface EvalEvidence {
  id: string;
  sourceClass: SourceClass;
  /** DISTINCT authors only; reposts must not inflate confidence. */
  authorId: string;
  authorHandle: string;
  /** Raw Malay / English text, exactly as a scraper would hand it to ingest. */
  rawText: string;
  publishedAt: string;
  retrievedAt: string;
  language: SupportedLanguage;
  contentHash: string;
}

export interface EvalCandidate {
  id: string;
  lineIds: string[];
  stationIds: string[];
  issueType: IssueType;
  severity: Severity;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceIds: string[];
  distinctAuthors: number;
  officialRealtimeCount: number;
  officialStatementCount: number;
}

export interface EvalSignal extends EvalCandidate {
  status: SignalStatus;
  confidence: ConfidenceScore;
  reasoning: string;
  operatorNotifiedAt: string | null;
  leadTimeMinutes: number | null;
  provenance: SignalProvenanceHop[];
}

export interface VerifyOptions {
  /**
   * Minimum calibrated confidence for a candidate to be emitted. Lowering it
   * trades precision for recall; `run-eval` sweeps it.
   */
  confidenceThreshold: number;
  /** Minimum distinct social authors when there is no realtime corroboration. */
  minDistinctAuthors: number;
  /** "Now" for the pipeline. Always passed in — the eval never reads the clock. */
  asOf: string;
}

export const REFERENCE_VERIFY_OPTIONS: VerifyOptions = {
  confidenceThreshold: 0.4,
  minDistinctAuthors: 2,
  asOf: "1970-01-01T00:00:00.000Z",
};

export interface EvalPipeline {
  readonly name: string;
  readonly version: string;
  /** Normalise, dedupe and cluster raw evidence into candidate disruptions. */
  ingest(evidence: EvalEvidence[], index: StationIndex): EvalCandidate[];
  /** Score candidates and decide which become signals. */
  verify(candidates: EvalCandidate[], options: VerifyOptions): EvalSignal[];
  run(evidence: EvalEvidence[], options?: Partial<VerifyOptions>): EvalSignal[];
}

// ---------------------------------------------------------------------------
// Reference implementation
// ---------------------------------------------------------------------------

/** Evidence closer together than this is treated as one candidate disruption. */
export const CLUSTER_WINDOW_MINUTES = 120;

function minutes(a: string, b: string): number {
  return (Date.parse(a) - Date.parse(b)) / 60000;
}

interface ParsedEvidence {
  evidence: EvalEvidence;
  lineIds: string[];
  stationIds: string[];
  issueType: IssueType;
  severity: Severity;
}

function parseEvidence(evidence: EvalEvidence, index: StationIndex): ParsedEvidence {
  const text = evidence.rawText;
  const stations = extractStations(text, index);
  return {
    evidence,
    lineIds: extractLineIds(text),
    stationIds: [...new Set(stations.map((s) => s.stationId))],
    issueType: extractIssueType(text),
    severity: extractSeverity(text),
  };
}

/** Deterministic cluster id, so signal ids are stable across runs. */
function clusterId(parts: string[]): string {
  return `cand-${shortHash(parts.join("|"))}`;
}

function makeReferencePipeline(): EvalPipeline {
  return {
    name: "reference-ingest-verify",
    version: "1.0.0",

    ingest(evidence, index) {
      // 1. Dedupe by content hash — reposts must not inflate corroboration.
      const seen = new Set<string>();
      const unique: EvalEvidence[] = [];
      for (const e of [...evidence].sort((a, b) =>
        a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : 1,
      )) {
        if (seen.has(e.contentHash)) continue;
        seen.add(e.contentHash);
        unique.push(e);
      }

      const parsed = unique.map((e) => parseEvidence(e, index));

      // 2. Greedy clustering: same line, overlapping stations (or neither side
      //    names a station), inside the cluster window.
      const clusters: ParsedEvidence[][] = [];
      for (const item of parsed) {
        const target = clusters.find((c) => {
          const head = c[0]!;
          if (Math.abs(minutes(item.evidence.publishedAt, head.evidence.publishedAt)) > CLUSTER_WINDOW_MINUTES) {
            return false;
          }
          const lineOverlap =
            item.lineIds.length === 0 || head.lineIds.length === 0
              ? item.lineIds.length === head.lineIds.length
              : item.lineIds.some((l) => head.lineIds.includes(l));
          if (!lineOverlap) return false;
          const stationOverlap =
            item.stationIds.length === 0 || head.stationIds.length === 0
              ? true
              : item.stationIds.some((s) => head.stationIds.includes(s));
          return stationOverlap;
        });
        if (target) target.push(item);
        else clusters.push([item]);
      }

      return clusters.map((cluster) => {
        const sorted = [...cluster].sort((a, b) =>
          a.evidence.publishedAt < b.evidence.publishedAt ? -1 : 1,
        );
        const lineIds = [...new Set(sorted.flatMap((p) => p.lineIds))].sort();
        const stationIds = [...new Set(sorted.flatMap((p) => p.stationIds))].sort();
        const authors = new Set(
          sorted.filter((p) => p.evidence.sourceClass === "SOCIAL").map((p) => p.evidence.authorId),
        );
        // Issue type by majority vote over the cluster's evidence, ties broken
        // by the frozen priority order inside `extractIssueType`.
        const issueCounts = new Map<IssueType, number>();
        for (const p of sorted) {
          issueCounts.set(p.issueType, (issueCounts.get(p.issueType) ?? 0) + 1);
        }
        const issueType =
          [...issueCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ??
          "UNKNOWN";
        const severityRank = ["INFO", "MINOR", "MAJOR", "SEVERE"];
        const severity = sorted
          .map((p) => p.severity)
          .sort((a, b) => severityRank.indexOf(b) - severityRank.indexOf(a))[0]!;

        return {
          id: clusterId([lineIds.join("+"), stationIds.join("+"), sorted[0]!.evidence.publishedAt]),
          lineIds,
          stationIds,
          issueType,
          severity,
          firstSeenAt: sorted[0]!.evidence.publishedAt,
          lastSeenAt: sorted[sorted.length - 1]!.evidence.publishedAt,
          evidenceIds: sorted.map((p) => p.evidence.id).sort(),
          distinctAuthors: authors.size,
          officialRealtimeCount: sorted.filter((p) => p.evidence.sourceClass === "OFFICIAL_REALTIME").length,
          officialStatementCount: sorted.filter((p) => p.evidence.sourceClass === "OFFICIAL_STATEMENT").length,
        };
      });
    },

    verify(candidates, options) {
      return candidates.map((candidate) => {
        const corroboration = Math.min(candidate.distinctAuthors, 3) / 3;
        const realtime = candidate.officialRealtimeCount > 0 ? 1 : 0;
        const location =
          candidate.stationIds.length > 0 ? 1 : candidate.lineIds.length > 0 ? 0.5 : 0;
        const issue = candidate.issueType !== "UNKNOWN" ? 1 : 0;

        const factors = [
          { name: "distinct_social_authors", weight: 0.45, contribution: 0.45 * corroboration, note: `${candidate.distinctAuthors} distinct social authors` },
          { name: "official_realtime", weight: 0.2, contribution: 0.2 * realtime, note: `${candidate.officialRealtimeCount} realtime observations` },
          { name: "location_specificity", weight: 0.2, contribution: 0.2 * location, note: `${candidate.stationIds.length} station(s), ${candidate.lineIds.length} line(s)` },
          { name: "issue_specificity", weight: 0.15, contribution: 0.15 * issue, note: `issue type ${candidate.issueType}` },
        ];
        const value = Math.round(factors.reduce((a, f) => a + f.contribution, 0) * 1000) / 1000;

        const corroborated =
          candidate.officialRealtimeCount > 0 ||
          candidate.officialStatementCount > 0 ||
          candidate.distinctAuthors >= options.minDistinctAuthors;
        const passes = corroborated && value >= options.confidenceThreshold;

        const confidence: ConfidenceScore = {
          value,
          calibrationVersion: "eval-reference-1.0.0",
          factors,
          band: confidenceBand(value),
          degradedByOfflineCache: false,
        };

        const status: SignalStatus = passes ? "CONFIRMED" : "REJECTED";
        const provenance: SignalProvenanceHop[] = [
          {
            hop: "INGEST",
            at: candidate.firstSeenAt,
            confidence: 0,
            summary: `clustered ${candidate.evidenceIds.length} evidence item(s)`,
            data: { evidenceIds: candidate.evidenceIds },
          },
          {
            hop: "VERIFY",
            at: candidate.lastSeenAt,
            confidence: value,
            summary: passes
              ? `corroborated by ${candidate.distinctAuthors} author(s); confidence ${value}`
              : `rejected: corroborated=${corroborated}, confidence ${value} < ${options.confidenceThreshold}`,
          },
        ];

        return {
          ...candidate,
          status,
          confidence,
          reasoning: passes
            ? `${candidate.distinctAuthors} distinct authors report a ${candidate.issueType} on ${candidate.lineIds.join("/") || "an unnamed line"}; confidence ${value}.`
            : `Only ${candidate.distinctAuthors} distinct author(s); below the verification floor.`,
          operatorNotifiedAt: null,
          leadTimeMinutes: null,
          provenance,
        };
      });
    },

    run(evidence, options) {
      const index = stationIndex();
      const opts = { ...REFERENCE_VERIFY_OPTIONS, ...options };
      return this.verify(this.ingest(evidence, index), opts);
    },
  };
}

export const referencePipeline: EvalPipeline = makeReferencePipeline();

/** Every candidate the verifier emitted, in a stable order. */
export function emittedSignals(signals: EvalSignal[]): EvalSignal[] {
  return signals
    .filter((s) => s.status !== "REJECTED")
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : a.id < b.id ? -1 : 1));
}
