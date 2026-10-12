import pg from 'pg';
import type { DbConfig } from './config.js';
import { describeError, type ErrorMeta, TimeoutError } from './errors.js';

export { TimeoutError };

export interface Database {
  /** Read-only liveness probe of PostgreSQL: SELECT 1. Rejects with DatabaseCheckError on error or timeout. */
  check(): Promise<void>;
  /** Ends the pool. Safe to call more than once. */
  close(): Promise<void>;
  stats(): { total: number; idle: number; waiting: number };
}

export interface PoolLike {
  query(sql: string): Promise<unknown>;
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

export function createPool(config: DbConfig): PoolLike {
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
  });
}

export function createDatabase(config: DbConfig, logger: DbLogger, pool: PoolLike = createPool(config)): Database {
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
    close() {
      closing ??= pool.end();
      return closing;
    },
    stats() {
      return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    },
  };
}
