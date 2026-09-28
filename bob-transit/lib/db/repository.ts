/**
 * The transit repository — ONE interface, TWO drivers.
 *
 *  - `pglite` (default): embedded Postgres in WASM. No credential, no server,
 *    no network. This is what the demo and every test run against.
 *  - `pg`: a hosted Postgres (Supabase/Neon) when `DATABASE_URL` is set.
 *
 * Driver selection is by environment only; nothing else in the codebase needs to
 * know which one is live.
 */

import type { Segment } from "@/lib/contracts/network";
import type { DisruptionSignal } from "@/lib/contracts/signal";
import type { RiskOverlay, SegmentRisk } from "@/lib/contracts/risk";
import { MIGRATIONS } from "./schema";
import { createPgliteExecutor } from "./pglite-driver";
import { createPgExecutor } from "./pg-driver";
import { parseJsonColumn, type SqlExecutor } from "./sql-executor";

export type RepositoryDriver = "pglite" | "pg";

export interface RiskSnapshotInput {
  segment: SegmentRisk;
  /** Overlay-level metadata, when the snapshot came from a whole overlay. */
  overlay?: {
    generatedAt: string;
    asOf: string;
    stalenessMinutes: number;
  };
}

export interface RiskSnapshotRow {
  id: number;
  segmentId: string;
  computedAt: string;
  degradationProbability: number;
  confidence: number;
  severity: string;
  issueType: string;
  sourceCount: number;
  stale: boolean;
}

export interface VehiclePositionInput {
  vehicleId: string;
  lineId: string;
  tripId?: string | null;
  segmentId?: string | null;
  lat: number;
  lon: number;
  observedAt: string;
}

export interface RepositoryStats {
  schemaVersion: number;
  signals: number;
  activeSignals: number;
  segments: number;
  sources: number;
  riskSnapshots: number;
  vehiclePositions: number;
}

export interface TransitRepository {
  readonly driver: RepositoryDriver;
  /** Apply pending migrations. Idempotent. */
  migrate(): Promise<void>;
  schemaVersion(): Promise<number>;

  upsertSegment(segment: Segment): Promise<void>;
  upsertSegments(segments: readonly Segment[]): Promise<number>;

  /** Insert or update a signal, its segment edges and its sources — atomically. */
  upsertSignal(signal: DisruptionSignal): Promise<void>;
  getSignal(id: string): Promise<DisruptionSignal | null>;
  /** Signals whose window covers `at` and that are not cleared/rejected. */
  listActiveSignals(at?: string): Promise<DisruptionSignal[]>;
  /** THE RECONCILIATION QUERY: everything whose `updated_at` is past the cursor. */
  listSignalsChangedSince(since: string): Promise<DisruptionSignal[]>;
  listSignalsBySegment(segmentId: string, at?: string): Promise<DisruptionSignal[]>;

  recordRiskSnapshot(input: RiskSnapshotInput): Promise<void>;
  recordRiskSnapshots(overlay: RiskOverlay): Promise<number>;
  listRiskSnapshots(segmentId: string, limit?: number): Promise<RiskSnapshotRow[]>;

  recordVehiclePosition(position: VehiclePositionInput): Promise<void>;

  stats(): Promise<RepositoryStats>;
  close(): Promise<void>;
}

const TERMINAL_STATUSES = ["CLEARED", "REJECTED"] as const;

/* -------------------------------------------------------------------------- */
/* Row <-> contract mapping                                                    */
/* -------------------------------------------------------------------------- */

interface SignalRow {
  payload: unknown;
}

function rowToSignal(row: SignalRow): DisruptionSignal {
  const signal = parseJsonColumn<DisruptionSignal>(row.payload);
  if (!signal || typeof signal.id !== "string") {
    throw new Error("signals.payload is not a DisruptionSignal");
  }
  return signal;
}

interface RiskSnapshotDbRow {
  id: number | string;
  segment_id: string;
  computed_at: Date | string;
  degradation_probability: number | string;
  confidence: number | string;
  severity: string;
  issue_type: string;
  source_count: number | string;
  stale: boolean;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function signalParams(signal: DisruptionSignal): unknown[] {
  return [
    signal.id,
    signal.createdAt,
    signal.updatedAt,
    signal.status,
    signal.resolution,
    signal.issueType,
    signal.severity,
    signal.confidence.value,
    signal.confidence.calibrationVersion,
    signal.confidence.band,
    signal.confidence.degradedByOfflineCache,
    signal.firstSeenAt,
    signal.lastSeenAt,
    signal.operatorNotifiedAt,
    signal.leadTimeMinutes,
    signal.window.startsAt,
    signal.window.endsAt,
    signal.corroboratingSources.official,
    signal.corroboratingSources.socialDistinctAuthors,
    signal.corroboratingSources.realtimeObservations,
    signal.reasoning,
    signal.wouldAHumanCheckThis,
    signal.lineIds,
    signal.stationIds,
    signal.segmentIds,
    signal.unresolvedCandidates ?? [],
    JSON.stringify(signal),
  ];
}

const UPSERT_SIGNAL_SQL = /* sql */ `
INSERT INTO signals (
  id, created_at, updated_at, status, resolution, issue_type, severity,
  confidence_value, confidence_calibration_version, confidence_band,
  confidence_degraded_by_offline,
  first_seen_at, last_seen_at, operator_notified_at, lead_time_minutes,
  window_starts_at, window_ends_at,
  official_source_count, social_distinct_author_count, realtime_observation_count,
  reasoning, would_a_human_check_this,
  line_ids, station_ids, segment_ids, unresolved_candidate_segment_ids, payload
) VALUES (
  $1::text, $2::timestamptz, $3::timestamptz, $4::text, $5::text, $6::text, $7::text,
  $8::double precision, $9::text, $10::text, $11::boolean,
  $12::timestamptz, $13::timestamptz, $14::timestamptz, $15::double precision,
  $16::timestamptz, $17::timestamptz,
  $18::integer, $19::integer, $20::integer,
  $21::text, $22::boolean,
  $23::text[], $24::text[], $25::text[], $26::text[], $27::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  created_at                       = EXCLUDED.created_at,
  updated_at                       = EXCLUDED.updated_at,
  status                           = EXCLUDED.status,
  resolution                       = EXCLUDED.resolution,
  issue_type                       = EXCLUDED.issue_type,
  severity                         = EXCLUDED.severity,
  confidence_value                 = EXCLUDED.confidence_value,
  confidence_calibration_version   = EXCLUDED.confidence_calibration_version,
  confidence_band                  = EXCLUDED.confidence_band,
  confidence_degraded_by_offline   = EXCLUDED.confidence_degraded_by_offline,
  first_seen_at                    = EXCLUDED.first_seen_at,
  last_seen_at                     = EXCLUDED.last_seen_at,
  operator_notified_at             = EXCLUDED.operator_notified_at,
  lead_time_minutes                = EXCLUDED.lead_time_minutes,
  window_starts_at                 = EXCLUDED.window_starts_at,
  window_ends_at                   = EXCLUDED.window_ends_at,
  official_source_count            = EXCLUDED.official_source_count,
  social_distinct_author_count     = EXCLUDED.social_distinct_author_count,
  realtime_observation_count       = EXCLUDED.realtime_observation_count,
  reasoning                        = EXCLUDED.reasoning,
  would_a_human_check_this         = EXCLUDED.would_a_human_check_this,
  line_ids                         = EXCLUDED.line_ids,
  station_ids                      = EXCLUDED.station_ids,
  segment_ids                      = EXCLUDED.segment_ids,
  unresolved_candidate_segment_ids = EXCLUDED.unresolved_candidate_segment_ids,
  payload                          = EXCLUDED.payload
`;

const UPSERT_SEGMENT_SQL = /* sql */ `
INSERT INTO segments (
  id, line_id, from_station_id, to_station_id, from_sequence, to_sequence,
  scheduled_run_seconds, scheduled_dwell_seconds, length_meters, shape, updated_at
) VALUES (
  $1::text, $2::text, $3::text, $4::text, $5::integer, $6::integer,
  $7::integer, $8::integer, $9::double precision, $10::jsonb, now()
)
ON CONFLICT (id) DO UPDATE SET
  line_id                 = EXCLUDED.line_id,
  from_station_id         = EXCLUDED.from_station_id,
  to_station_id           = EXCLUDED.to_station_id,
  from_sequence           = EXCLUDED.from_sequence,
  to_sequence             = EXCLUDED.to_sequence,
  scheduled_run_seconds   = EXCLUDED.scheduled_run_seconds,
  scheduled_dwell_seconds = EXCLUDED.scheduled_dwell_seconds,
  length_meters           = EXCLUDED.length_meters,
  shape                   = EXCLUDED.shape,
  updated_at              = now()
`;

/* -------------------------------------------------------------------------- */
/* The repository                                                              */
/* -------------------------------------------------------------------------- */

class SqlTransitRepository implements TransitRepository {
  constructor(
    readonly driver: RepositoryDriver,
    private readonly db: SqlExecutor,
  ) {}

  async migrate(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const applied = new Set(
      (
        await this.db.query<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version ASC",
        )
      ).map((row) => row.version),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await this.db.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1::integer, $2::text) ON CONFLICT (version) DO NOTHING",
          [migration.version, migration.name],
        );
      });
    }
  }

  async schemaVersion(): Promise<number> {
    const rows = await this.db.query<{ version: number | null }>(
      "SELECT max(version) AS version FROM schema_migrations",
    );
    const version = rows[0]?.version;
    return version == null ? 0 : Number(version);
  }

  async upsertSegment(segment: Segment): Promise<void> {
    await this.db.query(UPSERT_SEGMENT_SQL, [
      segment.id,
      segment.lineId,
      segment.fromStationId,
      segment.toStationId,
      segment.fromSequence,
      segment.toSequence,
      segment.scheduledRunSeconds,
      segment.scheduledDwellSeconds,
      segment.lengthMeters,
      JSON.stringify(segment.shape),
    ]);
  }

  async upsertSegments(segments: readonly Segment[]): Promise<number> {
    if (segments.length === 0) return 0;
    await this.db.transaction(async (tx) => {
      for (const segment of segments) {
        await tx.query(UPSERT_SEGMENT_SQL, [
          segment.id,
          segment.lineId,
          segment.fromStationId,
          segment.toStationId,
          segment.fromSequence,
          segment.toSequence,
          segment.scheduledRunSeconds,
          segment.scheduledDwellSeconds,
          segment.lengthMeters,
          JSON.stringify(segment.shape),
        ]);
      }
    });
    return segments.length;
  }

  async upsertSignal(signal: DisruptionSignal): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(UPSERT_SIGNAL_SQL, signalParams(signal));

      await tx.query("DELETE FROM signal_segments WHERE signal_id = $1::text", [signal.id]);
      for (const segmentId of signal.segmentIds) {
        await tx.query(
          "INSERT INTO signal_segments (signal_id, segment_id) VALUES ($1::text, $2::text) ON CONFLICT DO NOTHING",
          [signal.id, segmentId],
        );
      }

      // Sources are replaced wholesale so the table mirrors the signal exactly.
      await tx.query("DELETE FROM sources WHERE signal_id = $1::text", [signal.id]);
      for (const source of signal.sources) {
        await tx.query(
          `INSERT INTO sources (
             id, signal_id, source_class, url, author_id, author_handle, title,
             raw_text, published_at, retrieved_at, language, content_hash
           ) VALUES (
             $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
             $8::text, $9::timestamptz, $10::timestamptz, $11::text, $12::text
           )
           ON CONFLICT (id) DO UPDATE SET
             source_class  = EXCLUDED.source_class,
             url           = EXCLUDED.url,
             author_id     = EXCLUDED.author_id,
             author_handle = EXCLUDED.author_handle,
             title         = EXCLUDED.title,
             raw_text      = EXCLUDED.raw_text,
             published_at  = EXCLUDED.published_at,
             retrieved_at  = EXCLUDED.retrieved_at,
             language      = EXCLUDED.language,
             content_hash  = EXCLUDED.content_hash`,
          [
            source.id,
            signal.id,
            source.sourceClass,
            source.url ?? null,
            source.authorId ?? null,
            source.authorHandle ?? null,
            source.title ?? null,
            source.rawText,
            source.publishedAt,
            source.retrievedAt,
            source.language,
            source.contentHash,
          ],
        );
      }
    });
  }

  async getSignal(id: string): Promise<DisruptionSignal | null> {
    const rows = await this.db.query<SignalRow>(
      "SELECT payload FROM signals WHERE id = $1::text",
      [id],
    );
    return rows.length > 0 ? rowToSignal(rows[0]) : null;
  }

  async listActiveSignals(at?: string): Promise<DisruptionSignal[]> {
    const instant = at ?? new Date().toISOString();
    const rows = await this.db.query<SignalRow>(
      `SELECT payload FROM signals
        WHERE status <> ALL ($1::text[])
          AND window_starts_at <= $2::timestamptz
          AND (window_ends_at IS NULL OR window_ends_at >= $2::timestamptz)
        ORDER BY updated_at DESC, id ASC`,
      [[...TERMINAL_STATUSES], instant],
    );
    return rows.map(rowToSignal);
  }

  async listSignalsChangedSince(since: string): Promise<DisruptionSignal[]> {
    const rows = await this.db.query<SignalRow>(
      `SELECT payload FROM signals
        WHERE updated_at > $1::timestamptz
        ORDER BY updated_at ASC, id ASC`,
      [since],
    );
    return rows.map(rowToSignal);
  }

  async listSignalsBySegment(segmentId: string, at?: string): Promise<DisruptionSignal[]> {
    const instant = at ?? new Date().toISOString();
    const rows = await this.db.query<SignalRow>(
      `SELECT s.payload
         FROM signals s
         JOIN signal_segments ss ON ss.signal_id = s.id
        WHERE ss.segment_id = $1::text
          AND s.status <> ALL ($2::text[])
          AND s.window_starts_at <= $3::timestamptz
          AND (s.window_ends_at IS NULL OR s.window_ends_at >= $3::timestamptz)
        ORDER BY s.updated_at DESC, s.id ASC`,
      [segmentId, [...TERMINAL_STATUSES], instant],
    );
    return rows.map(rowToSignal);
  }

  async recordRiskSnapshot(input: RiskSnapshotInput): Promise<void> {
    const { segment, overlay } = input;
    await this.db.query(
      `INSERT INTO risk_snapshots (
         segment_id, computed_at, degradation_probability, confidence, severity,
         issue_type, source_count, stale, overlay_generated_at, overlay_as_of,
         staleness_minutes, payload
       ) VALUES (
         $1::text, $2::timestamptz, $3::double precision, $4::double precision,
         $5::text, $6::text, $7::integer, $8::boolean, $9::timestamptz,
         $10::timestamptz, $11::double precision, $12::jsonb
       )`,
      [
        segment.segmentId,
        segment.lastUpdated,
        segment.degradationProbability,
        segment.confidence,
        segment.severity,
        segment.issueType,
        segment.sourceCount,
        segment.stale,
        overlay?.generatedAt ?? null,
        overlay?.asOf ?? null,
        overlay?.stalenessMinutes ?? null,
        JSON.stringify(segment),
      ],
    );
  }

  async recordRiskSnapshots(overlay: RiskOverlay): Promise<number> {
    if (overlay.segments.length === 0) return 0;
    await this.db.transaction(async (tx) => {
      for (const segment of overlay.segments) {
        await tx.query(
          `INSERT INTO risk_snapshots (
             segment_id, computed_at, degradation_probability, confidence, severity,
             issue_type, source_count, stale, overlay_generated_at, overlay_as_of,
             staleness_minutes, payload
           ) VALUES (
             $1::text, $2::timestamptz, $3::double precision, $4::double precision,
             $5::text, $6::text, $7::integer, $8::boolean, $9::timestamptz,
             $10::timestamptz, $11::double precision, $12::jsonb
           )`,
          [
            segment.segmentId,
            segment.lastUpdated,
            segment.degradationProbability,
            segment.confidence,
            segment.severity,
            segment.issueType,
            segment.sourceCount,
            segment.stale,
            overlay.generatedAt,
            overlay.asOf,
            overlay.stalenessMinutes,
            JSON.stringify(segment),
          ],
        );
      }
    });
    return overlay.segments.length;
  }

  async listRiskSnapshots(segmentId: string, limit = 50): Promise<RiskSnapshotRow[]> {
    const rows = await this.db.query<RiskSnapshotDbRow>(
      `SELECT id, segment_id, computed_at, degradation_probability, confidence,
              severity, issue_type, source_count, stale
         FROM risk_snapshots
        WHERE segment_id = $1::text
        ORDER BY computed_at DESC, id DESC
        LIMIT $2::integer`,
      [segmentId, limit],
    );
    return rows.map((row) => ({
      id: num(row.id),
      segmentId: row.segment_id,
      computedAt: iso(row.computed_at),
      degradationProbability: num(row.degradation_probability),
      confidence: num(row.confidence),
      severity: row.severity,
      issueType: row.issue_type,
      sourceCount: num(row.source_count),
      stale: row.stale,
    }));
  }

  async recordVehiclePosition(position: VehiclePositionInput): Promise<void> {
    await this.db.query(
      `INSERT INTO vehicle_positions (
         vehicle_id, line_id, trip_id, segment_id, lat, lon, observed_at
       ) VALUES (
         $1::text, $2::text, $3::text, $4::text, $5::double precision,
         $6::double precision, $7::timestamptz
       )`,
      [
        position.vehicleId,
        position.lineId,
        position.tripId ?? null,
        position.segmentId ?? null,
        position.lat,
        position.lon,
        position.observedAt,
      ],
    );
  }

  async stats(): Promise<RepositoryStats> {
    const rows = await this.db.query<{
      signals: number | string;
      active_signals: number | string;
      segments: number | string;
      sources: number | string;
      risk_snapshots: number | string;
      vehicle_positions: number | string;
    }>(
      `SELECT
         (SELECT count(*) FROM signals)                                              AS signals,
         (SELECT count(*) FROM signals
           WHERE status <> ALL ($1::text[])
             AND window_starts_at <= now()
             AND (window_ends_at IS NULL OR window_ends_at >= now()))               AS active_signals,
         (SELECT count(*) FROM segments)                                            AS segments,
         (SELECT count(*) FROM sources)                                             AS sources,
         (SELECT count(*) FROM risk_snapshots)                                      AS risk_snapshots,
         (SELECT count(*) FROM vehicle_positions)                                   AS vehicle_positions`,
      [[...TERMINAL_STATUSES]],
    );
    const row = rows[0];
    return {
      schemaVersion: await this.schemaVersion(),
      signals: num(row?.signals ?? 0),
      activeSignals: num(row?.active_signals ?? 0),
      segments: num(row?.segments ?? 0),
      sources: num(row?.sources ?? 0),
      riskSnapshots: num(row?.risk_snapshots ?? 0),
      vehiclePositions: num(row?.vehicle_positions ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Driver selection                                                            */
/* -------------------------------------------------------------------------- */

export interface CreateRepositoryOptions {
  /**
   * Hosted Postgres connection string.
   *  - omitted (`undefined`) -> use `process.env.DATABASE_URL`
   *  - `null` or `""`        -> force the embedded PGlite driver
   */
  databaseUrl?: string | null;
  /** Directory for a persistent PGlite database. Defaults to `PGLITE_DATA_DIR`, else in-memory. */
  pgliteDataDir?: string;
  /** Run migrations immediately. Default true. */
  migrate?: boolean;
}

/** `undefined` means "ask the environment"; `null`/`""` means "force PGlite". */
export function effectiveDatabaseUrl(options: CreateRepositoryOptions = {}): string | null {
  const url = options.databaseUrl === undefined ? process.env.DATABASE_URL : options.databaseUrl;
  if (url === undefined || url === null) return null;
  const trimmed = url.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveRepositoryDriver(
  options: CreateRepositoryOptions = {},
): RepositoryDriver {
  return effectiveDatabaseUrl(options) ? "pg" : "pglite";
}

/**
 * Build a repository. Never throws for a missing credential — absence of
 * `DATABASE_URL` selects the embedded PGlite driver.
 */
export async function createRepository(
  options: CreateRepositoryOptions = {},
): Promise<TransitRepository> {
  const url = effectiveDatabaseUrl(options);
  const driver: RepositoryDriver = url ? "pg" : "pglite";

  const executor: SqlExecutor =
    driver === "pg"
      ? await createPgExecutor({ connectionString: url as string })
      : await createPgliteExecutor({ dataDir: options.pgliteDataDir });

  const repository = new SqlTransitRepository(driver, executor);
  if (options.migrate !== false) {
    await repository.migrate();
  }
  return repository;
}

/**
 * Process-wide repository, for Next.js route handlers. The Next dev server
 * reloads modules on edit, so this is cached on `globalThis`.
 */
export function getRepository(options: CreateRepositoryOptions = {}): Promise<TransitRepository> {
  const globalKey = "__bobTransitRepository" as const;
  const store = globalThis as typeof globalThis & {
    [globalKey]?: Promise<TransitRepository>;
  };
  if (!store[globalKey]) {
    store[globalKey] = createRepository(options);
  }
  return store[globalKey];
}

/** Test hook: drop the cached singleton and close it. */
export async function closeRepositorySingleton(): Promise<void> {
  const globalKey = "__bobTransitRepository" as const;
  const store = globalThis as typeof globalThis & {
    [globalKey]?: Promise<TransitRepository>;
  };
  const pending = store[globalKey];
  delete store[globalKey];
  if (pending) {
    const repository = await pending;
    await repository.close();
  }
}

export { SCHEMA_VERSION, SCHEMA_SQL, MIGRATIONS } from "./schema";
export type { SqlExecutor } from "./sql-executor";
