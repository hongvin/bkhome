/**
 * Determinism: the same inputs must produce byte-identical numbers, every run,
 * on every machine.
 *
 * Two independent checks:
 *   1. in-process — `runEval` twice on the committed corpus;
 *   2. out-of-process — the real CLI twice, comparing full stdout.
 *
 * A third check pins the parts of the pipeline that are easiest to make
 * non-deterministic by accident: the seeded PRNG, the evidence corpus, and the
 * ordering of emitted signals.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadInputs, runEval } from "@/eval/run-eval";
import { buildEvidenceCorpus, type EvidenceCorpus } from "@/eval/lib/corpus";
import { rng, seedFrom } from "@/eval/lib/rng";
import type { LabelledCorpus } from "@/eval/lib/label";
import { emittedSignals, referencePipeline, type EvalEvidence } from "@/eval/lib/pipeline";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const RUN_EVAL = path.join(REPO, "eval/run-eval.ts");

describe("determinism", () => {
  it("produces identical metrics for two in-process runs", async () => {
    const { labelled, corpus } = await loadInputs();
    const a = runEval(labelled, corpus);
    const b = runEval(labelled, corpus);

    expect({
      precision: a.matches.precision,
      recall: a.matches.recall,
      coverage: a.matches.coverage,
      f1: a.matches.f1,
      medianLead: a.lead.medianLeadTimeMinutes,
      medianLatency: a.lead.medianOperatorLatencyMinutes,
      emitted: a.signals.map((s) => s.id),
      tps: a.matches.truePositives,
      fps: a.matches.falsePositives.map((s) => s.id),
      fns: a.matches.falseNegatives.map((i) => i.contentId),
    }).toEqual({
      precision: b.matches.precision,
      recall: b.matches.recall,
      coverage: b.matches.coverage,
      f1: b.matches.f1,
      medianLead: b.lead.medianLeadTimeMinutes,
      medianLatency: b.lead.medianOperatorLatencyMinutes,
      emitted: b.signals.map((s) => s.id),
      tps: b.matches.truePositives,
      fps: b.matches.falsePositives.map((s) => s.id),
      fns: b.matches.falseNegatives.map((i) => i.contentId),
    });
  });

  it("emits byte-identical stdout from two CLI runs", async () => {
    const [a, b] = await Promise.all([
      run(TSX, [RUN_EVAL], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 }),
      run(TSX, [RUN_EVAL], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 }),
    ]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout.length).toBeGreaterThan(1000);
  }, 60_000);

  it("orders emitted signals deterministically", async () => {
    const { labelled, corpus } = await loadInputs();
    const evidence = corpus.evidence as unknown as EvalEvidence[];
    const once = emittedSignals(referencePipeline.run(evidence));
    const twice = emittedSignals(referencePipeline.run([...evidence].reverse()));
    expect(once.map((s) => s.id)).toEqual(twice.map((s) => s.id));
    expect(labelled.incidents.length).toBeGreaterThan(0);
  });

  it("rebuilds the same evidence corpus from the same labels", async () => {
    const labelled = JSON.parse(
      await readFile(path.join(REPO, "data/incidents/labelled.json"), "utf8"),
    ) as LabelledCorpus;
    const rebuilt = buildEvidenceCorpus(labelled);
    const committed = JSON.parse(
      await readFile(path.join(REPO, "data/incidents/evidence-corpus.json"), "utf8"),
    ) as EvidenceCorpus;

    expect(rebuilt.evidence.length).toBe(committed.evidence.length);
    expect(rebuilt.evidence.map((e) => `${e.id}:${e.publishedAt}:${e.authorId}`)).toEqual(
      committed.evidence.map((e) => `${e.id}:${e.publishedAt}:${e.authorId}`),
    );
    expect(rebuilt.counts).toEqual(committed.counts);
  });

  it("has a PRNG that is stable across calls and independent of wall clock", () => {
    const a = rng("bob-transit|determinism|fixture");
    const b = rng("bob-transit|determinism|fixture");
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
    // Different seeds must diverge.
    expect(rng("other-seed").next()).not.toBe(seqA[0]);
    expect(seedFrom("bob-transit|determinism|fixture")).toBe(
      seedFrom("bob-transit|determinism|fixture"),
    );
  });

  it("does not read the wall clock", async () => {
    const source = await readFile(path.join(REPO, "eval/run-eval.ts"), "utf8");
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toMatch(/Math\.random\(\)/);
  });
});
