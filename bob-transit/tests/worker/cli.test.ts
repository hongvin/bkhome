/**
 * CLI behaviour: argument parsing, exit codes, `--loop`, and the repository
 * binding seam the orchestrator will use to plug in S6's `lib/db`.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_INTERVAL_MS, main, parseArgs } from "../../worker/ingest";
import {
  assertRepository,
  createRepository,
  loadExternalRepository,
} from "../../worker/repository";
import { InMemoryVehiclePositionRepository } from "../../worker/repository";
import type { VehiclePositionRepository } from "../../worker/types";
import {
  FIXED_OBSERVED_AT,
  bytesFetch,
  collectingLogger,
  readFixture,
  recordingRepository,
} from "./helpers";

const FEED_URL = "https://example.invalid/gtfs-rt/vehicle-position";
const EXTERNAL_REPO_URL = new URL(
  "./fixtures/external-repository.mjs",
  import.meta.url,
).href;

function optionsOf(argv: string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected parse to succeed: ${parsed.message}`);
  return parsed.options;
}

describe("parseArgs", () => {
  it("defaults to a single stdout cycle on the bus feed", () => {
    const options = optionsOf([]);
    expect(options.loop).toBe(false);
    expect(options.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(options.intervalMs).toBe(30_000);
    expect(options.category).toBe("rapid-bus-kl");
    expect(options.feedUrl).toBeNull();
    expect(options.timeoutMs).toBe(15_000);
    expect(options.allowEmpty).toBe(false);
    expect(options.failFast).toBe(false);
    expect(options.repository).toEqual({ kind: "stdout" });
  });

  it("parses --loop, --category, --url, --interval, --timeout and boolean flags", () => {
    const options = optionsOf([
      "--loop",
      "--category",
      "rapid-bus-kl",
      `--url=${FEED_URL}`,
      "--interval=1000",
      "--timeout",
      "2500",
      "--allow-empty",
      "--fail-fast",
    ]);
    expect(options.loop).toBe(true);
    expect(options.category).toBe("rapid-bus-kl");
    expect(options.feedUrl).toBe(FEED_URL);
    expect(options.intervalMs).toBe(1000);
    expect(options.timeoutMs).toBe(2500);
    expect(options.allowEmpty).toBe(true);
    expect(options.failFast).toBe(true);
  });

  it("lets --once override --loop", () => {
    expect(optionsOf(["--loop", "--once"]).loop).toBe(false);
  });

  it("selects an external repository from --repo-module/--repo-export", () => {
    const options = optionsOf([
      "--repo-module=../lib/db/index.ts",
      "--repo-export=createVehiclePositionRepository",
    ]);
    expect(options.repository).toEqual({
      kind: "external",
      moduleSpecifier: "../lib/db/index.ts",
      exportName: "createVehiclePositionRepository",
    });
  });

  it("rejects unknown flags, missing values and bad numbers", () => {
    expect(parseArgs(["--nope"]).ok).toBe(false);
    expect(parseArgs(["--category"]).ok).toBe(false);
    expect(parseArgs(["--interval=0"]).ok).toBe(false);
    expect(parseArgs(["--interval=abc"]).ok).toBe(false);
    expect(parseArgs(["--timeout=-5"]).ok).toBe(false);
    expect(parseArgs(["--repo=postgres"]).ok).toBe(false);
    expect(parseArgs(["--category="]).ok).toBe(false);
    expect(parseArgs(["positional"]).ok).toBe(false);
    expect(parseArgs(["--loop=yes"]).ok).toBe(false);
  });
});

describe("main — usage and help", () => {
  it("prints usage and returns 0 for --help", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(await main(["--help"])).toBe(0);
      expect(stdout).toHaveBeenCalledWith(
        expect.stringContaining("GTFS-Realtime vehicle-position ingest worker"),
      );
    } finally {
      stdout.mockRestore();
    }
  });

  it("returns 2 for bad usage without fetching", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await main(["--bogus"])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown option"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns 1 when the repository cannot be bound", async () => {
    const { logger, entries } = collectingLogger();
    const code = await main([`--url=${FEED_URL}`, "--repo-module=./does-not-exist.mjs"], {
      logger,
      fetchImpl: bytesFetch(readFixture()),
    });

    expect(code).toBe(1);
    expect(
      entries.some((entry) => entry.event === "ingest.repository_binding_failed"),
    ).toBe(true);
  });
});

describe("main — --loop", () => {
  it("polls repeatedly and stops on abort, returning 0", async () => {
    const controller = new AbortController();
    let inserts = 0;
    const repository: VehiclePositionRepository = {
      async insertMany(rows) {
        inserts += 1;
        if (inserts === 2) controller.abort();
        return { inserted: rows.length, skipped: 0 };
      },
    };
    const { logger, entries } = collectingLogger();

    const code = await main(["--loop", "--interval=1000", `--url=${FEED_URL}`], {
      repository,
      fetchImpl: bytesFetch(readFixture()),
      logger,
      sleep: async () => {},
      signal: controller.signal,
      now: () => FIXED_OBSERVED_AT,
    });

    expect(code).toBe(0);
    expect(inserts).toBe(2);
    expect(entries.filter((entry) => entry.event === "ingest.cycle")).toHaveLength(2);
    expect(entries.some((entry) => entry.event === "ingest.loop_stopped")).toBe(true);
  });

  it("keeps looping through a failing cycle unless --fail-fast is set", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { logger } = collectingLogger();

    const code = await main(
      ["--loop", "--interval=1000", `--url=${FEED_URL}`, "--fail-fast"],
      {
        repository: recordingRepository(),
        fetchImpl: async () => {
          calls += 1;
          throw new TypeError("fetch failed");
        },
        logger,
        sleep: async () => {
          controller.abort();
        },
        signal: controller.signal,
      },
    );

    expect(code).toBe(1);
    expect(calls).toBe(1);
  });

  it("continues past failures without --fail-fast and exits 0 when aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { logger } = collectingLogger();

    const code = await main(["--loop", "--interval=1000", `--url=${FEED_URL}`], {
      repository: recordingRepository(),
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      logger,
      sleep: async () => {
        controller.abort();
      },
      signal: controller.signal,
    });

    expect(code).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("repository binding seam", () => {
  it("loads a factory export from an external module", async () => {
    const repository = await loadExternalRepository(
      EXTERNAL_REPO_URL,
      "createExternalRepository",
    );
    const result = await repository.insertMany([
      {
        contentHash: "a".repeat(64),
        vehicleId: "V1",
        tripId: null,
        routeId: null,
        lat: 3.1,
        lon: 101.6,
        bearing: null,
        speed: null,
        timestamp: 1,
        observedAt: "2026-09-28T12:10:00.000Z",
      },
    ]);
    expect(result).toEqual({ inserted: 1, skipped: 0 });
  });

  it("loads a ready-made repository object from an external module", async () => {
    const repository = await loadExternalRepository(
      EXTERNAL_REPO_URL,
      "readyMadeRepository",
    );
    expect(typeof repository.insertMany).toBe("function");
  });

  it("fails loudly when the export is missing or not a repository", async () => {
    await expect(
      loadExternalRepository(EXTERNAL_REPO_URL, "nope"),
    ).rejects.toThrow(/does not export "nope"/);
    expect(() => assertRepository({}, "fake")).toThrow(/insertMany/);
    expect(() => assertRepository(null, "fake")).toThrow(/insertMany/);
  });

  it("runs a full cycle against an external module repository via the CLI", async () => {
    const code = await main(
      [
        `--url=${FEED_URL}`,
        `--repo-module=${EXTERNAL_REPO_URL}`,
        "--repo-export=createExternalRepository",
      ],
      {
        fetchImpl: bytesFetch(readFixture()),
        logger: collectingLogger().logger,
        now: () => FIXED_OBSERVED_AT,
      },
    );
    expect(code).toBe(0);
  });

  it("builds the in-memory and stdout repositories from a spec", async () => {
    const memory = await createRepository({ kind: "memory" });
    expect(memory).toBeInstanceOf(InMemoryVehiclePositionRepository);
    const stdout = await createRepository({ kind: "stdout" });
    expect(typeof stdout.insertMany).toBe("function");
    await expect(createRepository({ kind: "external" })).rejects.toThrow(
      /--repo-module is required/,
    );
  });
});
