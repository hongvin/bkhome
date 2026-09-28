/**
 * Trace printer — the evidence artefact for A3.
 *
 *   ./node_modules/.bin/tsx lib/agents/verify/trace.ts
 *   ./node_modules/.bin/tsx lib/agents/verify/trace.ts kj-official-confirmation
 *
 * Prints a signal's confidence at every hop (INGEST -> VERIFY), the factors that
 * produced it, and the rejected clusters with the reason they were rejected.
 * Nothing here touches the network or the wall clock.
 */

import type { DisruptionSignal } from "@/lib/contracts";

import { loadCorpus } from "@/lib/agents/ingest/corpus";
import { runVerifyAgent } from "./agent";

function fmt(value: number): string {
  return value.toFixed(3);
}

function printSignal(signal: DisruptionSignal): void {
  const line = "-".repeat(78);
  process.stdout.write(`${line}\n`);
  process.stdout.write(`SIGNAL ${signal.id}\n`);
  process.stdout.write(
    `  status=${signal.status} issueType=${signal.issueType} severity=${signal.severity} ` +
      `resolution=${signal.resolution}\n`,
  );
  process.stdout.write(
    `  segmentIds=[${signal.segmentIds.join(", ")}] lineIds=[${signal.lineIds.join(", ")}]` +
      (signal.unresolvedCandidates
        ? ` unresolvedCandidates=${signal.unresolvedCandidates.length}`
        : "") +
      "\n",
  );
  process.stdout.write(
    `  corroboration: official=${signal.corroboratingSources.official} ` +
      `socialDistinctAuthors=${signal.corroboratingSources.socialDistinctAuthors} ` +
      `realtime=${signal.corroboratingSources.realtimeObservations}\n`,
  );
  process.stdout.write(
    `  window=[${signal.window.startsAt} .. ${signal.window.endsAt ?? "open"}] ` +
      `firstSeen=${signal.firstSeenAt}\n`,
  );
  process.stdout.write(
    `  operatorNotifiedAt=${signal.operatorNotifiedAt ?? "null"} leadTimeMinutes=${
      signal.leadTimeMinutes ?? "null"
    }\n`,
  );
  process.stdout.write(`  wouldAHumanCheckThis=${String(signal.wouldAHumanCheckThis)}\n`);
  process.stdout.write(`  reasoning: ${signal.reasoning}\n`);
  process.stdout.write("  CONFIDENCE BY HOP:\n");
  for (const hop of signal.provenance) {
    process.stdout.write(`    ${hop.hop.padEnd(8)} confidence=${fmt(hop.confidence)}  ${hop.summary}\n`);
  }
  process.stdout.write("  VERIFY FACTORS:\n");
  for (const f of signal.confidence.factors) {
    process.stdout.write(
      `    ${f.name.padEnd(26)} weight=${String(f.weight).padEnd(8)} ` +
        `contribution=${(f.contribution >= 0 ? "+" : "") + f.contribution.toFixed(4)}  ${f.note}\n`,
    );
  }
}

function main(): void {
  const requested = process.argv.slice(2);
  const corpus = loadCorpus();
  const scenarioIds =
    requested.length > 0
      ? requested
      : [
          "kj-signal-fault-cluster",
          "kj-official-confirmation",
          "sarcasm-and-jokes",
          "stale-throwback",
          "repost-storm-one-author",
          "ambiguous-klang",
          "line-wide-kelana-jaya",
          "realtime-only-is-weak",
        ];

  for (const id of scenarioIds) {
    const scenario = corpus.scenarioById.get(id);
    if (!scenario) {
      process.stdout.write(`unknown scenario: ${id}\n`);
      continue;
    }
    const records = scenario.sourceIds.map((sid) => corpus.byId.get(sid));
    const missing = records.filter((r) => r === undefined).length;
    if (missing > 0) {
      process.stdout.write(`scenario ${id} has ${missing} missing source(s)\n`);
      continue;
    }
    const result = runVerifyAgent({
      records: records.filter((r): r is NonNullable<typeof r> => r !== undefined),
      now: scenario.now,
    });

    process.stdout.write(`\n${"=".repeat(78)}\n`);
    process.stdout.write(`SCENARIO ${scenario.id} — ${scenario.title}\n`);
    process.stdout.write(`now=${scenario.now}  records=${scenario.sourceIds.length}\n`);
    process.stdout.write(`=> ${result.signals.length} signal(s), ${result.rejected.length} rejected cluster(s)\n`);

    for (const signal of result.signals) printSignal(signal);

    for (const r of result.rejected) {
      process.stdout.write(`${"-".repeat(78)}\n`);
      process.stdout.write(`REJECTED CLUSTER ${r.clusterKey}\n`);
      process.stdout.write(`  candidateIds=[${r.candidateIds.join(", ")}]\n`);
      process.stdout.write(`  raw ingest confidence=${fmt(r.confidence)}\n`);
      process.stdout.write(`  reason: ${r.reason}\n`);
      for (const hop of r.hops) {
        process.stdout.write(`    ${hop.hop.padEnd(8)} confidence=${fmt(hop.confidence)}  ${hop.summary}\n`);
      }
    }
  }
  process.stdout.write(`${"=".repeat(78)}\n`);
}

main();
