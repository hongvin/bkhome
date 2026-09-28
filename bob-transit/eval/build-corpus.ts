/**
 * Builds the deterministic non-official evidence corpus.
 *
 * OFFLINE. Reads `data/incidents/labelled.json`, writes
 * `data/incidents/evidence-corpus.json` (both committed). No network access.
 *
 *   ./node_modules/.bin/tsx eval/build-corpus.ts
 *
 * The corpus is a MODEL of how fast a disruption becomes visible to a
 * commuter-driven ingest, not observed social data. See the header of
 * `eval/lib/corpus.ts` and `eval/METHOD.md`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { buildEvidenceCorpus } from "./lib/corpus";
import { LABELLED_FILE, type LabelledCorpus } from "./lib/label";

export const CORPUS_FILE = new URL(
  "../data/incidents/evidence-corpus.json",
  import.meta.url,
).pathname;

async function main(): Promise<void> {
  const labelled = JSON.parse(await readFile(LABELLED_FILE, "utf8")) as LabelledCorpus;
  const corpus = buildEvidenceCorpus(labelled);
  await writeFile(CORPUS_FILE, `${JSON.stringify(corpus, null, 1)}\n`, "utf8");

  process.stdout.write(
    `[build-corpus] wrote ${CORPUS_FILE}\n` +
      `[build-corpus] evidence=${corpus.counts.evidence} ` +
      `incidentsCovered=${corpus.counts.incidentsCovered} ` +
      `incidentsSkipped=${corpus.counts.incidentsSkipped} ` +
      `decoys=${corpus.counts.decoys} (${corpus.counts.decoyEvidence} items) ` +
      `repostTexts=${corpus.counts.reposts}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[build-corpus] fatal: ${String(err)}\n`);
  process.exit(1);
});
