import pg from 'pg';
import type { DbConfig } from './config.js';

export interface Database {
  /** Read-only liveness probe of PostgreSQL: SELECT 1. Rejects on error or timeout. */
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

export interface SafeError {
  name: string;
  code?: string;
  message: string;
}

/** Strips anything that could carry credentials; replaces known secrets in the message. */
export function toSafeError(error: unknown, secrets: readonly string[] = []): SafeError {
  const source = error instanceof Error ? error : new Error(String(error));
  let message = source.message;
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[REDACTED]');
  }
  const code = (source as { code?: unknown }).code;
  return { name: source.name, ...(typeof code === 'string' ? { code } : {}), message };
}

export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(ms: number) {
    super(`Operation timed out after ${ms} ms`);
    this.name = 'TimeoutError';
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
  const secrets = [config.password];
  let closing: Promise<void> | undefined;

  // An idle client failing (e.g. PostgreSQL restart) must not crash the process.
  pool.on('error', (error) => {
    logger.error({ err: toSafeError(error, secrets) }, 'PostgreSQL pool error');
  });

  return {
    async check() {
      try {
        await withTimeout(pool.query('SELECT 1'), config.queryTimeoutMs);
      } catch (error) {
        throw Object.assign(new Error('Database check failed'), { cause: toSafeError(error, secrets) });
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
