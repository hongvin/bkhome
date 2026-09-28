/**
 * Postgres schema for the transit reliability store.
 *
 * This is REAL Postgres DDL (tables, typed columns, foreign keys, indexes) — not a
 * JSON blob. It runs unchanged on PGlite (embedded Postgres, the zero-credential
 * default) and on a hosted Supabase/Neon Postgres via `DATABASE_URL`.
 *
 * Column policy: the fields the product queries on (status, windows, updated_at,
 * segment ids, confidence) are first-class typed columns with indexes. The full
 * `DisruptionSignal` is additionally kept in `payload jsonb` so a round-trip is
 * byte-faithful and a schema addition never loses data.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const SCHEMA_VERSION = 1;

const INITIAL_SCHEMA = /* sql */ `
-- ---------------------------------------------------------------------------
-- Bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Transit segments (mirror of the GTFS-derived graph, for offline joins)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS segments (
  id                      text PRIMARY KEY,
  line_id                 text NOT NULL,
  from_station_id         text NOT NULL,
  to_station_id           text NOT NULL,
  from_sequence           integer NOT NULL,
  to_sequence             integer NOT NULL,
  scheduled_run_seconds   integer NOT NULL,
  scheduled_dwell_seconds integer NOT NULL,
  length_meters           double precision NOT NULL,
  shape                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS segments_line_idx ON segments (line_id);

-- ---------------------------------------------------------------------------
-- Disruption signals — the central artefact of the product
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  id                                 text PRIMARY KEY,
  created_at                         timestamptz NOT NULL,
  updated_at                         timestamptz NOT NULL,
  status                             text NOT NULL,
  resolution                         text NOT NULL,
  issue_type                         text NOT NULL,
  severity                           text NOT NULL,
  confidence_value                   double precision NOT NULL,
  confidence_calibration_version     text NOT NULL,
  confidence_band                    text NOT NULL,
  confidence_degraded_by_offline     boolean NOT NULL DEFAULT false,
  first_seen_at                      timestamptz NOT NULL,
  last_seen_at                       timestamptz NOT NULL,
  operator_notified_at               timestamptz,
  lead_time_minutes                  double precision,
  window_starts_at                   timestamptz NOT NULL,
  window_ends_at                     timestamptz,
  official_source_count              integer NOT NULL DEFAULT 0,
  social_distinct_author_count       integer NOT NULL DEFAULT 0,
  realtime_observation_count         integer NOT NULL DEFAULT 0,
  reasoning                          text NOT NULL DEFAULT '',
  would_a_human_check_this           boolean NOT NULL DEFAULT false,
  line_ids                           text[] NOT NULL DEFAULT '{}',
  station_ids                        text[] NOT NULL DEFAULT '{}',
  segment_ids                        text[] NOT NULL DEFAULT '{}',
  unresolved_candidate_segment_ids   text[] NOT NULL DEFAULT '{}',
  payload                            jsonb NOT NULL,
  inserted_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_updated_at_idx ON signals (updated_at);
CREATE INDEX IF NOT EXISTS signals_status_idx ON signals (status);
CREATE INDEX IF NOT EXISTS signals_window_idx ON signals (window_starts_at, window_ends_at);
CREATE INDEX IF NOT EXISTS signals_segment_ids_idx ON signals USING gin (segment_ids);

-- Signal <-> segment edges, so "what is wrong on this segment" is a plain SQL join.
CREATE TABLE IF NOT EXISTS signal_segments (
  signal_id  text NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  PRIMARY KEY (signal_id, segment_id)
);
CREATE INDEX IF NOT EXISTS signal_segments_segment_idx ON signal_segments (segment_id);

-- ---------------------------------------------------------------------------
-- Sources — the evidence a signal rests on (official / social / realtime)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id             text PRIMARY KEY,
  signal_id      text NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  source_class   text NOT NULL,
  url            text,
  author_id      text,
  author_handle  text,
  title          text,
  raw_text       text NOT NULL,
  published_at   timestamptz NOT NULL,
  retrieved_at   timestamptz NOT NULL,
  language       text NOT NULL,
  content_hash   text NOT NULL,
  inserted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_signal_idx ON sources (signal_id);
CREATE INDEX IF NOT EXISTS sources_content_hash_idx ON sources (content_hash);
-- Deliberately NOT unique: two genuinely distinct sources may carry identical
-- text, and the persistence layer must round-trip a signal faithfully. Dedupe is
-- an ingest concern (S2/S3), not a storage constraint.
CREATE INDEX IF NOT EXISTS sources_signal_content_hash_idx ON sources (signal_id, content_hash);

-- ---------------------------------------------------------------------------
-- Risk snapshots — the risk overlay over time, for replay/audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_snapshots (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  segment_id               text NOT NULL,
  computed_at              timestamptz NOT NULL,
  degradation_probability  double precision NOT NULL,
  confidence               double precision NOT NULL,
  severity                 text NOT NULL,
  issue_type               text NOT NULL,
  source_count             integer NOT NULL DEFAULT 0,
  stale                    boolean NOT NULL DEFAULT false,
  overlay_generated_at     timestamptz,
  overlay_as_of            timestamptz,
  staleness_minutes        double precision,
  payload                  jsonb
);
CREATE INDEX IF NOT EXISTS risk_snapshots_segment_idx
  ON risk_snapshots (segment_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- Vehicle positions — realtime telemetry (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehicle_positions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id   text NOT NULL,
  line_id      text NOT NULL,
  trip_id      text,
  segment_id   text,
  lat          double precision NOT NULL,
  lon          double precision NOT NULL,
  observed_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_positions_observed_idx
  ON vehicle_positions (observed_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_positions_line_idx
  ON vehicle_positions (line_id, observed_at DESC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial_schema", sql: INITIAL_SCHEMA },
];

/** The full DDL as one string — used by `migrate()` and by tests/tooling. */
export const SCHEMA_SQL = MIGRATIONS.map((m) => m.sql).join("\n");
