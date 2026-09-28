/**
 * A3 — replay a historical disruption end-to-end:
 *   ingest -> verify -> impact -> advisory, with a confidence value at each hop.
 *
 * Uses the committed corpus scenarios in `data/corpus/scenarios.json`, so the
 * whole run is offline, deterministic and pinned to the scenario's own `now`.
 *
 * Run:  ./node_modules/.bin/tsx scripts/replay-incident.ts [scenarioId]
 * Default scenario: kj-official-confirmation
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TransitGraph } from "../lib/contracts/network";
import type { SegmentRisk } from "../lib/contracts/risk";
import type { DisruptionSignal, SignalProvenanceHop } from "../lib/contracts/signal";
import type { Itinerary, SegmentRiskLookup } from "../lib/contracts/routing";
import { planJourneys } from "../lib/routing/plan";
import { createRiskPenaltyFn } from "../lib/risk/penalty";
import { runImpactAgent } from "../lib/agents/impact";
import { signalsForScenario } from "../lib/agents/verify/agent";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const DEFAULT_SCENARIO = "kj-official-confirmation";

/** The journey the scenario's disruption affects. */
const ORIGIN = "KJ9"; // Ampang Park (Kelana Jaya side)
const DESTINATION = "AG9"; // Hang Tuah (Ampang line side)

const DEPART_AFTER = 8 * 3600;
const SERVICE_WEEKDAY = 3;

function hhmm(seconds: number): string {
  const s = Math.round(seconds);
  return `${String(Math.floor(s / 3600) % 24).padStart(2, "0")}:${String(
    Math.floor((s % 3600) / 60),
  ).padStart(2, "0")}`;
}

function bar(value: number, width = 24): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? DEFAULT_SCENARIO;

  console.log("=".repeat(78));
  console.log(`A3 REPLAY — ${scenarioId}`);
  console.log("=".repeat(78));

  /* ---------- HOP 1+2: INGEST -> VERIFY ---------- */

  const { signals, result, scenario } = signalsForScenario(scenarioId);

  console.log(`\nSCENARIO  ${scenario.title}`);
  console.log(`  ${scenario.description}`);
  line("pinned now", scenario.now);
  line("source records", String(scenario.sourceIds.length));
  line("signals emitted", String(signals.length));
  line("claims rejected", String(result.rejected.length));

  if (signals.length === 0) {
    console.log(
      "\n  No reportable signal. Silence is a valid and correct answer for this scenario.",
    );
    if (result.rejected.length > 0) {
      console.log("\n  Rejected claims (why we did NOT report):");
      for (const r of result.rejected) {
        console.log(`    - ${r.clusterKey}: ${r.reason} (confidence ${r.confidence.toFixed(2)})`);
      }
    }
    console.log("\n" + "=".repeat(78));
    console.log("A3 REPLAY — silence path OK");
    return;
  }

  for (const signal of signals) {
    console.log("\n" + "-".repeat(78));
    console.log(`SIGNAL ${signal.id}`);
    console.log("-".repeat(78));
    line("issue type", signal.issueType);
    line("severity", signal.severity);
    line("resolution", signal.resolution);
    line("segment ids", signal.segmentIds.join(", ") || "(none — line-level)");
    line("line ids", signal.lineIds.join(", "));
    line("corroborating", JSON.stringify(signal.corroboratingSources));
    line("first seen", signal.firstSeenAt);
    line("operator notified", signal.operatorNotifiedAt ?? "(not yet)");
    line(
      "LEAD TIME",
      signal.leadTimeMinutes === null
        ? "(unconfirmed — no operator notice)"
        : `${signal.leadTimeMinutes} minutes`,
    );
    line("would a human check", String(signal.wouldAHumanCheckThis));
    console.log(`  reasoning             ${signal.reasoning}`);

    console.log("\n  CONFIDENCE BY HOP (ingest -> verify -> impact -> advisory)");
    for (const hop of signal.provenance) {
      console.log(
        `    ${hop.hop.padEnd(9)} ${bar(hop.confidence)} ${hop.confidence.toFixed(3)}  ${hop.summary}`,
      );
    }
  }

  /* ---------- HOP 3: IMPACT ---------- */

  const graph = JSON.parse(
    await readFile(path.join(ROOT, "public/graph/transit-graph.json"), "utf8"),
  ) as TransitGraph;

  // Price exactly the segments the verified signals named.
  const bySegment = new Map<string, DisruptionSignal>();
  for (const signal of signals) {
    for (const segmentId of signal.segmentIds) bySegment.set(segmentId, signal);
  }

  const riskLookup: SegmentRiskLookup = (segmentId) => {
    const signal = bySegment.get(segmentId);
    if (!signal) return undefined;
    const risk: SegmentRisk = {
      segmentId,
      degradationProbability: signal.confidence.value,
      confidence: signal.confidence.value,
      severity: signal.severity,
      issueType: signal.issueType,
      sourceCount: signal.sources.length,
      lastUpdated: signal.updatedAt,
      stale: false,
    };
    return risk;
  };

  const query = {
    originStationId: ORIGIN,
    destinationStationId: DESTINATION,
    departAfterSeconds: DEPART_AFTER,
    serviceWeekday: SERVICE_WEEKDAY,
    maxItineraries: 5,
    maxInitialWaitSeconds: 20 * 60,
    maxTransfers: 3,
  };

  const baseline: Itinerary[] = planJourneys({ graph, query });
  const priced: Itinerary[] = planJourneys({
    graph,
    query,
    riskLookup,
    riskPenalty: createRiskPenaltyFn(),
  });

  console.log("\n" + "-".repeat(78));
  console.log("HOP 3 — IMPACT: routing under the verified disruption");
  console.log("-".repeat(78));
  line("journey", `${ORIGIN} -> ${DESTINATION}`);
  line("depart", hhmm(DEPART_AFTER));

  const topBefore = baseline[0];
  const topAfter = priced[0];
  const sigOf = (it: Itinerary | undefined) =>
    it ? [...new Set(it.legs.filter((l) => l.lineId).map((l) => l.lineId))].join("+") : "(none)";

  console.log(
    `\n  BASELINE  top = ${sigOf(topBefore).padEnd(10)} ${
      topBefore ? `${Math.round(topBefore.totalDurationSeconds / 60)}m` : ""
    }`,
  );
  console.log(
    `  PRICED    top = ${sigOf(topAfter).padEnd(10)} ${
      topAfter ? `${Math.round(topAfter.totalDurationSeconds / 60)}m` : ""
    }`,
  );

  console.log("\n  Ranked itineraries under risk:");
  for (const it of priced) {
    const risky = it.riskySegmentIds.filter((s) => bySegment.has(s));
    console.log(
      `    #${it.rank} ${sigOf(it).padEnd(10)} ` +
        `dur=${String(Math.round(it.totalDurationSeconds / 60)).padStart(2)}m  ` +
        `mean=${hhmm(it.arrival.meanSeconds)}  P90=${hhmm(it.arrival.p90Seconds)}  ` +
        `gap=${String(Math.round(it.arrival.meanToP90GapSeconds / 60)).padStart(2)}m  ` +
        `${it.reliabilityBadge.padEnd(14)} score=${it.reliabilityScore.toFixed(3)}` +
        (risky.length ? `  RISK:${risky.join(",")}` : ""),
    );
  }

  /* ---------- HOP 4: ADVISORY ---------- */

  const advisory = runImpactAgent({
    originStationId: ORIGIN,
    destinationStationId: DESTINATION,
    itineraries: priced,
    riskLookup,
    signals,
    nowIso: scenario.now,
    atTime: DEPART_AFTER,
  });

  console.log("\n" + "-".repeat(78));
  console.log("HOP 4 — ADVISORY");
  console.log("-".repeat(78));
  line("advisory id", advisory.id);
  line("recommended", advisory.recommendedItineraryId ?? "(none)");
  line("no safe alternative", String(advisory.noSafeAlternative));
  line("fallback", advisory.fallback ? advisory.fallback.description : "(none needed)");
  console.log(`  why this could be wrong: ${advisory.whyThisCouldBeWrong}`);

  const recommended = advisory.itineraries.find((i) => i.id === advisory.recommendedItineraryId);
  if (recommended) {
    console.log(`  why this rank: ${recommended.whyThisRank}`);
  }

  /* ---------- Full provenance chain ---------- */

  console.log("\n" + "=".repeat(78));
  console.log("FULL PROVENANCE CHAIN — confidence at every hop");
  console.log("=".repeat(78));

  for (const signal of signals) {
    const hops: SignalProvenanceHop[] = [...signal.provenance];
    hops.push({
      hop: "IMPACT",
      at: scenario.now,
      confidence: signal.confidence.value,
      summary: `Priced ${signal.segmentIds.length} segment(s) into routing; top route is now ${sigOf(topAfter)}`,
    });
    hops.push({
      hop: "ADVISORY",
      at: scenario.now,
      confidence: recommended?.reliabilityScore ?? signal.confidence.value,
      summary: `Recommended ${sigOf(recommended ?? undefined)} at ${recommended ? hhmm(recommended.arrival.p90Seconds) : "n/a"} P90`,
    });

    console.log(`\n  ${signal.id}  (${signal.issueType}, ${signal.severity})`);
    let prev: number | null = null;
    for (const hop of hops) {
      const delta = prev === null ? "" : ` (${hop.confidence >= prev ? "+" : ""}${(hop.confidence - prev).toFixed(3)})`;
      console.log(
        `    ${hop.hop.padEnd(9)} ${bar(hop.confidence)} ${hop.confidence.toFixed(3)}${delta}`,
      );
      console.log(`              ${hop.summary}`);
      prev = hop.confidence;
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log(
    `A3 REPLAY OK — ${signals.length} signal(s) traced through ${4} hops; ` +
      `${result.rejected.length} claim(s) correctly rejected.`,
  );
}

main().catch((err) => {
  console.error("A3 replay failed:", err);
  process.exit(1);
});
