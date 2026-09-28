/**
 * Repository implementations and the external binding seam.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installEpipeGuard, parseArgs } from "../../worker/ingest";
import {
  InMemoryVehiclePositionRepository,
  StdoutVehiclePositionRepository,
  assertRepository,
  loadExternalRepository,
} from "../../worker/repository";
import type { VehiclePositionRow } from "../../worker/types";

function row(overrides: Partial<VehiclePositionRow> = {}): VehiclePositionRow {
  return {
    contentHash: "f".repeat(64),
    vehicleId: "V1",
    tripId: "t1",
    routeId: "r1",
    lat: 3.1,
    lon: 101.6,
    bearing: 90,
    speed: 5,
    timestamp: 1790597300,
    observedAt: "2026-09-28T12:10:00.000Z",
    ...overrides,
  };
}

describe("InMemoryVehiclePositionRepository", () => {
  it("inserts rows and skips duplicates by content hash", async () => {
    const repository = new InMemoryVehiclePositionRepository();
    const first = row({ contentHash: "a".repeat(64) });
    const second = row({ contentHash: "b".repeat(64) });

    expect(await repository.insertMany([first, second])).toEqual({
      inserted: 2,
      skipped: 0,
    });
    expect(await repository.insertMany([first, second])).toEqual({
      inserted: 0,
      skipped: 2,
    });
    expect(repository.size).toBe(2);
    expect(repository.rows.map((entry) => entry.contentHash)).toEqual([
      first.contentHash,
      second.contentHash,
    ]);
  });

  it("counts in-batch duplicates as skipped, keeping the first", async () => {
    const repository = new InMemoryVehiclePositionRepository();
    const duplicate = row({ contentHash: "c".repeat(64), speed: 1 });
    const sameHash = row({ contentHash: "c".repeat(64), speed: 99 });

    expect(await repository.insertMany([duplicate, sameHash])).toEqual({
      inserted: 1,
      skipped: 1,
    });
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]?.speed).toBe(1);
  });

  it("handles an empty batch", async () => {
    const repository = new InMemoryVehiclePositionRepository();
    expect(await repository.insertMany([])).toEqual({ inserted: 0, skipped: 0 });
  });
});

describe("StdoutVehiclePositionRepository", () => {
  it("writes one NDJSON line per row", async () => {
    const lines: string[] = [];
    const repository = new StdoutVehiclePositionRepository((line) => {
      lines.push(line);
    });

    const result = await repository.insertMany([
      row({ contentHash: "d".repeat(64), vehicleId: "V1" }),
      row({ contentHash: "e".repeat(64), vehicleId: "V2" }),
    ]);

    expect(result).toEqual({ inserted: 2, skipped: 0 });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ vehicleId: "V1" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ vehicleId: "V2" });
  });

  it("writes nothing for an empty batch", async () => {
    const lines: string[] = [];
    const repository = new StdoutVehiclePositionRepository((line) => {
      lines.push(line);
    });
    expect(await repository.insertMany([])).toEqual({ inserted: 0, skipped: 0 });
    expect(lines).toHaveLength(0);
  });
});

describe("assertRepository", () => {
  it("accepts an object with insertMany and rejects everything else", () => {
    expect(() => assertRepository({ insertMany: () => undefined }, "ok")).not.toThrow();
    expect(() => assertRepository({}, "no-method")).toThrow(/insertMany/);
    expect(() => assertRepository({ insertMany: 1 }, "not-fn")).toThrow(/insertMany/);
    expect(() => assertRepository(undefined, "undefined")).toThrow(/insertMany/);
    expect(() => assertRepository("repo", "string")).toThrow(/insertMany/);
  });
});

describe("loadExternalRepository", () => {
  const externalUrl = new URL(
    "./fixtures/external-repository.mjs",
    import.meta.url,
  ).href;

  it("resolves a ready-made repository object", async () => {
    const repository = await loadExternalRepository(
      externalUrl,
      "readyMadeRepository",
    );
    expect(await repository.insertMany([row()])).toEqual({
      inserted: 1,
      skipped: 0,
    });
  });

  it("throws a descriptive error for a missing module", async () => {
    await expect(
      loadExternalRepository("./definitely-not-here.mjs", "default"),
    ).rejects.toThrow();
  });
});

describe("installEpipeGuard", () => {
  it("exits 0 on EPIPE and 1 on any other stream error", () => {
    const stream = new EventEmitter();
    const codes: number[] = [];
    installEpipeGuard(stream, (code) => codes.push(code));

    stream.emit(
      "error",
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );
    stream.emit(
      "error",
      Object.assign(new Error("write EIO"), { code: "EIO" }),
    );

    expect(codes).toEqual([0, 1]);
  });
});

describe("parseArgs integration sanity", () => {
  it("keeps --repo-module as the external kind", () => {
    const parsed = parseArgs(["--repo-module=../lib/db/index.ts"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.repository.kind).toBe("external");
    expect(parsed.options.repository.exportName).toBe("default");
  });
});
