/**
 * Postgres persistence layer.
 *
 * Default driver: PGlite (embedded Postgres, zero credentials, fully offline).
 * Hosted driver: `pg`, selected automatically when `DATABASE_URL` is set.
 */

export {
  createRepository,
  getRepository,
  closeRepositorySingleton,
  resolveRepositoryDriver,
  effectiveDatabaseUrl,
  SCHEMA_VERSION,
  SCHEMA_SQL,
  MIGRATIONS,
} from "./repository";

export type {
  TransitRepository,
  RepositoryDriver,
  RepositoryStats,
  CreateRepositoryOptions,
  RiskSnapshotInput,
  RiskSnapshotRow,
  VehiclePositionInput,
} from "./repository";

export type { Migration } from "./schema";
export type { SqlExecutor } from "./sql-executor";
export { parseJsonColumn } from "./sql-executor";
export { createPgliteExecutor } from "./pglite-driver";
export type { PgliteExecutorOptions } from "./pglite-driver";
export { createPgExecutor } from "./pg-driver";
export type { PgExecutorOptions } from "./pg-driver";
