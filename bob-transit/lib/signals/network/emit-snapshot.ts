/**
 * One-shot acquisition script. Reads the committed GTFS feed and writes the
 * offline network snapshot used by the demo path.
 *
 *   ./node_modules/.bin/tsx lib/signals/network/emit-snapshot.ts
 *
 * Nothing at request time touches the filesystem or the network; this script is
 * the only place the feed is read, and its output is committed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildNetworkIndex } from "./build";
import { parseRoutes, parseStopTimes, parseStops, parseTrips } from "./parse";

const GTFS_DIR = path.join(process.cwd(), "data/gtfs-static/rapid-rail-kl");
const OUT_DIR = path.join(process.cwd(), "data/corpus/network");
const OUT_FILE = path.join(OUT_DIR, "network-index.snapshot.json");
/** Fixed so the committed artefact is byte-reproducible. */
const GENERATED_AT = "2024-01-01T00:00:00.000Z";

async function main(): Promise<void> {
  const read = (f: string) => readFile(path.join(GTFS_DIR, f), "utf8");
  const [stopsTxt, routesTxt, tripsTxt, stopTimesTxt] = await Promise.all([
    read("stops.txt"),
    read("routes.txt"),
    read("trips.txt"),
    read("stop_times.txt"),
  ]);
  const index = buildNetworkIndex({
    stops: parseStops(stopsTxt),
    routes: parseRoutes(routesTxt),
    trips: parseTrips(tripsTxt),
    stopTimes: parseStopTimes(stopTimesTxt),
  });
  const snapshot = {
    generatedAt: GENERATED_AT,
    generatedFrom: "data/gtfs-static/rapid-rail-kl",
    warnings: index.warnings,
    lines: index.lines,
    stations: index.stations,
    segments: index.segments,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(snapshot, null, 1)}\n`, "utf8");
  process.stdout.write(
    `wrote ${path.relative(process.cwd(), OUT_FILE)}\n` +
      `  lines=${index.lines.length} stations=${index.stations.length} segments=${index.segments.length}\n` +
      `  warnings=${index.warnings.length}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`emit-snapshot failed: ${String(err)}\n`);
  process.exitCode = 1;
});
