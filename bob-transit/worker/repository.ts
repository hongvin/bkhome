/**
 * `VehiclePositionRepository` implementations and the binding seam to S6's
 * real persistence layer.
 *
 * The worker only ever needs `insertMany`. Three implementations are provided:
 *  - {@link InMemoryVehiclePositionRepository} — tests and `--repo=memory`
 *  - {@link StdoutVehiclePositionRepository}  — NDJSON sink so `npm run ingest`
 *    is runnable before `lib/db` lands (the default)
 *  - {@link loadExternalRepository}           — binds `lib/db` at integration
 *    time without editing this worker
 */
import type {
  InsertResult,
  VehiclePositionRepository,
  VehiclePositionRow,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

/**
 * Validate an unknown value as a repository. Fails loudly rather than letting
 * an integration mistake surface as a runtime `insertMany is not a function`.
 */
export function assertRepository(
  value: unknown,
  label: string,
): VehiclePositionRepository {
  const record = asRecord(value);
  if (!record || typeof record.insertMany !== "function") {
    throw new Error(
      `${label} is not a VehiclePositionRepository: expected an object with an insertMany(rows) method`,
    );
  }
  return value as VehiclePositionRepository;
}

/**
 * In-memory repository. Idempotent on `contentHash`: a row whose hash was
 * already stored is counted in `skipped` and not duplicated.
 */
export class InMemoryVehiclePositionRepository
  implements VehiclePositionRepository
{
  private readonly hashes = new Set<string>();
  private readonly stored: VehiclePositionRow[] = [];

  async insertMany(rows: VehiclePositionRow[]): Promise<InsertResult> {
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      if (this.hashes.has(row.contentHash)) {
        skipped += 1;
        continue;
      }
      this.hashes.add(row.contentHash);
      this.stored.push(row);
      inserted += 1;
    }
    return { inserted, skipped };
  }

  /** All rows accepted so far, in insertion order. */
  get rows(): readonly VehiclePositionRow[] {
    return this.stored;
  }

  get size(): number {
    return this.stored.length;
  }
}

/**
 * NDJSON sink. Writes one JSON object per line, so a single cycle is observable
 * end-to-end (`npm run ingest`) even before the Postgres repository exists.
 */
export class StdoutVehiclePositionRepository
  implements VehiclePositionRepository
{
  private readonly write: (line: string) => void;

  constructor(write?: (line: string) => void) {
    this.write =
      write ??
      ((line: string): void => {
        process.stdout.write(line);
      });
  }

  async insertMany(rows: VehiclePositionRow[]): Promise<InsertResult> {
    for (const row of rows) this.write(`${JSON.stringify(row)}\n`);
    return { inserted: rows.length, skipped: 0 };
  }
}

/**
 * Dynamically import an external repository (S6's `lib/db`).
 *
 * The specifier is a runtime string on purpose: the worker must typecheck and
 * run whether or not `lib/db` exists yet. The module may export either a
 * repository object or a factory function returning one (sync or async).
 */
export async function loadExternalRepository(
  moduleSpecifier: string,
  exportName: string,
): Promise<VehiclePositionRepository> {
  const label = `${moduleSpecifier}#${exportName}`;
  const moduleNamespace = (await import(
    /* @vite-ignore */ moduleSpecifier
  )) as Record<string, unknown>;

  const candidate = moduleNamespace[exportName];
  if (candidate === undefined) {
    throw new Error(`${moduleSpecifier} does not export "${exportName}"`);
  }

  const resolved =
    typeof candidate === "function"
      ? await (candidate as () => unknown)()
      : candidate;

  return assertRepository(resolved, label);
}

export interface RepositorySpec {
  kind: "stdout" | "memory" | "external";
  /** Required when `kind` is "external". */
  moduleSpecifier?: string;
  /** Export name to read from the external module. Defaults to "default". */
  exportName?: string;
}

/** Build the repository selected by CLI flags. */
export async function createRepository(
  spec: RepositorySpec,
): Promise<VehiclePositionRepository> {
  switch (spec.kind) {
    case "memory":
      return new InMemoryVehiclePositionRepository();
    case "stdout":
      return new StdoutVehiclePositionRepository();
    case "external": {
      if (!spec.moduleSpecifier) {
        throw new Error("--repo-module is required when using an external repository");
      }
      return loadExternalRepository(
        spec.moduleSpecifier,
        spec.exportName ?? "default",
      );
    }
  }
}
