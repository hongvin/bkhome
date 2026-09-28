/**
 * Malformed / truncated / empty feeds must never throw out of the worker and
 * must never produce partial writes.
 */
import { describe, expect, it } from "vitest";
import { FeedDecodeError, decodeVehiclePositions } from "../../worker/decode";
import { runIngestCycle } from "../../worker/cycle";
import { encodeFeedMessage } from "../../worker/proto";
import {
  FIXED_OBSERVED_AT,
  bytesFetch,
  collectingLogger,
  readFixture,
  recordingRepository,
} from "./helpers";

const FEED_URL = "https://example.invalid/gtfs-rt/vehicle-position";

describe("malformed protobuf", () => {
  it("throws a typed FeedDecodeError for a truncated payload", () => {
    // Cuts the first field header short: field 1, declared length 13, 3 bytes present.
    const truncated = new Uint8Array([0x0a, 0x0d, 0x0a, 0x03, 0x32]);
    expect(() =>
      decodeVehiclePositions(truncated, { observedAt: FIXED_OBSERVED_AT }),
    ).toThrow(FeedDecodeError);
  });

  it("throws a typed FeedDecodeError for random garbage", () => {
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() =>
      decodeVehiclePositions(garbage, { observedAt: FIXED_OBSERVED_AT }),
    ).toThrow(FeedDecodeError);
  });

  it("throws a typed FeedDecodeError for an empty payload", () => {
    expect(() =>
      decodeVehiclePositions(new Uint8Array(0), {
        observedAt: FIXED_OBSERVED_AT,
      }),
    ).toThrow(FeedDecodeError);
  });

  it("never throws a non-FeedDecodeError for any prefix of the real fixture", () => {
    const fixture = readFixture();
    for (const length of [1, 2, 4, 7, 13, 40, 200, 1500, fixture.length - 1]) {
      try {
        decodeVehiclePositions(fixture.slice(0, length), {
          observedAt: FIXED_OBSERVED_AT,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(FeedDecodeError);
      }
    }
  });

  it("reports a decode failure from a cycle without throwing or writing", async () => {
    const repository = recordingRepository();
    const { logger, entries } = collectingLogger();

    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      logger,
      fetchImpl: bytesFetch(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01])),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("decode");
    expect(result.rows).toBe(0);
    expect(repository.calls).toBe(0);
    expect(repository.rows).toHaveLength(0);
    expect(entries.some((entry) => entry.level === "error")).toBe(true);
  });

  it("survives a 200 response with a zero-length body", async () => {
    const repository = recordingRepository();
    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(new Uint8Array(0)),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("decode");
    expect(repository.calls).toBe(0);
  });
});

describe("empty and unusable feeds", () => {
  const emptyFeed = encodeFeedMessage({
    header: { gtfsRealtimeVersion: "2.0", timestamp: 1790597324 },
    entity: [],
  });

  it("fails the cycle when the feed has zero entities", async () => {
    const repository = recordingRepository();
    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(emptyFeed),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("empty");
    expect(result.entityCount).toBe(0);
    expect(repository.calls).toBe(0);
  });

  it("succeeds on an empty feed only when allowEmpty is set", async () => {
    const repository = recordingRepository();
    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      allowEmpty: true,
      fetchImpl: bytesFetch(emptyFeed),
    });

    expect(result.ok).toBe(true);
    expect(result.rows).toBe(0);
    expect(result.inserted).toBe(0);
    expect(repository.calls).toBe(1);
  });

  it("fails when entities exist but none are usable vehicle positions", async () => {
    // A trip-update-only feed: valid protobuf, no vehicle positions.
    const tripUpdateOnly = encodeFeedMessage({
      header: { gtfsRealtimeVersion: "2.0", timestamp: 1790597324 },
      entity: [
        {
          id: "tu-1",
          tripUpdate: {
            trip: { tripId: "t1", routeId: "r1" },
            stopTimeUpdate: [{ stopSequence: 1, arrival: { delay: 120 } }],
          },
        },
        {
          id: "deleted-1",
          isDeleted: true,
          vehicle: {
            position: { latitude: 3.1, longitude: 101.6 },
            vehicle: { id: "V9" },
          },
        },
      ],
    });

    const repository = recordingRepository();
    const result = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(tripUpdateOnly),
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("empty");
    expect(result.entityCount).toBe(2);
    expect(result.skippedEntities).toBe(2);
    expect(repository.calls).toBe(0);
  });
});
