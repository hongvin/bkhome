/**
 * The tiny SQL surface the repository needs. Both drivers (PGlite and `pg`)
 * implement it, so the repository logic — including every query and every
 * transaction — is written exactly once.
 */

export interface SqlExecutor {
  /** Run one or more statements with no parameters (DDL, migrations). */
  exec(sql: string): Promise<void>;
  /** Run one parameterised statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run `fn` inside a transaction; rolls back if `fn` throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Release the underlying connection/pool. Safe to call more than once. */
  close(): Promise<void>;
}

/** Rows that came back from `SELECT ... AS payload` may be objects (jsonb) or strings. */
export function parseJsonColumn<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}
