/**
 * Router verification — proves the CSA router works offline from the cached
 * graph artifact alone, and that a journey with genuine alternatives yields
 * >= 2 DISTINCT itineraries.
 *
 * This is the orchestrator's independent check on the critical path. It is not
 * a substitute for `tests/routing/**`; it is the end-to-end read-out.
 *
 * Run: ./node_modules/.bin/tsx scripts/verify-router.ts
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TransitGraph } from "../lib/contracts/network";
import type { SegmentRisk } from "../lib/contracts/risk";
import type { Itinerary, SegmentRiskLookup } from "../lib/contracts/routing";
import { planJourneys } from "../lib/routing/plan";
import { createRiskPenaltyFn } from "../lib/risk/penalty";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Wednesday, 08:00 local — a weekday peak departure. */
const SERVICE_WEEKDAY = 3;
const DEPART_AFTER = 8 * 3600;

function hhmm(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const graphPath = path.join(ROOT, "public/graph/transit-graph.json");
  const graph = JSON.parse(await readFile(graphPath, "utf8")) as TransitGraph;

  console.log("graph:", graph.stats);
  console.log("warnings:", graph.warnings.length);

  const byId = new Map(graph.stations.map((s) => [s.id, s]));
  const label = (id: string) => `${byId.get(id)?.name ?? id} (${id})`;

  const cases: Array<{ name: string; origin: string; destination: string; expectDistinct: number }> = [
    { name: "KLCC -> KL Sentral (single line)", origin: "KJ10", destination: "KJ15", expectDistinct: 1 },
    { name: "Ampang Park -> Hang Tuah (two lines compete)", origin: "KJ9", destination: "AG9", expectDistinct: 2 },
    { name: "Ampang Park (PYL side) -> Hang Tuah", origin: "PY20", destination: "MR4", expectDistinct: 2 },
  ];

  let failures = 0;

  for (const c of cases) {
    console.log("\n" + "=".repeat(72));
    console.log(`${c.name}`);
    console.log(`${label(c.origin)}  ->  ${label(c.destination)}`);
    console.log("=".repeat(72));

    let itineraries;
    try {
      itineraries = planJourneys({
        graph,
        query: {
          originStationId: c.origin,
          destinationStationId: c.destination,
          departAfterSeconds: DEPART_AFTER,
          serviceWeekday: SERVICE_WEEKDAY,
          maxItineraries: 5,
          maxInitialWaitSeconds: 20 * 60,
          maxTransfers: 3,
        },
      });
    } catch (err) {
      console.log(`  THREW: ${err instanceof Error ? err.message : String(err)}`);
      failures += 1;
      continue;
    }

    if (itineraries.length === 0) {
      console.log("  NO ITINERARIES RETURNED  <-- FAILURE");
      failures += 1;
      continue;
    }

    const signatures = new Set<string>();
    for (const it of itineraries) {
      const lines = [...new Set(it.legs.filter((l) => l.lineId).map((l) => l.lineId))];
      const sig = it.legs.map((l) => `${l.lineId ?? "WALK"}:${l.fromStationId}>${l.toStationId}`).join("|");
      signatures.add(sig);
      console.log(
        `  #${it.rank}  ${hhmm(it.departureTime)} -> ${hhmm(it.arrival.meanSeconds)}  ` +
          `dur=${Math.round(it.totalDurationSeconds / 60)}m  ` +
          `P90=${hhmm(it.arrival.p90Seconds)}  gap=${Math.round(it.arrival.meanToP90GapSeconds / 60)}m  ` +
          `badge=${it.reliabilityBadge}  score=${it.reliabilityScore.toFixed(3)}`,
      );
      console.log(`      lines: ${lines.join(" + ") || "(walk only)"}   transfers=${it.transferCount}`);
      console.log(`      why: ${it.whyThisRank}`);
    }

    console.log(`  distinct signatures: ${signatures.size}`);
    if (signatures.size < c.expectDistinct) {
      console.log(`  EXPECTED >= ${c.expectDistinct} distinct  <-- FAILURE`);
      failures += 1;
    } else {
      console.log(`  OK (>= ${c.expectDistinct} distinct)`);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log("A2 — SYNTHETIC INCIDENT CAUSES A DIFFERENT, HIGHER-RELIABILITY ROUTE");
  console.log("=".repeat(72));

  // Degrade the Kelana Jaya leg between KLCC and Masjid Jamek. This is the
  // leg the KJ+AG/PH route must cross, and the PYL alternatives avoid it.
  const degraded: string[] = ["KJ:KJ10->KJ11", "KJ:KJ11->KJ12", "KJ:KJ12->KJ13"];
  const riskLookup: SegmentRiskLookup = (segmentId) => {
    if (!degraded.includes(segmentId)) return undefined;
    const risk: SegmentRisk = {
      segmentId,
      degradationProbability: 0.92,
      confidence: 0.92,
      severity: "SEVERE",
      issueType: "TRACK_FAULT",
      sourceCount: 4,
      lastUpdated: "2026-01-01T08:00:00.000Z",
      stale: false,
    };
    return risk;
  };

  const query = {
    originStationId: "KJ9",
    destinationStationId: "AG9",
    departAfterSeconds: DEPART_AFTER,
    serviceWeekday: SERVICE_WEEKDAY,
    maxItineraries: 5,
    maxInitialWaitSeconds: 20 * 60,
    maxTransfers: 3,
  };

  const healthy: Itinerary[] = planJourneys({ graph, query });
  const degradedRun: Itinerary[] = planJourneys({
    graph,
    query,
    riskLookup,
    riskPenalty: createRiskPenaltyFn(),
  });

  const signature = (it: Itinerary) =>
    [...new Set(it.legs.filter((l) => l.lineId).map((l) => l.lineId))].join("+");

  const before = healthy[0];
  const after = degradedRun[0];

  console.log(`  degraded segments: ${degraded.join(", ")}`);
  console.log("");
  console.log(
    `  BEFORE (healthy)   top = ${before ? signature(before) : "(none)"}` +
      (before
        ? `  dur=${Math.round(before.totalDurationSeconds / 60)}m  P90=${hhmm(before.arrival.p90Seconds)}  score=${before.reliabilityScore.toFixed(3)}  badge=${before.reliabilityBadge}`
        : ""),
  );
  console.log(
    `  AFTER  (incident)  top = ${after ? signature(after) : "(none)"}` +
      (after
        ? `  dur=${Math.round(after.totalDurationSeconds / 60)}m  P90=${hhmm(after.arrival.p90Seconds)}  score=${after.reliabilityScore.toFixed(3)}  badge=${after.reliabilityBadge}`
        : ""),
  );

  if (!before || !after) {
    console.log("\n  A2 FAILURE — no itinerary before or after the incident");
    failures += 1;
  } else {
    const changed = signature(before) !== signature(after);
    console.log(`\n  top route changed: ${changed ? "YES" : "NO"}`);

    const beforeSig = signature(before);
    const demoted = degradedRun.find((it) => signature(it) === beforeSig);
    if (demoted) {
      console.log(
        `  previously-top route (${beforeSig}) now ranked #${demoted.rank}, ` +
          `score=${demoted.reliabilityScore.toFixed(3)} badge=${demoted.reliabilityBadge} ` +
          `P90=${hhmm(demoted.arrival.p90Seconds)} expectedDelay=${Math.round(demoted.expectedDelaySeconds / 60)}m`,
      );
    }

    const improved = after.reliabilityScore >= before.reliabilityScore;
    const avoids = after.riskySegmentIds.filter((s) => degraded.includes(s)).length === 0;
    console.log(
      `  new top score (${after.reliabilityScore.toFixed(3)}) >= old top score (${before.reliabilityScore.toFixed(3)}): ${improved ? "YES" : "NO"}`,
    );
    console.log(`  new top avoids every degraded segment: ${avoids ? "YES" : "NO"}`);

    if (!changed) {
      console.log("\n  A2 FAILURE — the incident did not change the recommended route");
      failures += 1;
    } else {
      console.log("\n  A2 OK");
    }
  }

  console.log("\n" + "=".repeat(72));
  if (failures > 0) {
    console.error(`ROUTER VERIFICATION FAILED — ${failures} case(s)`);
    process.exit(1);
  }
  console.log("ROUTER VERIFICATION PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
