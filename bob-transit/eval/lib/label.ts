/**
 * Builds the labelled ground-truth incident set from the cached archive.
 *
 * Inputs (all offline):
 *   eval/archive/*.pdf        — cached PDFs (gitignored, produced by fetch-archive.ts)
 *   eval/archive/media-statements.json — the committed manifest
 *   data/gtfs-static/...      — committed GTFS fixture, read-only
 *   eval/overrides.json       — committed hand-review corrections
 *
 * Output (committed):
 *   data/incidents/labelled.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { IssueType, Severity } from "@/lib/contracts";
import { extractAll, EVAL_DIR, ARCHIVE_DIR, type ExtractedDoc } from "./extract";
import { parseStatement, type DocKind, type ParsedStatement } from "./parse";
import { stationIndex } from "./stations";
import { shortHash } from "./text";

export interface ManifestEntry {
  timestamp: string;
  original: string;
  wayback: string;
  filename: string;
  looks_like_media_statement: boolean;
}

/** One hand-reviewed correction to the rule-based parse. */
export interface Override {
  filename: string;
  /** Restated classification, when the rules got it wrong. */
  kind?: DocKind;
  issueType?: IssueType;
  severity?: Severity;
  lineIds?: string[];
  note: string;
}

export interface LabelledIncident {
  id: string;
  filename: string;
  /** Stable sha256-derived id, so ids survive re-ordering. */
  contentId: string;
  kind: DocKind;
  kindReason: string;
  /** True only for `kind === "INCIDENT"`. The positive class. */
  isIncident: boolean;
  headline: string;
  lineIds: string[];
  stationIds: string[];
  stationNames: string[];
  issueType: IssueType;
  severity: Severity;
  publishedAt: string;
  publishedAtSource: "pdf_creation_date";
  bodyDateline: string | null;
  onsetAt: string;
  onsetBasis: ParsedStatement["onset"]["basis"];
  onsetEvidence: string;
  /** Round-trip time from onset to publication, in minutes. */
  operatorLatencyMinutes: number | null;
  originalUrl: string;
  waybackUrl: string;
  archiveTimestamp: string;
  textLength: number;
  /** Present when a human overrode the rule-based parse. */
  overrideNote?: string;
}

export interface LabelledCorpus {
  version: string;
  generatedAt: string;
  sourceManifest: string;
  method: string;
  counts: {
    documents: number;
    incidents: number;
    plannedServiceChanges: number;
    nonIncidents: number;
    unreadable: number;
    overridden: number;
    withExplicitOnset: number;
    withDateOnlyOnset: number;
    withDatelineOnlyOnset: number;
    datelineDisagrees: number;
  };
  incidents: LabelledIncident[];
  /** Non-incidents are kept too — the pipeline must not flag them. */
  others: LabelledIncident[];
}

export const OVERRIDES_FILE = path.join(EVAL_DIR, "overrides.json");
export const RAW_TEXT_FILE = path.join(EVAL_DIR, "out/raw-text.json");
export const LABELLED_FILE = path.resolve(EVAL_DIR, "../data/incidents/labelled.json");

export async function loadOverrides(file = OVERRIDES_FILE): Promise<Override[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { overrides: Override[] };
    return parsed.overrides ?? [];
  } catch {
    return [];
  }
}

export async function loadRawText(file = RAW_TEXT_FILE): Promise<Record<string, ExtractedDoc>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, ExtractedDoc>;
  } catch {
    return {};
  }
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round(((Date.parse(toIso) - Date.parse(fromIso)) / 60000) * 1000) / 1000;
}

export function toLabelled(
  parsed: ParsedStatement,
  entry: ManifestEntry | undefined,
  override: Override | undefined,
): LabelledIncident {
  const kind = override?.kind ?? parsed.kind;
  const issueType = override?.issueType ?? parsed.issueType;
  const severity = override?.severity ?? parsed.severity;
  const lineIds = override?.lineIds ?? parsed.lineIds;
  const latency =
    parsed.onset.basis === "explicit_time" || parsed.onset.basis === "date_only"
      ? minutesBetween(parsed.onset.at, parsed.publishedAt)
      : null;

  return {
    id: parsed.filename.replace(/\.pdf$/i, ""),
    filename: parsed.filename,
    contentId: shortHash(`${parsed.filename}\u0000${parsed.headline}`),
    kind,
    kindReason: override ? `override: ${override.note}` : parsed.kindReason,
    isIncident: kind === "INCIDENT",
    headline: parsed.headline,
    lineIds,
    stationIds: parsed.stationIds,
    stationNames: parsed.stations.map((s) => s.name),
    issueType,
    severity,
    publishedAt: parsed.publishedAt,
    publishedAtSource: "pdf_creation_date",
    bodyDateline: parsed.bodyDateline,
    onsetAt: parsed.onset.at,
    onsetBasis: parsed.onset.basis,
    onsetEvidence: parsed.onset.evidence,
    operatorLatencyMinutes: latency,
    originalUrl: entry?.original ?? "",
    waybackUrl: entry?.wayback ?? "",
    archiveTimestamp: entry?.timestamp ?? "",
    textLength: parsed.textLength,
    ...(override ? { overrideNote: override.note } : {}),
  };
}

export interface BuildOptions {
  /** Re-extract every PDF instead of using `eval/out/raw-text.json`. */
  reextract?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export async function buildLabelledCorpus(
  options: BuildOptions = {},
): Promise<LabelledCorpus> {
  const manifest = JSON.parse(
    await readFile(path.join(ARCHIVE_DIR, "media-statements.json"), "utf8"),
  ) as { entries: ManifestEntry[] };

  const raw = options.reextract
    ? await extractAll({ outFile: RAW_TEXT_FILE, onProgress: options.onProgress })
    : await loadRawText();
  if (Object.keys(raw).length === 0) {
    throw new Error(
      `no extracted text at ${RAW_TEXT_FILE} — run \`./node_modules/.bin/tsx eval/build-labels.ts --reextract\` first`,
    );
  }

  const index = stationIndex();
  const overrides = await loadOverrides();
  const overrideByFile = new Map(overrides.map((o) => [o.filename, o]));

  // Manifest order is the archive's own order; iterate it so ids are stable.
  const filenames = manifest.entries
    .map((e) => e.filename)
    .filter((f, i, a) => a.indexOf(f) === i);

  const parsed: ParsedStatement[] = [];
  for (const name of filenames) {
    const doc = raw[name];
    if (!doc) continue;
    parsed.push(parseStatement(doc, index));
  }
  // Any cached PDF not in the manifest (should not happen) still gets labelled.
  for (const name of Object.keys(raw).sort()) {
    if (parsed.some((p) => p.filename === name)) continue;
    parsed.push(parseStatement(raw[name]!, index));
  }

  const entryByFile = new Map<string, ManifestEntry>();
  for (const e of manifest.entries) {
    // Later manifest entries with the same basename are the `__dupN__` copies;
    // key on the basename first-wins so the primary copy keeps the plain name.
    if (!entryByFile.has(e.filename)) entryByFile.set(e.filename, e);
  }
  const entryByOriginal = new Map(manifest.entries.map((e) => [e.original, e]));

  const labelled = parsed.map((p) => {
    const entry =
      entryByFile.get(p.filename) ??
      // `__dupN__` copies carry the original URL in their suffix-adjacent entry.
      [...entryByOriginal.values()].find((e) => e.original.includes(p.filename.replace(/__dup\d+__\d+/, "")));
    return toLabelled(p, entry, overrideByFile.get(p.filename));
  });

  const incidents = labelled
    .filter((l) => l.isIncident)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.id < b.id ? -1 : 1));
  const others = labelled
    .filter((l) => !l.isIncident)
    .sort((a, b) => (a.filename < b.filename ? -1 : 1));

  const count = (k: DocKind) => labelled.filter((l) => l.kind === k).length;

  return {
    version: "1.0.0",
    generatedAt: "deterministic", // deliberately not wall-clock; see docs/EVAL-METHOD.md
    sourceManifest: "eval/archive/media-statements.json",
    method:
      "Rule-based parse of pdfjs-extracted text + hand review. publishedAt = PDF CreationDate. " +
      "onsetAt = earliest onset-role clock time in the statement body, anchored to the nearest explicit date.",
    counts: {
      documents: labelled.length,
      incidents: incidents.length,
      plannedServiceChanges: count("PLANNED_SERVICE_CHANGE"),
      nonIncidents: count("NON_INCIDENT"),
      unreadable: count("UNREADABLE"),
      overridden: overrides.length,
      withExplicitOnset: incidents.filter((l) => l.onsetBasis === "explicit_time").length,
      withDateOnlyOnset: incidents.filter((l) => l.onsetBasis === "date_only").length,
      withDatelineOnlyOnset: incidents.filter((l) => l.onsetBasis === "dateline_only").length,
      datelineDisagrees: incidents.filter((l) => {
        const p = parsed.find((x) => x.filename === l.filename);
        return p?.datelineDisagrees ?? false;
      }).length,
    },
    incidents,
    others,
  };
}

export async function writeLabelledCorpus(
  corpus: LabelledCorpus,
  file = LABELLED_FILE,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(corpus, null, 1)}\n`, "utf8");
}
