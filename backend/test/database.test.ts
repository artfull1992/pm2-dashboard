import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import pg from 'pg';
import { createDatabase, DatabaseCheckError, type PoolLike, TimeoutError, withTimeout } from '../src/database.js';
import { FAKE_SECRET, freePort } from './helpers.js';

const dbConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({ DB_NAME: 'node_control_db', DB_USER: 'node_control_user', DB_PASS: FAKE_SECRET, ...overrides }).db;

class FakeClient {
  readonly sql: string[] = [];
  failOn: string | undefined;
  failRollback = false;
  release = vi.fn();
  query = vi.fn((sql: string) => {
    this.sql.push(sql);
    if (this.failOn !== undefined && sql.startsWith(this.failOn)) return Promise.reject(new Error(`fail ${FAKE_SECRET}`));
    if (sql === 'ROLLBACK' && this.failRollback) return Promise.reject(new Error('connection lost'));
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

class FakePool extends EventEmitter implements PoolLike {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  client = new FakeClient();
  query = vi.fn((_sql: string, _values?: readonly unknown[]): Promise<unknown> => Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  connect = vi.fn(() => Promise.resolve(this.client));
  end = vi.fn(() => Promise.resolve());
}

const logger = () => ({ error: vi.fn() });

describe('createDatabase with an injected pool', () => {
  it('check runs exactly SELECT 1', async () => {
    const pool = new FakePool();
    await createDatabase(dbConfig(), logger(), pool).check();
    expect(pool.query).toHaveBeenCalledExactlyOnceWith('SELECT 1');
  });

  it('check rejects with metadata only: SQLSTATE kept, message/stack/cause dropped', async () => {
    const pool = new FakePool();
    const pgError = Object.assign(new pg.DatabaseError(`password authentication failed ${FAKE_SECRET}`, 0, 'error'), {
      code: '28P01',
      cause: new Error(`nested ${FAKE_SECRET}`),
    });
    pool.query.mockRejectedValueOnce(pgError);
    const error = await createDatabase(dbConfig(), logger(), pool).check().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseCheckError);
    expect((error as DatabaseCheckError).meta).toEqual({ category: 'database', code: '28P01' });
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error) + String(error) + ((error as Error).stack ?? '')).not.toContain(FAKE_SECRET);
  });

  it('check times out when the query hangs', async () => {
    const pool = new FakePool();
    pool.query.mockReturnValueOnce(new Promise(() => undefined));
    const config = { ...dbConfig(), queryTimeoutMs: 30 };
    const error = await createDatabase(config, logger(), pool).check().catch((e: unknown) => e);
    expect((error as DatabaseCheckError).meta).toEqual({ category: 'timeout', code: 'ETIMEDOUT' });
  });

  it('pool errors are logged without credentials and do not throw', () => {
    const pool = new FakePool();
    const log = logger();
    createDatabase(dbConfig(), log, pool);
    expect(() => pool.emit('error', new Error(`terminating connection; password=${FAKE_SECRET}`))).not.toThrow();
    expect(log.error).toHaveBeenCalledExactlyOnceWith({ error: { category: 'internal' } }, 'PostgreSQL pool error');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(FAKE_SECRET);
  });

  it('close ends the pool once even when called repeatedly', async () => {
    const pool = new FakePool();
    const database = createDatabase(dbConfig(), logger(), pool);
    await Promise.all([database.close(), database.close()]);
    await database.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('stats reflects the pool counters', () => {
    const pool = Object.assign(new FakePool(), { totalCount: 3, idleCount: 2, waitingCount: 1 });
    expect(createDatabase(dbConfig(), logger(), pool).stats()).toEqual({ total: 3, idle: 2, waiting: 1 });
  });
});

describe('query and transaction', () => {
  it('query passes values separately from SQL', async () => {
    const pool = new FakePool();
    await createDatabase(dbConfig(), logger(), pool).query('SELECT $1::int AS x', [1]);
    expect(pool.query).toHaveBeenCalledWith('SELECT $1::int AS x', [1]);
  });

  it('transaction: BEGIN, bounded transaction_timeout, work, COMMIT, release', async () => {
    const pool = new FakePool();
    const db = createDatabase(dbConfig(), logger(), pool, { transactionTimeoutMs: 1234 });
    const result = await db.transaction(async (c) => { await c.query('INSERT 1', ['v']); return 'done'; });
    expect(result).toBe('done');
    expect(pool.client.sql).toEqual(['BEGIN', 'SET LOCAL transaction_timeout = 1234', 'INSERT 1', 'COMMIT']);
    expect(pool.client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('transaction: error in work → ROLLBACK, rethrow, client returned to pool', async () => {
    const pool = new FakePool();
    pool.client.failOn = 'INSERT audit';
    const db = createDatabase(dbConfig(), logger(), pool);
    await expect(db.transaction(async (c) => { await c.query('INSERT session'); await c.query('INSERT audit'); })).rejects.toThrow();
    expect(pool.client.sql).toEqual(['BEGIN', 'SET LOCAL transaction_timeout = 5000', 'INSERT session', 'INSERT audit', 'ROLLBACK']);
    expect(pool.client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('transaction: failing ROLLBACK destroys the client instead of reusing it', async () => {
    const pool = new FakePool();
    pool.client.failOn = 'X';
    pool.client.failRollback = true;
    await expect(createDatabase(dbConfig(), logger(), pool).transaction((c) => c.query('X'))).rejects.toThrow();
    expect(pool.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('transaction: COMMIT failure is rolled back and rethrown', async () => {
    const pool = new FakePool();
    pool.client.failOn = 'COMMIT';
    await expect(createDatabase(dbConfig(), logger(), pool).transaction(() => Promise.resolve(1))).rejects.toThrow();
    expect(pool.client.sql.at(-1)).toBe('ROLLBACK');
  });
});

describe('createDatabase with a real pg.Pool (no server)', () => {
  it('check fails fast when nothing listens on the port, and close cleans up', async () => {
    const port = String(await freePort());
    const database = createDatabase(dbConfig({ DB_PORT: port }), logger());
    const error = await database.check().catch((e: unknown) => e);
    expect((error as DatabaseCheckError).meta).toEqual({ category: 'system', code: 'ECONNREFUSED' });
    await database.close();
    expect(database.stats().total).toBe(0);
  });
});

describe('helpers', () => {
  it('withTimeout resolves fast promises and rejects slow ones', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});
