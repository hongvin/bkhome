/**
 * Ingest agent entry point.
 *
 * Takes heterogeneous captured records and returns the common candidate shape
 * the Verifier consumes. It performs NO scoring decisions beyond recording the
 * evidence volume: whether that volume means anything is the Verifier's job.
 */

import type { IngestCandidate, RawSourceRecord } from "@/lib/signals/types";

import { ingestBatch } from "./normalize";

export interface IngestAgentInput {
  records: RawSourceRecord[];
  /** Reference instant, ISO-8601. Required — the agent never reads the clock. */
  now: string;
  /** Overrides each record's `retrievedAt` as the moment we first saw it. */
  firstSeenAt?: string;
}

export interface IngestAgentResult {
  candidates: IngestCandidate[];
  /** How many records carried each source class, for the provenance hop. */
  countsByClass: Record<string, number>;
  languages: Record<string, number>;
}

export function runIngestAgent(input: IngestAgentInput): IngestAgentResult {
  const candidates = ingestBatch(input.records, {
    now: input.now,
    ...(input.firstSeenAt !== undefined ? { firstSeenAt: input.firstSeenAt } : {}),
  });
  const countsByClass: Record<string, number> = {};
  const languages: Record<string, number> = {};
  for (const c of candidates) {
    countsByClass[c.sourceClass] = (countsByClass[c.sourceClass] ?? 0) + 1;
    languages[c.language] = (languages[c.language] ?? 0) + 1;
  }
  return { candidates, countsByClass, languages };
}

export * from "./normalize";
export * from "./language";
export * from "./malay-phrases";
export * from "./social-authenticity";
export * from "./corpus";
