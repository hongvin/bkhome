/**
 * Worker-local persistence contract.
 *
 * This is the NARROW interface the ingest worker needs from storage. It is
 * deliberately defined here (not in `lib/db/`) so the worker can be built and
 * tested before/independently of the real persistence layer (S6).
 *
 * Integration seam for the orchestrator:
 *   `lib/db` must expose something structurally compatible with
 *   `VehiclePositionRepository` — i.e. an object with an
 *   `insertMany(rows: VehiclePositionRow[]): Promise<InsertResult>` method that
 *   is idempotent on `contentHash` (unique index + ON CONFLICT DO NOTHING).
 *   Bind it with the CLI flags `--repo-module=<specifier> --repo-export=<name>`.
 *
 * No method beyond `insertMany` is required. The worker never reads back.
 */

/**
 * One normalized vehicle observation, ready to be persisted.
 *
 * Field list is intentionally exactly the deliverable spec:
 * `vehicleId, tripId, routeId, lat, lon, bearing, speed, timestamp, observedAt`
 * plus `contentHash` for dedupe. Do not add columns here without a contract
 * change — S6 owns the schema.
 */
export interface VehiclePositionRow {
  /** Stable dedupe key: sha256 over the canonical field tuple (see computeContentHash). */
  contentHash: string;
  /** GTFS-R `vehicle.id` (falls back to `vehicle.label`). Non-empty. */
  vehicleId: string;
  /** GTFS-R `trip.trip_id`, null when the feed omits it. */
  tripId: string | null;
  /** GTFS-R `trip.route_id`, null when the feed omits it. */
  routeId: string | null;
  /** WGS84 latitude in degrees. */
  lat: number;
  /** WGS84 longitude in degrees. */
  lon: number;
  /** Degrees clockwise from true north, null when absent. */
  bearing: number | null;
  /** Metres per second (GTFS-R `Position.speed`), null when absent. */
  speed: number | null;
  /** Observation time from the feed, Unix seconds (vehicle timestamp, else feed header). */
  timestamp: number;
  /** Wall-clock time this worker observed the feed, ISO-8601 UTC. */
  observedAt: string;
}

/** Outcome of a batch write. `skipped` counts rows rejected as duplicates. */
export interface InsertResult {
  inserted: number;
  skipped: number;
}

/** The only capability the worker requires from persistence. */
export interface VehiclePositionRepository {
  insertMany(rows: VehiclePositionRow[]): Promise<InsertResult>;
}

export type LogLevel = "info" | "warn" | "error";

/** Structured logger. Injected in tests; defaults to JSON lines on stderr. */
export type Logger = (
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
) => void;

/** Default logger: one JSON object per line on stderr (stdout stays clean). */
export const jsonLogger: Logger = (level, event, data) => {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...data })}\n`,
  );
};
