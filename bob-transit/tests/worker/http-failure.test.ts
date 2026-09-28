/**
 * HTTP and transport failures: the cycle must fail, write nothing, and the CLI
 * must exit non-zero without an unhandled rejection.
 */
import { describe, expect, it } from "vitest";
import { runIngestCycle } from "../../worker/cycle";
import { main } from "../../worker/ingest";
import {
  FIXED_OBSERVED_AT,
  collectingLogger,
  hangingFetch,
  readFixture,
  recordingRepository,
  statusFetch,
  bytesFetch,
} from "./helpers";

const FEED_URL = "https://example.invalid/gtfs-rt/vehicle-position";

describe("HTTP failures", () => {
  for (const status of [400, 403, 404, 429, 500, 502, 503]) {
    it(`fails the cycle on HTTP ${status} and writes nothing`, async () => {
      const repository = recordingRepository();
      const { logger, entries } = collectingLogger();

      const result = await runIngestCycle({
        repository,
        feedUrl: FEED_URL,
        observedAt: FIXED_OBSERVED_AT,
        logger,
        fetchImpl: statusFetch(status),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("http");
      expect(result.error?.status).toBe(status);
      expect(result.rows).toBe(0);
      expect(result.inserted).toBe(0);
      expect(repository.calls).toBe(0);
      expect(repository.rows).toHaveLength(0);
      expect(entries.filter((entry) => entry.level === "error")).toHaveLength(1);
    });
  }

  it("maps a transport error to kind network", async () => {
    const repository = recordingRepository();
    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("network");
    expect(result.error?.message).toContain("fetch failed");
    expect(repository.calls).toBe(0);
  });

  it("aborts a hanging request and reports a timeout", async () => {
    const repository = recordingRepository();
    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      timeoutMs: 25,
      fetchImpl: hangingFetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("timeout");
    expect(repository.calls).toBe(0);
  });

  it("maps a repository write failure to kind repository", async () => {
    const result = await runIngestCycle({
      repository: {
        insertMany: async () => {
          throw new Error("connection terminated unexpectedly");
        },
      },
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(readFixture()),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("repository");
    expect(result.rows).toBe(100);
    expect(result.inserted).toBe(0);
  });
});

describe("CLI exit codes", () => {
  it("returns 1 on HTTP 500 and performs no writes", async () => {
    const repository = recordingRepository();
    const code = await main([`--url=${FEED_URL}`, "--repo=memory"], {
      repository,
      fetchImpl: statusFetch(500),
      logger: collectingLogger().logger,
    });

    expect(code).toBe(1);
    expect(repository.calls).toBe(0);
  });

  it("returns 1 on a network error", async () => {
    const repository = recordingRepository();
    const code = await main([`--url=${FEED_URL}`], {
      repository,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      logger: collectingLogger().logger,
    });

    expect(code).toBe(1);
    expect(repository.calls).toBe(0);
  });

  it("returns 1 on a decode error", async () => {
    const repository = recordingRepository();
    const code = await main([`--url=${FEED_URL}`], {
      repository,
      fetchImpl: bytesFetch(new Uint8Array([0x01, 0x02, 0x03])),
      logger: collectingLogger().logger,
    });

    expect(code).toBe(1);
    expect(repository.calls).toBe(0);
  });

  it("returns 1 when the request times out", async () => {
    const repository = recordingRepository();
    const code = await main([`--url=${FEED_URL}`, "--timeout=25"], {
      repository,
      fetchImpl: hangingFetch,
      logger: collectingLogger().logger,
    });

    expect(code).toBe(1);
    expect(repository.calls).toBe(0);
  });

  it("returns 0 on a healthy feed and writes the batch exactly once", async () => {
    const repository = recordingRepository();
    const code = await main([`--url=${FEED_URL}`], {
      repository,
      fetchImpl: bytesFetch(readFixture()),
      logger: collectingLogger().logger,
      now: () => FIXED_OBSERVED_AT,
    });

    expect(code).toBe(0);
    expect(repository.calls).toBe(1);
    expect(repository.rows).toHaveLength(100);
    expect(repository.rows[0]?.observedAt).toBe("2026-09-28T12:10:00.000Z");
  });
});
