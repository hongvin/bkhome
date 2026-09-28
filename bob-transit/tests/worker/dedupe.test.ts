/**
 * Dedupe is by content hash, both inside a batch and across poll cycles.
 */
import { describe, expect, it } from "vitest";
import { computeContentHash, decodeVehiclePositions } from "../../worker/decode";
import { runIngestCycle } from "../../worker/cycle";
import { encodeFeedMessage } from "../../worker/proto";
import { InMemoryVehiclePositionRepository } from "../../worker/repository";
import {
  FIXED_OBSERVED_AT,
  bytesFetch,
  readFixture,
  recordingRepository,
} from "./helpers";

const FEED_URL = "https://example.invalid/gtfs-rt/vehicle-position";

const vehicleEntity = (overrides: {
  id: string;
  vehicleId: string;
  lat: number;
  lon: number;
  timestamp: number;
}): Record<string, unknown> => ({
  id: overrides.id,
  vehicle: {
    trip: { tripId: "t1", routeId: "r1" },
    position: { latitude: overrides.lat, longitude: overrides.lon },
    vehicle: { id: overrides.vehicleId },
    timestamp: overrides.timestamp,
  },
});

describe("content hash", () => {
  it("is stable for identical fields and differs when any field changes", () => {
    const base = {
      vehicleId: "V1",
      tripId: "t1",
      routeId: "r1",
      lat: 3.1,
      lon: 101.6,
      bearing: 90,
      speed: 5,
      timestamp: 1790597300,
    };

    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
    expect(computeContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentHash({ ...base, timestamp: 1790597301 })).not.toBe(
      computeContentHash(base),
    );
    expect(computeContentHash({ ...base, lat: 3.2 })).not.toBe(
      computeContentHash(base),
    );
    expect(computeContentHash({ ...base, vehicleId: "V2" })).not.toBe(
      computeContentHash(base),
    );
    expect(computeContentHash({ ...base, bearing: null })).not.toBe(
      computeContentHash(base),
    );
    expect(computeContentHash({ ...base, speed: null })).not.toBe(
      computeContentHash(base),
    );
  });

  it("collapses sub-decimetre float noise into the same hash", () => {
    const base = {
      vehicleId: "V1",
      tripId: null,
      routeId: null,
      lat: 3.103300094604492,
      lon: 101.6778335571289,
      bearing: null,
      speed: null,
      timestamp: 1790597307,
    };
    expect(computeContentHash({ ...base, lat: 3.1033001 })).toBe(
      computeContentHash(base),
    );
  });
});

describe("in-batch dedupe", () => {
  it("keeps one row when the feed repeats an identical entity", () => {
    const duplicate = vehicleEntity({
      id: "e1",
      vehicleId: "V1",
      lat: 3.1,
      lon: 101.6,
      timestamp: 1790597300,
    });
    const bytes = encodeFeedMessage({
      header: { gtfsRealtimeVersion: "2.0", timestamp: 1790597324 },
      entity: [duplicate, { ...duplicate, id: "e2" }],
    });

    const decoded = decodeVehiclePositions(bytes, {
      observedAt: FIXED_OBSERVED_AT,
    });
    expect(decoded.entityCount).toBe(2);
    expect(decoded.rows).toHaveLength(1);
    expect(decoded.duplicateEntities).toBe(1);
  });

  it("keeps both rows when the same vehicle has a new timestamp", () => {
    const bytes = encodeFeedMessage({
      header: { gtfsRealtimeVersion: "2.0", timestamp: 1790597324 },
      entity: [
        vehicleEntity({
          id: "e1",
          vehicleId: "V1",
          lat: 3.1,
          lon: 101.6,
          timestamp: 1790597300,
        }),
        vehicleEntity({
          id: "e2",
          vehicleId: "V1",
          lat: 3.1,
          lon: 101.6,
          timestamp: 1790597301,
        }),
      ],
    });

    const decoded = decodeVehiclePositions(bytes, {
      observedAt: FIXED_OBSERVED_AT,
    });
    expect(decoded.rows).toHaveLength(2);
    expect(decoded.duplicateEntities).toBe(0);
  });
});

describe("cross-cycle dedupe through the repository", () => {
  it("inserts the fixture once and skips it on the next identical poll", async () => {
    const repository = new InMemoryVehiclePositionRepository();
    const fixture = readFixture();

    const first = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(fixture),
    });
    expect(first.ok).toBe(true);
    expect(first.inserted).toBe(100);
    expect(first.skipped).toBe(0);

    const second = await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(fixture),
    });
    expect(second.ok).toBe(true);
    expect(second.rows).toBe(100);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(100);

    expect(repository.size).toBe(100);
  });

  it("still writes a new observation when the vehicle has moved", async () => {
    const repository = new InMemoryVehiclePositionRepository();
    const base = vehicleEntity({
      id: "e1",
      vehicleId: "V1",
      lat: 3.1,
      lon: 101.6,
      timestamp: 1790597300,
    });
    const moved = vehicleEntity({
      id: "e1",
      vehicleId: "V1",
      lat: 3.2,
      lon: 101.7,
      timestamp: 1790597330,
    });

    await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(
        encodeFeedMessage({
          header: { gtfsRealtimeVersion: "2.0", timestamp: 1790597324 },
          entity: [base],
        }),
      ),
    });
    await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(
        encodeFeedMessage({
          header: { gtfsRealtimeVersion: "2.0", timestamp: 1790597324 },
          entity: [moved],
        }),
      ),
    });

    expect(repository.size).toBe(2);
    expect(repository.rows[0]?.lat).toBeCloseTo(3.1, 6);
    expect(repository.rows[1]?.lat).toBeCloseTo(3.2, 6);
  });

  it("hands the whole batch to the repository in one call", async () => {
    const repository = recordingRepository();
    await runIngestCycle({
      repository,
      feedUrl: FEED_URL,
      observedAt: FIXED_OBSERVED_AT,
      fetchImpl: bytesFetch(readFixture()),
    });
    expect(repository.calls).toBe(1);
    expect(repository.batches[0]).toHaveLength(100);
  });
});
