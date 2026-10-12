import pg from 'pg';
import type { DbConfig } from './config.js';
import { describeError, type ErrorMeta, TimeoutError } from './errors.js';

export { TimeoutError };

export type QueryRow = Record<string, unknown>;

export interface QueryClient {
  /** Parameterized query only: values are always passed separately from SQL text. R is a caller-asserted row shape. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<R extends QueryRow = QueryRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface Database extends QueryClient {
  /** Read-only liveness probe of PostgreSQL: SELECT 1. Rejects with DatabaseCheckError on error or timeout. */
  check(): Promise<void>;
  /**
   * Runs fn inside BEGIN/COMMIT on one pooled client with a bounded transaction_timeout.
   * Any error → ROLLBACK and rethrow; the client is always released (destroyed if the connection is suspect).
   */
  transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T>;
  /** Ends the pool. Safe to call more than once. */
  close(): Promise<void>;
  stats(): { total: number; idle: number; waiting: number };
}

export interface PoolClientLike {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: QueryRow[]; rowCount: number | null }>;
  release(destroy?: boolean | Error): void;
}

export interface PoolLike {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface DbLogger {
  error(obj: object, msg: string): void;
}

/** Carries only ErrorMeta of the underlying failure; the original error (and its text) is dropped. */
export class DatabaseCheckError extends Error {
  readonly meta: ErrorMeta;

  constructor(meta: ErrorMeta) {
    super('Database check failed');
    this.name = 'DatabaseCheckError';
    this.meta = meta;
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new TimeoutError(ms)); }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const TRANSACTION_TIMEOUT_MS = 5_000;

export function createPool(config: DbConfig, options: { searchPath?: string } = {}): PoolLike {
  // TLS is deliberately not configured: the API connects over loopback (or an SSH tunnel in development).
  // Remote connections need a separate decision with certificate verification, not rejectUnauthorized:false.
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    query_timeout: config.queryTimeoutMs,
    statement_timeout: config.queryTimeoutMs,
    application_name: 'node-control-api',
    // Tests only: point the pool at a per-run schema (validated identifier, see test support).
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
}

export function createDatabase(
  config: DbConfig,
  logger: DbLogger,
  pool: PoolLike = createPool(config),
  options: { transactionTimeoutMs?: number } = {},
): Database {
  const transactionTimeoutMs = options.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS;
  let closing: Promise<void> | undefined;

  // An idle client failing (e.g. PostgreSQL restart) must not crash the process.
  pool.on('error', (error) => {
    logger.error({ error: describeError(error) }, 'PostgreSQL pool error');
  });

  return {
    async check() {
      try {
        await withTimeout(pool.query('SELECT 1'), config.queryTimeoutMs);
      } catch (error) {
        throw new DatabaseCheckError(describeError(error));
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    async query<R extends QueryRow = QueryRow>(sql: string, values: readonly unknown[] = []) {
      const result = (await pool.query(sql, values)) as { rows: R[]; rowCount: number | null };
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        // PostgreSQL 17+: aborts the whole transaction (incl. idle time inside it) after the limit.
        await client.query(`SET LOCAL transaction_timeout = ${String(Math.trunc(transactionTimeoutMs))}`);
        const result = await fn(client as QueryClient);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // connection state unknown → destroy instead of returning it to the pool
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close() {
      closing ??= pool.end();
      return closing;
    },
    stats() {
      return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    },
  };
}
