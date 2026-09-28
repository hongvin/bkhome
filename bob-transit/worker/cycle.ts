/**
 * One ingest cycle: fetch -> decode -> normalize -> batch write.
 *
 * `runIngestCycle` NEVER throws. Every failure mode (network, HTTP, timeout,
 * malformed protobuf, empty feed, repository error) is converted into a
 * non-ok {@link IngestCycleResult} with a typed `error.kind`, so the CLI can
 * log and exit non-zero without an unhandled rejection.
 */
import {
  FeedHttpError,
  FeedNetworkError,
  FeedTimeoutError,
  fetchFeedBytes,
  type FetchLike,
} from "./client";
import { FeedDecodeError, decodeVehiclePositions, type DecodeResult } from "./decode";
import { jsonLogger, type Logger, type VehiclePositionRepository } from "./types";

/**
 * Verified vehicle-position feed for the Klang Valley. `prasarana` is the
 * operator; `category` selects the mode. Rail (`rapid-rail-kl`) has NO
 * realtime feed — it is static-only — so only bus categories yield data.
 */
export const FEED_BASE_URL =
  "https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana";

/** The category verified to return live vehicle positions. */
export const DEFAULT_CATEGORY = "rapid-bus-kl";

/** Category with no realtime feed (static GTFS only). Documented for callers. */
export const STATIC_ONLY_CATEGORY = "rapid-rail-kl";

/** Default request timeout, comfortably under the 30s poll interval. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Exact verified URL, kept verbatim for reference and for `npm run ingest`. */
export const DEFAULT_FEED_URL = `${FEED_BASE_URL}?category=${DEFAULT_CATEGORY}`;

/** Build the feed URL for a category. */
export function buildFeedUrl(category: string): string {
  return `${FEED_BASE_URL}?category=${encodeURIComponent(category)}`;
}

export type IngestErrorKind =
  | "network"
  | "timeout"
  | "http"
  | "decode"
  | "empty"
  | "repository";

export interface IngestError {
  kind: IngestErrorKind;
  message: string;
  /** Present for `kind: "http"`. */
  status?: number;
}

export interface IngestCycleResult {
  ok: boolean;
  feedUrl: string;
  category: string;
  /** ISO-8601 UTC time the cycle observed the feed. */
  observedAt: string;
  durationMs: number;
  /** `header.timestamp` (Unix seconds) when the feed decoded. */
  feedTimestamp: number | null;
  gtfsRealtimeVersion: string | null;
  entityCount: number;
  skippedEntities: number;
  duplicateEntities: number;
  /** Normalized rows handed to the repository. */
  rows: number;
  inserted: number;
  skipped: number;
  error: IngestError | null;
}

export interface IngestCycleOptions {
  repository: VehiclePositionRepository;
  /** Defaults to the verified bus feed for `category`. */
  feedUrl?: string;
  /** Defaults to `rapid-bus-kl`. */
  category?: string;
  /** Request timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected clock. Defaults to `new Date()` at the call site. */
  observedAt?: Date;
  /** Injected fetch, for tests. */
  fetchImpl?: FetchLike;
  /**
   * When true, a feed that yields zero usable rows is a success. Defaults to
   * false: an empty bus feed is treated as an upstream fault and fails the
   * cycle so a scheduler alerts.
   */
  allowEmpty?: boolean;
  logger?: Logger;
}

function emptyCounters(): Pick<
  IngestCycleResult,
  | "feedTimestamp"
  | "gtfsRealtimeVersion"
  | "entityCount"
  | "skippedEntities"
  | "duplicateEntities"
  | "rows"
  | "inserted"
  | "skipped"
> {
  return {
    feedTimestamp: null,
    gtfsRealtimeVersion: null,
    entityCount: 0,
    skippedEntities: 0,
    duplicateEntities: 0,
    rows: 0,
    inserted: 0,
    skipped: 0,
  };
}

/**
 * Run a single poll cycle. Always resolves; inspect `result.ok`.
 */
export async function runIngestCycle(
  options: IngestCycleOptions,
): Promise<IngestCycleResult> {
  const category = options.category ?? DEFAULT_CATEGORY;
  const feedUrl = options.feedUrl ?? buildFeedUrl(category);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const observedAt = options.observedAt ?? new Date();
  const log = options.logger ?? jsonLogger;
  const allowEmpty = options.allowEmpty ?? false;
  const startedAt = Date.now();

  const base = {
    feedUrl,
    category,
    observedAt: observedAt.toISOString(),
  };

  const finish = (
    partial: Partial<IngestCycleResult> & { ok: boolean },
  ): IngestCycleResult => ({
    ...base,
    durationMs: Date.now() - startedAt,
    ...emptyCounters(),
    error: null,
    ...partial,
  });

  const fail = (
    error: IngestError,
    partial: Partial<IngestCycleResult> = {},
  ): IngestCycleResult => {
    log("error", "ingest.cycle_failed", {
      feedUrl,
      category,
      kind: error.kind,
      status: error.status,
      message: error.message,
    });
    return finish({ ok: false, error, ...partial });
  };

  // 1. Fetch.
  let bytes: Uint8Array;
  let finalUrl: string;
  try {
    const fetched = await fetchFeedBytes({
      url: feedUrl,
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    bytes = fetched.bytes;
    finalUrl = fetched.finalUrl;
  } catch (err) {
    if (err instanceof FeedHttpError) {
      return fail({ kind: "http", message: err.message, status: err.status });
    }
    if (err instanceof FeedTimeoutError) {
      return fail({ kind: "timeout", message: err.message });
    }
    if (err instanceof FeedNetworkError) {
      return fail({ kind: "network", message: err.message });
    }
    return fail({
      kind: "network",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Decode + normalize (pure, offline).
  let decoded: DecodeResult;
  try {
    decoded = decodeVehiclePositions(bytes, { observedAt });
  } catch (err) {
    if (err instanceof FeedDecodeError) {
      return fail({ kind: "decode", message: err.message });
    }
    return fail({
      kind: "decode",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const counters = {
    feedTimestamp: decoded.feedTimestamp,
    gtfsRealtimeVersion: decoded.gtfsRealtimeVersion,
    entityCount: decoded.entityCount,
    skippedEntities: decoded.skippedEntities,
    duplicateEntities: decoded.duplicateEntities,
    rows: decoded.rows.length,
  };

  // 3. Empty-feed guard.
  if (decoded.rows.length === 0 && !allowEmpty) {
    const reason =
      decoded.entityCount === 0
        ? "feed contained 0 entities"
        : `feed contained ${decoded.entityCount} entities but none were usable vehicle positions`;
    log("error", "ingest.empty_feed", { feedUrl, category, ...counters });
    return finish({
      ok: false,
      ...counters,
      error: { kind: "empty", message: reason },
    });
  }

  // 4. Batch write. A write failure must not leave the caller thinking it worked.
  try {
    const written = await options.repository.insertMany(decoded.rows);
    log("info", "ingest.cycle_ok", {
      feedUrl,
      finalUrl,
      category,
      ...counters,
      inserted: written.inserted,
      skipped: written.skipped,
    });
    return finish({
      ok: true,
      ...counters,
      inserted: written.inserted,
      skipped: written.skipped,
    });
  } catch (err) {
    return fail(
      {
        kind: "repository",
        message: err instanceof Error ? err.message : String(err),
      },
      counters,
    );
  }
}
