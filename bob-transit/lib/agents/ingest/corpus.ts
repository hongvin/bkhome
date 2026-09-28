/**
 * Offline corpus loader.
 *
 * The corpus is committed JSON in `data/corpus/**` and is imported statically, so
 * the demo path performs no filesystem and no network access. It is parsed
 * defensively at this boundary — a hand-edited fixture must not be able to
 * inject a malformed record into the pipeline.
 */

import officialRealtimeJson from "@/data/corpus/official-realtime.json";
import officialStatementsJson from "@/data/corpus/official-statements.json";
import scenariosJson from "@/data/corpus/scenarios.json";
import socialPostsJson from "@/data/corpus/social-posts.json";

import type { RawSourceRecord, RealtimeObservationKind } from "@/lib/signals/types";

export interface CorpusScenario {
  id: string;
  title: string;
  description: string;
  now: string;
  sourceIds: string[];
  expect: Record<string, unknown>;
}

export interface Corpus {
  records: RawSourceRecord[];
  byId: Map<string, RawSourceRecord>;
  scenarios: CorpusScenario[];
  scenarioById: Map<string, CorpusScenario>;
  version: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const OBSERVATIONS: ReadonlySet<string> = new Set([
  "VEHICLE_STALLED",
  "VEHICLE_ABSENT",
  "PLATFORM_CROWD",
  "SERVICE_NORMAL",
]);

function readRecord(value: unknown): RawSourceRecord | null {
  const r = asRecord(value);
  const id = str(r.id);
  const text = str(r.text);
  const sourceClass = str(r.sourceClass);
  const publishedAt = str(r.publishedAt);
  const retrievedAt = str(r.retrievedAt);
  if (!id || !text || !sourceClass || !publishedAt || !retrievedAt) return null;
  if (
    sourceClass !== "OFFICIAL_STATEMENT" &&
    sourceClass !== "OFFICIAL_REALTIME" &&
    sourceClass !== "SOCIAL" &&
    sourceClass !== "INTERNAL"
  ) {
    return null;
  }

  const url = str(r.url);
  const authorId = str(r.authorId);
  const authorHandle = str(r.authorHandle);
  const title = str(r.title);
  const originalAuthorId = str(r.originalAuthorId);
  const originalAuthorHandle = str(r.originalAuthorHandle);
  const repostOfId = str(r.repostOfId);
  const observedLineId = str(r.observedLineId);
  const observedStationId = str(r.observedStationId);
  const lang = str(r.language);
  const obs = str(r.observation);

  // Fields are mapped explicitly rather than assigned through a computed key, so
  // the fixture boundary stays type-checked.
  const record: RawSourceRecord = {
    id,
    sourceClass,
    text,
    publishedAt,
    retrievedAt,
    ...(url !== undefined ? { url } : {}),
    ...(authorId !== undefined ? { authorId } : {}),
    ...(authorHandle !== undefined ? { authorHandle } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(originalAuthorId !== undefined ? { originalAuthorId } : {}),
    ...(originalAuthorHandle !== undefined ? { originalAuthorHandle } : {}),
    ...(repostOfId !== undefined ? { repostOfId } : {}),
    ...(observedLineId !== undefined ? { observedLineId } : {}),
    ...(observedStationId !== undefined ? { observedStationId } : {}),
    ...(lang === "en" || lang === "ms" || lang === "zh" || lang === "ta" || lang === "unknown"
      ? { language: lang }
      : {}),
    ...(obs !== undefined && OBSERVATIONS.has(obs) ? { observation: obs as RealtimeObservationKind } : {}),
  };
  return record;
}

function readRecords(root: unknown, key: "posts" | "statements" | "observations"): RawSourceRecord[] {
  const list = asRecord(root)[key];
  if (!Array.isArray(list)) return [];
  return list.map(readRecord).filter((x): x is RawSourceRecord => x !== null);
}

function readScenario(value: unknown): CorpusScenario | null {
  const r = asRecord(value);
  const id = str(r.id);
  const now = str(r.now);
  if (!id || !now) return null;
  return {
    id,
    title: str(r.title) ?? id,
    description: str(r.description) ?? "",
    now,
    sourceIds: Array.isArray(r.sourceIds)
      ? r.sourceIds.filter((x): x is string => typeof x === "string")
      : [],
    expect: asRecord(r.expect),
  };
}

let cached: Corpus | null = null;

/** Load and cache the whole corpus. Pure, synchronous, offline. */
export function loadCorpus(): Corpus {
  if (cached) return cached;
  const records = [
    ...readRecords(socialPostsJson, "posts"),
    ...readRecords(officialStatementsJson, "statements"),
    ...readRecords(officialRealtimeJson, "observations"),
  ];
  const scenarios = (Array.isArray(asRecord(scenariosJson).scenarios)
    ? (asRecord(scenariosJson).scenarios as unknown[])
    : []
  )
    .map(readScenario)
    .filter((x): x is CorpusScenario => x !== null);

  cached = {
    records,
    byId: new Map(records.map((r) => [r.id, r])),
    scenarios,
    scenarioById: new Map(scenarios.map((s) => [s.id, s])),
    version: str(asRecord(socialPostsJson).corpusVersion) ?? "0.0.0",
  };
  return cached;
}

export function loadScenario(id: string): CorpusScenario {
  const scenario = loadCorpus().scenarioById.get(id);
  if (!scenario) throw new Error(`unknown corpus scenario: ${id}`);
  return scenario;
}

/** The raw records belonging to a scenario, in the order the scenario lists them. */
export function scenarioRecords(id: string): RawSourceRecord[] {
  const corpus = loadCorpus();
  const scenario = loadScenario(id);
  return scenario.sourceIds.map((sourceId) => {
    const record = corpus.byId.get(sourceId);
    if (!record) throw new Error(`scenario ${id} references unknown source ${sourceId}`);
    return record;
  });
}
