/**
 * `pg` driver — used only when `DATABASE_URL` is set (Supabase / Neon / any
 * hosted Postgres). `pg` is imported lazily so the default PGlite path never
 * loads it and never needs a credential.
 */

import type { SqlExecutor } from "./sql-executor";

type PgModule = typeof import("pg");

class PgTransactionExecutor implements SqlExecutor {
  constructor(private readonly client: import("pg").PoolClient) {}

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.client.query(sql, params ? [...params] : undefined);
    return result.rows as T[];
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    // The pool owns the connection; releasing happens in the outer transaction.
  }
}

class PgExecutor implements SqlExecutor {
  private closed = false;

  constructor(private readonly pool: import("pg").Pool) {}

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params ? [...params] : undefined);
    return result.rows as T[];
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgTransactionExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

export interface PgExecutorOptions {
  connectionString: string;
  maxConnections?: number;
}

export async function createPgExecutor(options: PgExecutorOptions): Promise<SqlExecutor> {
  const pg: PgModule = await import("pg");
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 4,
  });
  // Fail fast and loudly on a bad credential instead of at first query.
  const client = await pool.connect();
  client.release();
  return new PgExecutor(pool);
}
