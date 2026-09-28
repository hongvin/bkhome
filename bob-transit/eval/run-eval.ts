/**
 * A1 — THE HEADLINE NUMBER.
 *
 *   make eval            (== ./node_modules/.bin/tsx eval/run-eval.ts)
 *
 * Runs the signal pipeline (ingest -> verify) against the labelled myrapid.com.my
 * archive and prints precision, recall, median lead time and coverage.
 *
 * Exits non-zero when coverage < COVERAGE_GATE.
 *
 * FULLY OFFLINE. Inputs, all committed or cached locally:
 *   data/incidents/labelled.json          ground truth (committed)
 *   data/incidents/evidence-corpus.json   synthetic non-official evidence (committed)
 *   eval/archive/*.pdf                    cached PDFs (gitignored; fetch-archive.ts)
 *   data/gtfs-static/rapid-kl/stops.txt   station names (committed)
 *
 * DETERMINISTIC: no wall clock, no Math.random, no network. Two runs produce
 * byte-identical output.
 *
 * NOTE ON THE PIPELINE. S3 owns the real Ingest/Verify agents in `lib/agents/**`.
 * The eval scores a deterministic fixture-driven REFERENCE implementation behind
 * the same narrow interface (`eval/lib/pipeline.ts`), so the real agents can be
 * swapped in later without touching the metrics or this report.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLeadTimeEligible } from "./lib/corpus";
import { LABELLED_FILE, type LabelledCorpus } from "./lib/label";
import {
  collapseToEvents,
  computeLeadTime,
  matchSignals,
  type MatchResult,
} from "./lib/metrics";
import {
  emittedSignals,
  referencePipeline,
  REFERENCE_VERIFY_OPTIONS,
  type EvalEvidence,
  type EvalSignal,
} from "./lib/pipeline";
import type { EvidenceCorpus } from "./lib/corpus";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_FILE = path.resolve(HERE, "../data/incidents/evidence-corpus.json");

/** The gate named in the task: coverage below this exits non-zero. */
export const COVERAGE_GATE = 0.5;

/** Thresholds swept to show the precision/recall trade-off. */
export const THRESHOLD_SWEEP = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function num(x: number | null, digits = 1): string {
  return x === null ? "n/a" : x.toFixed(digits);
}

function rule(char = "-", width = 78): string {
  return char.repeat(width);
}

function row(label: string, value: string, note = ""): string {
  const left = `  ${label.padEnd(26)}`;
  const right = value.padStart(12);
  return note ? `${left}${right}   ${note}` : `${left}${right}`;
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

export interface EvalOutcome {
  labelled: LabelledCorpus;
  corpus: EvidenceCorpus;
  signals: EvalSignal[];
  /** Statement-level: every labelled disruption statement is one unit. */
  matches: MatchResult;
  /** Event-level: statements about the same real-world event are one unit. */
  eventMatches: MatchResult;
  lead: ReturnType<typeof computeLeadTime>;
  sweep: Array<{ threshold: number; precision: number; recall: number; emitted: number }>;
}

export async function loadInputs(
  labelledFile = LABELLED_FILE,
  corpusFile = CORPUS_FILE,
): Promise<{ labelled: LabelledCorpus; corpus: EvidenceCorpus }> {
  const labelled = JSON.parse(await readFile(labelledFile, "utf8")) as LabelledCorpus;
  const corpus = JSON.parse(await readFile(corpusFile, "utf8")) as EvidenceCorpus;
  return { labelled, corpus };
}

/** Minimal argv reader: `--flag`, `--key value`. */
export function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(a.slice(2), next);
      i++;
    } else {
      flags.add(a.slice(2));
    }
  }
  return { flags, values };
}

export function runEval(
  labelled: LabelledCorpus,
  corpus: EvidenceCorpus,
  threshold = REFERENCE_VERIFY_OPTIONS.confidenceThreshold,
): EvalOutcome {
  const evidence = corpus.evidence as unknown as EvalEvidence[];
  const signals = emittedSignals(
    referencePipeline.run(evidence, { ...REFERENCE_VERIFY_OPTIONS, confidenceThreshold: threshold }),
  );
  const matches = matchSignals(signals, labelled.incidents);
  // Event level: statements about the same real-world disruption collapse to
  // one unit, attributed to the event's first statement.
  const eventMatches = collapseToEvents(matches, signals, labelled.incidents);
  const lead = computeLeadTime(signals, labelled.incidents, matches, isLeadTimeEligible);

  const sweep = THRESHOLD_SWEEP.map((t) => {
    const s = emittedSignals(
      referencePipeline.run(evidence, { ...REFERENCE_VERIFY_OPTIONS, confidenceThreshold: t }),
    );
    const m = matchSignals(s, labelled.incidents);
    return { threshold: t, precision: m.precision, recall: m.recall, emitted: s.length };
  });

  return { labelled, corpus, signals, matches, eventMatches, lead, sweep };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Per-signal audit of the misses. `--explain` prints this; it is what a reviewer
 * needs in order to tell a pipeline limitation from a labelling mistake.
 */
export function renderExplain(outcome: EvalOutcome): string {
  const { labelled, signals, matches } = outcome;
  const byContentId = new Map(labelled.incidents.map((i) => [i.contentId, i]));
  const lines: string[] = [];

  lines.push("");
  lines.push(rule("="));
  lines.push(" EXPLAIN — false positives");
  lines.push(rule("="));
  for (const s of matches.falsePositives) {
    lines.push(
      `  ${s.firstSeenAt.slice(0, 16).replace("T", " ")}  ${s.lineIds.join("+").padEnd(10)} ` +
        `${s.issueType.padEnd(18)} conf=${s.confidence.value.toFixed(2)} authors=${s.distinctAuthors}`,
    );
    lines.push(`      evidence: ${s.evidenceIds.length} item(s), first ${s.firstSeenAt}`);
  }

  lines.push("");
  lines.push(rule("="));
  lines.push(" EXPLAIN — false negatives");
  lines.push(rule("="));
  for (const i of matches.falseNegatives) {
    const nearby = signals.filter((s) => s.lineIds.some((l) => i.lineIds.includes(l)));
    lines.push(
      `  ${i.publishedAt.slice(0, 16).replace("T", " ")}  ${i.lineIds.join("+").padEnd(10)} ` +
        `${i.issueType.padEnd(18)} ${i.severity.padEnd(7)} onset=${i.onsetBasis}`,
    );
    lines.push(`      ${i.headline.slice(0, 96)}`);
    lines.push(
      `      same-line signals emitted: ${nearby.length}` +
        (nearby.length > 0
          ? ` (${nearby.map((s) => `${s.issueType}@${s.firstSeenAt.slice(0, 16)}`).join(", ")})`
          : ""),
    );
  }

  const known = new Set(labelled.incidents.map((i) => i.contentId));
  const orphanSignals = signals.filter((s) => !matches.truePositives.some((p) => p.signalId === s.id));
  lines.push("");
  lines.push(rule("-"));
  lines.push(
    ` signals=${signals.length} matched=${matches.truePositives.length} ` +
      `orphan=${orphanSignals.length} incidents=${known.size}`,
  );
  void byContentId;
  return lines.join("\n");
}

export function renderReport(outcome: EvalOutcome): string {  const { labelled, corpus, signals, matches, eventMatches, lead, sweep } = outcome;
  const c = labelled.counts;
  const lines: string[] = [];

  lines.push(rule("="));
  lines.push(" A1 — RELIABILITY SIGNAL EVAL  (myrapid.com.my media statements)");
  lines.push(rule("="));
  lines.push("");

  lines.push("CORPUS");
  lines.push(
    row("archive statements", String(c.documents), "KENYATAAN MEDIA / SIARAN MEDIA PDFs, Wayback-archived"),
  );
  lines.push(row("labelled incidents", String(c.incidents), `${c.distinctEvents} distinct real-world events`));
  lines.push(row("planned service changes", String(c.plannedServiceChanges), "excluded from the positive class"));
  lines.push(row("non-incidents", String(c.nonIncidents), "corporate / campaign / event / policy"));
  lines.push(row("duplicate files merged", String(c.duplicates), "re-uploads and -Ver2 revisions"));
  lines.push(row("hand-review overrides", String(c.overridden), "see eval/overrides.json"));
  lines.push(
    row(
      "onset basis",
      `${c.withExplicitOnset}/${c.withDateOnlyOnset}/${c.withDatelineOnlyOnset}`,
      "explicit clock time / date only / dateline only",
    ),
  );
  lines.push("");
  lines.push("EVIDENCE CORPUS  (SYNTHETIC — a model, not a measurement)");
  lines.push(
    row(
      "non-official evidence",
      String(corpus.counts.evidence),
      `${corpus.counts.incidentsCovered} incidents + ${corpus.counts.decoys} decoy clusters`,
    ),
  );
  lines.push(row("incidents without evidence", String(corpus.counts.incidentsSkipped), "no explicit onset clock time"));
  lines.push(row("decoy evidence items", String(corpus.counts.decoyEvidence), "false-alarm chatter, no operator notice"));
  lines.push("");

  lines.push(rule("-"));
  lines.push(" PIPELINE  " + `${referencePipeline.name}@${referencePipeline.version}`.padEnd(30) +
    `confidence >= ${REFERENCE_VERIFY_OPTIONS.confidenceThreshold}, ` +
    `>= ${REFERENCE_VERIFY_OPTIONS.minDistinctAuthors} distinct authors`);
  lines.push(rule("-"));
  lines.push(row("signals emitted", String(signals.length)));
  lines.push(row("true positives", String(matches.truePositives.length)));
  lines.push(row("false positives", String(matches.falsePositives.length)));
  lines.push(row("false negatives", String(matches.falseNegatives.length)));
  lines.push("");

  lines.push(rule("="));
  lines.push(" HEADLINE NUMBERS");
  lines.push(rule("="));
  lines.push(row("PRECISION", pct(matches.precision), "TP / (TP + FP) over emitted signals"));
  lines.push(row("RECALL", pct(matches.recall), "TP / (TP + FN) over labelled incidents"));
  lines.push(
    row(
      "MEDIAN LEAD TIME",
      lead.medianLeadTimeMinutes === null ? "n/a" : `${num(lead.medianLeadTimeMinutes)} min`,
      `n=${lead.sample.length} incidents with a matched signal`,
    ),
  );
  lines.push(
    row(
      "COVERAGE",
      pct(matches.coverage),
      `${matches.coveredIncidentIds.length}/${labelled.incidents.length} incidents got a signal on the right line`,
    ),
  );
  lines.push("");
  lines.push(row("F1", num(matches.f1, 3)));
  lines.push("");
  lines.push(
    "  EVENT-LEVEL (one unit per real-world disruption; continuation statements merged)",
  );
  lines.push(row("  events", String(eventMatches.truePositives.length + eventMatches.falseNegatives.length)));
  lines.push(row("  precision", pct(eventMatches.precision)));
  lines.push(row("  recall", pct(eventMatches.recall), "TP / (TP + FN) over distinct events"));
  lines.push(row("  coverage", pct(eventMatches.coverage)));
  lines.push(row("  F1", num(eventMatches.f1, 3)));
  lines.push(
    row(
      "median operator latency",
      lead.medianOperatorLatencyMinutes === null ? "n/a" : `${num(lead.medianOperatorLatencyMinutes)} min`,
      "publication - onset, straight from the documents",
    ),
  );
  lines.push(
    row(
      "median lead, delta=0",
      lead.medianUpperBoundMinutes === null ? "n/a" : `${num(lead.medianUpperBoundMinutes)} min`,
      "ceiling if our ingest were instantaneous",
    ),
  );
  lines.push(
    row(
      "lead time range",
      lead.minLeadTimeMinutes === null
        ? "n/a"
        : `${num(lead.minLeadTimeMinutes, 0)}..${num(lead.maxLeadTimeMinutes, 0)} min`,
    ),
  );
  lines.push("");

  lines.push("THRESHOLD SWEEP  (verifier confidence floor -> precision / recall)");
  lines.push(`  ${"threshold".padEnd(11)}${"emitted".padStart(9)}${"precision".padStart(12)}${"recall".padStart(10)}`);
  for (const s of sweep) {
    const marker = s.threshold === REFERENCE_VERIFY_OPTIONS.confidenceThreshold ? "  <- reference" : "";
    lines.push(
      `  ${s.threshold.toFixed(2).padEnd(11)}${String(s.emitted).padStart(9)}` +
        `${pct(s.precision).padStart(12)}${pct(s.recall).padStart(10)}${marker}`,
    );
  }
  lines.push("");

  lines.push("LEAD-TIME SAMPLE  (every incident that entered the median)");
  lines.push(
    `  ${"published (op)".padEnd(18)}${"first seen".padEnd(18)}${"lead".padStart(8)}${"op lat".padStart(9)}  line / headline`,
  );
  for (const s of lead.sample) {
    lines.push(
      `  ${s.operatorNotifiedAt.slice(0, 16).replace("T", " ").padEnd(18)}` +
        `${s.firstSeenAt.slice(0, 16).replace("T", " ").padEnd(18)}` +
        `${num(s.leadTimeMinutes, 0).padStart(8)}${num(s.operatorLatencyMinutes, 0).padStart(9)}  ` +
        `${s.lineIds.join("+").padEnd(8)} ${s.headline.slice(0, 40)}`,
    );
  }
  lines.push("");

  lines.push("METHOD — how `firstSeenAt` and lead time are derived");
  lines.push("  * publishedAt  = the PDF CreationDate of the operator's own statement.");
  lines.push("  * onsetAt      = the earliest onset-role clock time in the statement body");
  lines.push("                   ('...berlaku pada jam 8.36 pagi'), anchored to the nearest");
  lines.push("                   explicit date, 'semalam', or the dateline.");
  lines.push("  * firstSeenAt  = onsetAt + delta, where delta is the modelled delay before the");
  lines.push("                   first public observation. delta ~ Uniform[2, 9] minutes, seeded");
  lines.push("                   by sha256(incident id). See eval/lib/corpus.ts.");
  lines.push("  * leadTime     = publishedAt - firstSeenAt, in minutes.");
  lines.push("  * The archive is the OPERATOR'S OWN notice, so there is no real non-official");
  lines.push("    evidence in it. The evidence corpus is synthetic and this number is a MODEL");
  lines.push("    OUTPUT, not a field measurement. The 'median operator latency' row above is");
  lines.push("    the assumption-free, document-derived figure and is the ceiling for lead time.");
  lines.push("");

  lines.push(rule("="));
  const pass = matches.coverage >= COVERAGE_GATE;
  lines.push(
    ` COVERAGE GATE  coverage ${pct(matches.coverage)} ` +
      `${pass ? ">=" : "<"} ${pct(COVERAGE_GATE)}  -> ${pass ? "PASS" : "FAIL"}`,
  );
  lines.push(rule("="));

  return lines.join("\n");
}

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const { labelled, corpus } = await loadInputs(
    values.get("labelled") ?? LABELLED_FILE,
    values.get("corpus") ?? CORPUS_FILE,
  );
  const outcome = runEval(labelled, corpus);
  process.stdout.write(`${renderReport(outcome)}\n`);
  if (flags.has("explain")) process.stdout.write(`${renderExplain(outcome)}\n`);

  if (flags.has("json")) {
    const { sweep, ...rest } = outcome;
    process.stdout.write(
      `${JSON.stringify(
        {
          precision: outcome.matches.precision,
          recall: outcome.matches.recall,
          coverage: outcome.matches.coverage,
          medianLeadTimeMinutes: outcome.lead.medianLeadTimeMinutes,
          medianOperatorLatencyMinutes: outcome.lead.medianOperatorLatencyMinutes,
          sweep,
          counts: labelled.counts,
          leadSampleSize: outcome.lead.sample.length,
          ...rest,
        },
        null,
        1,
      )}\n`,
    );
  }

  if (outcome.matches.coverage < COVERAGE_GATE) {
    process.stderr.write(
      `\n[run-eval] FAIL: coverage ${pct(outcome.matches.coverage)} < gate ${pct(COVERAGE_GATE)}\n`,
    );
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`[run-eval] fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
