/**
 * Shared test helpers for the worker suite.
 *
 * Everything here is offline: the only feed bytes come from the committed
 * fixture or from in-memory protobuf encoding.
 */
import { readFileSync } from "node:fs";
import type { FetchLike } from "../../worker/client";
import type {
  InsertResult,
  Logger,
  LogLevel,
  VehiclePositionRepository,
  VehiclePositionRow,
} from "../../worker/types";

/** Real captured sample — see worker/fixtures/README.md. */
export const FIXTURE_URL = new URL(
  "../../worker/fixtures/vehicle-position-prasarana-rapid-bus-kl.pb",
  import.meta.url,
);

/** sha256 of the committed fixture; guards against silent fixture edits. */
export const FIXTURE_SHA256 =
  "89c7fb561d9f345de1440f6db10c4d40e8f4589cb7b9ceb87048a3ec8780622c";

/** Number of entities in the committed fixture. */
export const FIXTURE_ENTITY_COUNT = 100;

/** Fixed clock so every assertion is deterministic. */
export const FIXED_OBSERVED_AT = new Date("2026-09-28T12:10:00.000Z");

export function readFixture(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE_URL));
}

/**
 * Copy bytes into a plain `ArrayBuffer`.
 *
 * `new Response(bytes)` is rejected by this TS/lib version because
 * `Uint8Array<ArrayBufferLike>` is not a `BodyInit`; an `ArrayBuffer` is.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** A `fetch` that returns the given bytes with a 200 response. */
export function bytesFetch(bytes: Uint8Array, status = 200): FetchLike {
  return async () => new Response(toArrayBuffer(bytes), { status });
}

/** A `fetch` that returns the given status with an empty body. */
export function statusFetch(status: number): FetchLike {
  return async () => new Response(null, { status });
}

/** A `fetch` that hangs until the caller's abort signal fires. */
export const hangingFetch: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });

export interface RecordingRepository extends VehiclePositionRepository {
  readonly calls: number;
  readonly batches: VehiclePositionRow[][];
  readonly rows: VehiclePositionRow[];
}

/** Repository that records every call, so "no partial writes" is assertable. */
export function recordingRepository(
  onInsert?: (rows: VehiclePositionRow[]) => void,
): RecordingRepository {
  const batches: VehiclePositionRow[][] = [];
  const rows: VehiclePositionRow[] = [];
  const repo: RecordingRepository = {
    get calls() {
      return batches.length;
    },
    batches,
    rows,
    async insertMany(batch: VehiclePositionRow[]): Promise<InsertResult> {
      batches.push(batch);
      rows.push(...batch);
      onInsert?.(batch);
      return { inserted: batch.length, skipped: 0 };
    },
  };
  return repo;
}

export interface CapturedLog {
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

export function collectingLogger(): {
  logger: Logger;
  entries: CapturedLog[];
} {
  const entries: CapturedLog[] = [];
  const logger: Logger = (level, event, data) => {
    entries.push({ level, event, data });
  };
  return { logger, entries };
}
