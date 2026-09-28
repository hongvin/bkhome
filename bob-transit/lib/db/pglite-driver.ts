/**
 * PGlite driver — the DEFAULT, zero-credential, embedded Postgres.
 *
 * PGlite is a real Postgres compiled to WASM. It needs no server, no password and
 * no network, which is exactly why it is the default here: the demo path and the
 * whole test suite run against genuine Postgres semantics with no credential.
 *
 * Data lives in memory unless `dataDir` (or `PGLITE_DATA_DIR`) is set, in which
 * case it is persisted to that directory on disk.
 */

import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";
import type { SqlExecutor } from "./sql-executor";

class PgliteTransactionExecutor implements SqlExecutor {
  constructor(private readonly tx: Transaction) {}

  async exec(sql: string): Promise<void> {
    await this.tx.exec(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.tx.query<T>(sql, params ? [...params] : []);
    return result.rows;
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // Postgres has no nested transactions without savepoints; PGlite's own
    // `transaction()` already errors on nesting, so reuse this executor.
    return fn(this);
  }

  async close(): Promise<void> {
    // The outer transaction owns the connection.
  }
}

class PgliteExecutor implements SqlExecutor {
  private closed = false;

  constructor(private readonly db: PGlite) {}

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.db.query<T>(sql, params ? [...params] : []);
    return result.rows;
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PgliteTransactionExecutor(tx)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.close();
  }
}

export interface PgliteExecutorOptions {
  /** Directory for a persistent database. Omit for a fresh in-memory database. */
  dataDir?: string;
}

/**
 * Create a PGlite-backed executor. Never touches the network.
 */
export async function createPgliteExecutor(
  options: PgliteExecutorOptions = {},
): Promise<SqlExecutor> {
  const dataDir = options.dataDir ?? process.env.PGLITE_DATA_DIR ?? undefined;
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  return new PgliteExecutor(db);
}
