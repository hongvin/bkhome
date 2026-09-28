#!/usr/bin/env node
/**
 * ONE-SHOT NETWORK ACQUISITION SCRIPT — the only worker file allowed to fetch
 * the live feed for the purpose of producing a committed fixture.
 *
 * It is never imported by `ingest.ts`, by any test, or by the demo request
 * path. Run it by hand when the fixture needs refreshing:
 *
 *   ./node_modules/.bin/tsx worker/scripts/capture-fixture.ts
 *   ./node_modules/.bin/tsx worker/scripts/capture-fixture.ts --category=rapid-bus-kl
 *
 * Output: `worker/fixtures/vehicle-position-prasarana-<category>.pb` plus a
 * decoded round-trip summary and the sha256 of the captured bytes.
 *
 * WARNING: overwriting a committed fixture invalidates the pinned expectations
 * in `tests/worker/helpers.ts` (FIXTURE_SHA256, FIXTURE_ENTITY_COUNT) and the
 * exact-value assertions in `tests/worker/decode.test.ts`. Update those in the
 * same change. Use `--out=<path>` to write somewhere else.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFeedBytes } from "../client";
import { decodeVehiclePositions } from "../decode";
import { buildFeedUrl, DEFAULT_CATEGORY, DEFAULT_TIMEOUT_MS } from "../cycle";

const FIXTURE_DIR = new URL("../fixtures/", import.meta.url);

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

async function capture(): Promise<number> {
  const category = argValue("category") ?? DEFAULT_CATEGORY;
  const url = argValue("url") ?? buildFeedUrl(category);

  process.stderr.write(`capturing ${url}\n`);
  const { bytes, finalUrl, contentType } = await fetchFeedBytes({
    url,
    timeoutMs: Number(argValue("timeout") ?? DEFAULT_TIMEOUT_MS),
  });

  // Decode before writing: never commit a fixture the worker cannot read.
  const decoded = decodeVehiclePositions(bytes, {
    observedAt: new Date(),
  });

  const defaultTarget = new URL(
    `vehicle-position-prasarana-${category}.pb`,
    FIXTURE_DIR,
  );
  const outArg = argValue("out");
  const target = outArg ? resolve(process.cwd(), outArg) : fileURLToPath(defaultTarget);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);

  process.stdout.write(
    `${JSON.stringify(
      {
        url,
        finalUrl,
        contentType,
        fixture: target,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        gtfsRealtimeVersion: decoded.gtfsRealtimeVersion,
        feedTimestamp: decoded.feedTimestamp,
        entityCount: decoded.entityCount,
        usableRows: decoded.rows.length,
        skippedEntities: decoded.skippedEntities,
        duplicateEntities: decoded.duplicateEntities,
        sample: decoded.rows.slice(0, 2),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

capture()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `capture failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
