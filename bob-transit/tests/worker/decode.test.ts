/**
 * Offline decode test: the committed real GTFS-Realtime fixture must decode to
 * the exact expected normalized rows, with the network hard-disabled.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FeedDecodeError,
  computeContentHash,
  decodeVehiclePositions,
  type DecodeResult,
} from "../../worker/decode";
import {
  FIXED_OBSERVED_AT,
  FIXTURE_ENTITY_COUNT,
  FIXTURE_SHA256,
  readFixture,
} from "./helpers";

describe("decodeVehiclePositions — committed real feed fixture", () => {
  // Hard-disable the network for this whole file: if the decode path ever
  // reached for `fetch`, these tests would fail rather than silently pass.
  const fetchSpy = vi.fn(() => {
    throw new Error("network access is forbidden in the decode path");
  });

  let fixture: Uint8Array;
  let decoded: DecodeResult;

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchSpy);
    // Decode happens AFTER the network is disabled, so a hidden network
    // dependency would surface here.
    fixture = readFixture();
    decoded = decodeVehiclePositions(fixture, {
      observedAt: FIXED_OBSERVED_AT,
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("decodes the fixture header", () => {
    expect(decoded.gtfsRealtimeVersion).toBe("2.0");
    expect(decoded.incrementality).toBe("FULL_DATASET");
    expect(decoded.feedTimestamp).toBe(1790597324);
  });

  it("decodes every entity in the fixture into a usable row", () => {
    expect(decoded.entityCount).toBe(FIXTURE_ENTITY_COUNT);
    expect(decoded.rows).toHaveLength(FIXTURE_ENTITY_COUNT);
    expect(decoded.skippedEntities).toBe(0);
    expect(decoded.duplicateEntities).toBe(0);
  });

  it("normalizes the first vehicle exactly", () => {
    const first = decoded.rows[0];
    expect(first).toBeDefined();
    expect(first?.vehicleId).toBe("WB946L");
    expect(first?.tripId).toBe("weekday_U6520_U652002_2");
    expect(first?.routeId).toBe("U6520");
    expect(first?.lat).toBeCloseTo(3.103300094604492, 12);
    expect(first?.lon).toBeCloseTo(101.6778335571289, 12);
    expect(first?.bearing).toBeCloseTo(197, 9);
    expect(first?.speed).toBeCloseTo(7.409999847412109, 9);
    expect(first?.timestamp).toBe(1790597307);
    expect(first?.observedAt).toBe("2026-09-28T12:10:00.000Z");
  });

  it("normalizes the second vehicle exactly", () => {
    const second = decoded.rows[1];
    expect(second?.vehicleId).toBe("WUW1664");
    expect(second?.tripId).toBe("weekday_U8210_U821002_6");
    expect(second?.routeId).toBe("U8210");
    expect(second?.lat).toBeCloseTo(3.1446499824523926, 12);
    expect(second?.lon).toBeCloseTo(101.69567108154297, 12);
    expect(second?.timestamp).toBe(1790597291);
  });

  it("produces a stable sha256 content hash per row and no collisions", () => {
    const hashes = decoded.rows.map((row) => row.contentHash);
    expect(new Set(hashes).size).toBe(FIXTURE_ENTITY_COUNT);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const first = decoded.rows[0];
    expect(first).toBeDefined();
    if (!first) return;
    const expected = computeContentHash({
      vehicleId: first.vehicleId,
      tripId: first.tripId,
      routeId: first.routeId,
      lat: first.lat,
      lon: first.lon,
      bearing: first.bearing,
      speed: first.speed,
      timestamp: first.timestamp,
    });
    expect(first.contentHash).toBe(expected);
  });

  it("is deterministic for identical bytes and clock", () => {
    const again = decodeVehiclePositions(readFixture(), {
      observedAt: FIXED_OBSERVED_AT,
    });
    expect(again.rows).toEqual(decoded.rows);
  });

  it("keeps every row inside the Klang Valley bounding box", () => {
    for (const row of decoded.rows) {
      expect(row.lat).toBeGreaterThan(2.5);
      expect(row.lat).toBeLessThan(3.9);
      expect(row.lon).toBeGreaterThan(100.9);
      expect(row.lon).toBeLessThan(102.0);
    }
  });

  it("never touched the network", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(fetchSpy);
  });

  it("has the expected fixture sha256 (fixture is the captured sample)", () => {
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(
      FIXTURE_SHA256,
    );
  });

  it("rejects an empty payload with a typed error", () => {
    expect(() =>
      decodeVehiclePositions(new Uint8Array(0), {
        observedAt: FIXED_OBSERVED_AT,
      }),
    ).toThrow(FeedDecodeError);
  });
});
