#!/usr/bin/env tsx
/**
 * `make graph` entry point.
 *
 * Reads ONLY the committed GTFS fixture at
 * `data/gtfs-static/rapid-rail-kl/*.txt`, builds the frozen `TransitGraph`, and
 * writes `public/graph/transit-graph.json`. Zero network access.
 *
 * Usage:
 *   ./node_modules/.bin/tsx scripts/build-graph.ts
 *   GRAPH_BUILT_AT=2024-01-01T00:00:00.000Z ./node_modules/.bin/tsx scripts/build-graph.ts
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTransitGraph } from "../lib/gtfs/build";
import { validateTransitGraph, serializeTransitGraph } from "../lib/gtfs/graph-io";
import { GTFS_RAIL_FIXTURE_DIR, readGtfsFeed } from "../lib/gtfs/read-feed";

const REPO_ROOT = process.cwd();
const FIXTURE_DIR = join(REPO_ROOT, GTFS_RAIL_FIXTURE_DIR);
const OUTPUT_PATH = join(REPO_ROOT, "public/graph/transit-graph.json");

/** Sanity check from the orchestrator's verified stops-per-line counts. */
const EXPECTED_STOPS_PER_LINE: Record<string, number> = {
  KJ: 37,
  PYL: 36,
  PH: 29,
  KGL: 29,
  SA: 20,
  AG: 18,
  MR: 11,
  BRT: 7,
};

function main(): void {
  const startedAt = Date.now();
  const builtAt = process.env.GRAPH_BUILT_AT ?? new Date().toISOString();

  console.log("Transit graph build");
  console.log(`  fixture : ${FIXTURE_DIR}`);
  console.log(`  output  : ${OUTPUT_PATH}`);
  console.log("");

  const feed = readGtfsFeed(FIXTURE_DIR);
  const graph = buildTransitGraph(feed, { builtAt });

  const problems = validateTransitGraph(graph);
  if (problems.length > 0) {
    console.error("Graph validation FAILED:");
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const json = serializeTransitGraph(graph);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, json, "utf8");

  const stopsPerLine = new Map<string, number>();
  for (const station of graph.stations) {
    for (const lineId of station.lineIds) {
      stopsPerLine.set(lineId, (stopsPerLine.get(lineId) ?? 0) + 1);
    }
  }

  console.log("Lines:");
  for (const line of graph.lines) {
    const stops = stopsPerLine.get(line.id) ?? 0;
    const expected = EXPECTED_STOPS_PER_LINE[line.id];
    const flag = expected === undefined ? "?" : expected === stops ? "ok" : `EXPECTED ${expected}`;
    console.log(
      `  ${line.id.padEnd(4)} ${line.mode.padEnd(4)} ${String(stops).padStart(3)} stops  #${line.color}  ${line.longName}  [${flag}]`,
    );
  }
  console.log("");

  console.log("Summary");
  console.log(`  stations         : ${graph.stats.stationCount}`);
  console.log(`  lines            : ${graph.stats.lineCount}`);
  console.log(`  segments         : ${graph.stats.segmentCount}`);
  console.log(`  connections      : ${graph.stats.connectionCount}`);
  console.log(`  service days     : ${graph.stats.serviceDayCount} (distinct service_id expanded)`);
  console.log(`  frequency rows   : ${graph.frequencies.length}`);
  console.log(`  calendars        : ${graph.services.length}`);
  console.log(`  interchange stops: ${graph.stations.filter((s) => s.isInterchange).length}`);
  console.log(`  bytes            : ${statSync(OUTPUT_PATH).size}`);
  console.log(`  elapsed          : ${Date.now() - startedAt} ms`);
  console.log("");

  console.log(`Warnings (${graph.warnings.length}):`);
  if (graph.warnings.length === 0) console.log("  (none)");
  for (const warning of graph.warnings) console.log(`  - ${warning}`);
  console.log("");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
