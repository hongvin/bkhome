/**
 * Pure GTFS-Realtime vehicle-position decoding + normalization.
 *
 * This module is the decode path and is deliberately free of I/O: no network,
 * no clock, no filesystem beyond the vendored `.proto` parsed by `./proto`.
 * `observedAt` is injected so results are deterministic.
 */
import { createHash } from "node:crypto";
import { decodeFeedMessage } from "./proto";
import type { VehiclePositionRow } from "./types";

/**
 * Decimal places used when hashing coordinates (~0.11 m at the equator). Two
 * observations that differ only by sub-decimetre float noise dedupe together.
 */
const HASH_COORD_PRECISION = 6;
/** Decimal places used when hashing bearing/speed. */
const HASH_MOTION_PRECISION = 3;

/** Raised for any payload that is not a decodable GTFS-Realtime FeedMessage. */
export class FeedDecodeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FeedDecodeError";
    this.cause = cause;
  }
}

export interface DecodeOptions {
  /**
   * Wall-clock time of this observation, injected (never read from the clock
   * here) so decoding is deterministic and testable.
   */
  observedAt: Date;
}

export interface DecodeResult {
  /** Normalized, de-duplicated rows in feed order. */
  rows: VehiclePositionRow[];
  /** `header.timestamp` in Unix seconds, null when the feed omits it. */
  feedTimestamp: number | null;
  /** `header.gtfs_realtime_version`, e.g. "2.0". */
  gtfsRealtimeVersion: string;
  /** `header.incrementality`, e.g. "FULL_DATASET". */
  incrementality: string;
  /** Number of entities present in the feed (including unusable ones). */
  entityCount: number;
  /** Entities that were not usable vehicle positions (deleted, no position, no id...). */
  skippedEntities: number;
  /** Entities dropped because an identical content hash already appeared in this batch. */
  duplicateEntities: number;
}

/** Fields that define a row's identity for dedupe purposes. */
export interface ContentHashInput {
  vehicleId: string;
  tripId: string | null;
  routeId: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  timestamp: number;
}

/**
 * Deterministic content hash for a normalized observation.
 *
 * Two rows with the same hash are the same physical observation and must be
 * stored once. A moving vehicle produces a new hash as soon as its timestamp,
 * position, bearing or speed changes.
 */
export function computeContentHash(input: ContentHashInput): string {
  const canonical = [
    input.vehicleId,
    input.tripId ?? "",
    input.routeId ?? "",
    input.lat.toFixed(HASH_COORD_PRECISION),
    input.lon.toFixed(HASH_COORD_PRECISION),
    input.bearing === null ? "" : input.bearing.toFixed(HASH_MOTION_PRECISION),
    input.speed === null ? "" : input.speed.toFixed(HASH_MOTION_PRECISION),
    String(input.timestamp),
  ].join("\u0001");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decode a GTFS-Realtime vehicle-position payload into normalized rows.
 *
 * Throws {@link FeedDecodeError} when the bytes are not a valid FeedMessage
 * (truncated, garbage, or zero-length). Entities that are not usable vehicle
 * positions are counted in `skippedEntities` rather than failing the batch —
 * one bad vehicle must not discard a whole feed.
 */
export function decodeVehiclePositions(
  bytes: Uint8Array,
  options: DecodeOptions,
): DecodeResult {
  if (bytes.length === 0) {
    throw new FeedDecodeError("GTFS-Realtime payload is empty (0 bytes)");
  }

  let raw: Record<string, unknown>;
  try {
    raw = decodeFeedMessage(bytes);
  } catch (err) {
    throw new FeedDecodeError(
      `malformed GTFS-Realtime payload: ${describe(err)}`,
      err,
    );
  }

  const header = asRecord(raw.header) ?? {};
  const feedTimestamp = finiteNumber(header.timestamp);
  const gtfsRealtimeVersion =
    nonEmptyString(header.gtfsRealtimeVersion) ?? "unknown";
  const incrementality = nonEmptyString(header.incrementality) ?? "UNKNOWN";
  const observedAtSeconds = Math.floor(options.observedAt.getTime() / 1000);

  const entities = Array.isArray(raw.entity) ? raw.entity : [];
  const rows: VehiclePositionRow[] = [];
  const seenHashes = new Set<string>();
  let skippedEntities = 0;
  let duplicateEntities = 0;

  for (const entityValue of entities) {
    const entity = asRecord(entityValue);
    if (!entity || entity.isDeleted === true) {
      skippedEntities += 1;
      continue;
    }

    const vehicle = asRecord(entity.vehicle);
    const position = vehicle ? asRecord(vehicle.position) : null;
    const lat = position ? finiteNumber(position.latitude) : null;
    const lon = position ? finiteNumber(position.longitude) : null;
    if (!vehicle || !position || lat === null || lon === null) {
      skippedEntities += 1;
      continue;
    }

    const vehicleDescriptor = asRecord(vehicle.vehicle);
    const vehicleId =
      nonEmptyString(vehicleDescriptor?.id) ??
      nonEmptyString(vehicleDescriptor?.label) ??
      nonEmptyString(vehicleDescriptor?.licensePlate);
    if (vehicleId === null) {
      skippedEntities += 1;
      continue;
    }

    const trip = asRecord(vehicle.trip);
    const tripId = nonEmptyString(trip?.tripId);
    const routeId = nonEmptyString(trip?.routeId);

    // Vehicle-level timestamp is the observation time; fall back to the feed
    // header, then to our own wall clock so a row is never timestamp-less.
    const vehicleTimestamp = finiteNumber(vehicle.timestamp);
    const timestamp =
      vehicleTimestamp !== null && vehicleTimestamp > 0
        ? Math.floor(vehicleTimestamp)
        : (feedTimestamp ?? observedAtSeconds);

    const bearing = finiteNumber(position.bearing);
    const speed = finiteNumber(position.speed);

    const contentHash = computeContentHash({
      vehicleId,
      tripId,
      routeId,
      lat,
      lon,
      bearing,
      speed,
      timestamp,
    });

    if (seenHashes.has(contentHash)) {
      duplicateEntities += 1;
      continue;
    }
    seenHashes.add(contentHash);

    rows.push({
      contentHash,
      vehicleId,
      tripId,
      routeId,
      lat,
      lon,
      bearing,
      speed,
      timestamp,
      observedAt: options.observedAt.toISOString(),
    });
  }

  return {
    rows,
    feedTimestamp,
    gtfsRealtimeVersion,
    incrementality,
    entityCount: entities.length,
    skippedEntities,
    duplicateEntities,
  };
}
