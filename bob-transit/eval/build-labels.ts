/**
 * OFFLINE. Regenerates `data/incidents/labelled.json` from the cached archive.
 *
 *   ./node_modules/.bin/tsx eval/build-labels.ts             # use cached text
 *   ./node_modules/.bin/tsx eval/build-labels.ts --reextract # re-read every PDF
 *   ./node_modules/.bin/tsx eval/build-labels.ts --review    # print the audit table
 *
 * Never touches the network. Requires `eval/archive/*.pdf` (see fetch-archive.ts).
 */

import { buildLabelledCorpus, writeLabelledCorpus, LABELLED_FILE } from "./lib/label";
import { clip } from "./lib/text";

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  const reextract = argv.has("--reextract");
  const review = argv.has("--review");

  const corpus = await buildLabelledCorpus({
    reextract,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) {
        process.stderr.write(`[build-labels] extracted ${done}/${total}\n`);
      }
    },
  });

  await writeLabelledCorpus(corpus);
  process.stdout.write(
    `[build-labels] wrote ${LABELLED_FILE} — ${corpus.counts.documents} documents, ` +
      `${corpus.counts.incidents} incidents, ${corpus.counts.plannedServiceChanges} planned, ` +
      `${corpus.counts.nonIncidents} non-incident, ${corpus.counts.unreadable} unreadable\n`,
  );

  if (review) {
    process.stdout.write("\n=== INCIDENTS (rule-based) ===\n");
    for (const i of corpus.incidents) {
      process.stdout.write(
        `${i.publishedAt.slice(0, 16)}  ${(i.lineIds.join("+") || "-").padEnd(8)} ` +
          `${i.issueType.padEnd(18)} ${i.severity.padEnd(7)} ${i.onsetBasis.padEnd(14)} ` +
          `${(i.operatorLatencyMinutes ?? -1).toString().padStart(7)}m  ${clip(i.headline, 95)}\n`,
      );
    }
    process.stdout.write("\n=== OTHERS ===\n");
    for (const o of corpus.others) {
      process.stdout.write(
        `${o.kind.padEnd(24)} ${(o.lineIds.join("+") || "-").padEnd(8)} ${clip(o.headline, 100)}\n`,
      );
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[build-labels] fatal: ${String(err)}\n`);
  process.exit(1);
});
