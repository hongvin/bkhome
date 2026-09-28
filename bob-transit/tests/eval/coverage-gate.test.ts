/**
 * The coverage gate: `make eval` MUST exit non-zero when coverage is below 50%.
 *
 * The gate is exercised by running the real CLI as a subprocess against fixture
 * inputs, so the test asserts the actual process exit code rather than a
 * reimplementation of the rule.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COVERAGE_GATE } from "@/eval/run-eval";
import type { LabelledCorpus } from "@/eval/lib/label";
import type { EvidenceCorpus } from "@/eval/lib/corpus";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = path.join(REPO, "node_modules/.bin/tsx");
const RUN_EVAL = path.join(REPO, "eval/run-eval.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runEvalCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(TSX, [RUN_EVAL, ...args], {
      cwd: REPO,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bob-eval-gate-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A tiny labelled corpus with two incidents and one distinct event. */
function tinyLabelled(): LabelledCorpus {
  const base = {
    kind: "INCIDENT" as const,
    kindReason: "fixture",
    isIncident: true,
    lineIds: ["KJ"],
    stationIds: ["KJ13"],
    stationNames: ["MASJID JAMEK"],
    issueType: "VEHICLE_BREAKDOWN" as const,
    severity: "MAJOR" as const,
    publishedAtSource: "pdf_creation_date" as const,
    bodyDateline: "2022-05-10",
    onsetAt: "2022-05-10T00:16:00.000Z",
    onsetBasis: "explicit_time" as const,
    onsetEvidence: "fixture",
    operatorLatencyMinutes: 294,
    onsetAfterPublication: false,
    originalUrl: "",
    waybackUrl: "",
    archiveTimestamp: "",
    textLength: 1000,
  };
  return {
    version: "1.0.0",
    generatedAt: "deterministic",
    sourceManifest: "fixture",
    method: "fixture",
    counts: {
      documents: 2,
      duplicates: 0,
      incidents: 2,
      plannedServiceChanges: 0,
      nonIncidents: 0,
      unreadable: 0,
      overridden: 0,
      withExplicitOnset: 2,
      withDateOnlyOnset: 0,
      withDatelineOnlyOnset: 0,
      inconsistentOnset: 0,
      distinctEvents: 2,
      datelineDisagrees: 0,
    },
    incidents: [
      {
        ...base,
        id: "inc-a",
        filename: "inc-a.pdf",
        contentId: "content-a",
        headline: "TREN TERKANDAS DI STESEN MASJID JAMEK",
        publishedAt: "2022-05-10T05:10:00.000Z",
      },
      {
        ...base,
        id: "inc-b",
        filename: "inc-b.pdf",
        contentId: "content-b",
        headline: "GANGGUAN PERKHIDMATAN DI STESEN MASJID JAMEK",
        publishedAt: "2022-05-11T05:10:00.000Z",
        onsetAt: "2022-05-11T00:16:00.000Z",
      },
    ],
    others: [],
  };
}

const emptyCorpus: EvidenceCorpus = {
  version: "1.0.0",
  method: "fixture: no evidence at all",
  assumptions: {},
  counts: {
    evidence: 0,
    incidentsCovered: 0,
    incidentsSkipped: 2,
    decoys: 0,
    decoyEvidence: 0,
    reposts: 0,
  },
  evidence: [],
};

describe("coverage gate", () => {
  it("exits non-zero when coverage is 0%", async () => {
    const labelledFile = path.join(dir, "labelled-empty.json");
    const corpusFile = path.join(dir, "corpus-empty.json");
    await writeFile(labelledFile, JSON.stringify(tinyLabelled()), "utf8");
    await writeFile(corpusFile, JSON.stringify(emptyCorpus), "utf8");

    const result = await runEvalCli(["--labelled", labelledFile, "--corpus", corpusFile]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/coverage .* < gate/i);
    expect(result.stdout).toMatch(/COVERAGE GATE .*FAIL/);
    expect(result.stdout).toMatch(/COVERAGE\s+0\.0%/);
  });

  it("names the 50% gate explicitly", () => {
    expect(COVERAGE_GATE).toBe(0.5);
  });

  it("exits zero on the committed corpus, which is above the gate", async () => {
    const result = await runEvalCli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/COVERAGE GATE .*PASS/);

    const coverage = /COVERAGE\s+([\d.]+)%/.exec(result.stdout);
    expect(coverage).not.toBeNull();
    expect(Number(coverage![1])).toBeGreaterThanOrEqual(COVERAGE_GATE * 100);
  }, 60_000);

  it("keeps the committed labelled corpus above the gate on its own counts", async () => {
    const labelled = JSON.parse(
      await readFile(path.join(REPO, "data/incidents/labelled.json"), "utf8"),
    ) as LabelledCorpus;
    expect(labelled.counts.incidents).toBeGreaterThan(0);
    expect(labelled.counts.documents).toBe(165);
  });
});
