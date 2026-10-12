import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDatabase, type PoolLike, TimeoutError, toSafeError, withTimeout } from '../src/database.js';
import { FAKE_SECRET, freePort } from './helpers.js';

const dbConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({ DB_NAME: 'node_control_db', DB_USER: 'node_control_user', DB_PASS: FAKE_SECRET, ...overrides }).db;

class FakePool extends EventEmitter implements PoolLike {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  query = vi.fn((_sql: string): Promise<unknown> => Promise.resolve({ rows: [{ '?column?': 1 }] }));
  end = vi.fn(() => Promise.resolve());
}

const logger = () => ({ error: vi.fn() });

describe('createDatabase with an injected pool', () => {
  it('check runs exactly SELECT 1', async () => {
    const pool = new FakePool();
    await createDatabase(dbConfig(), logger(), pool).check();
    expect(pool.query).toHaveBeenCalledExactlyOnceWith('SELECT 1');
  });

  it('check rejects with a sanitized cause on error', async () => {
    const pool = new FakePool();
    pool.query.mockRejectedValueOnce(Object.assign(new Error(`auth failed ${FAKE_SECRET}`), { code: '28P01' }));
    const error = await createDatabase(dbConfig(), logger(), pool).check().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Database check failed');
    expect((error as Error).cause).toEqual({ name: 'Error', code: '28P01', message: 'auth failed [REDACTED]' });
  });

  it('check times out when the query hangs', async () => {
    const pool = new FakePool();
    pool.query.mockReturnValueOnce(new Promise(() => undefined));
    const config = { ...dbConfig(), queryTimeoutMs: 30 };
    const error = await createDatabase(config, logger(), pool).check().catch((e: unknown) => e);
    expect((error as Error).cause).toMatchObject({ name: 'TimeoutError', code: 'ETIMEDOUT' });
  });

  it('pool errors are logged without credentials and do not throw', () => {
    const pool = new FakePool();
    const log = logger();
    createDatabase(dbConfig(), log, pool);
    expect(() => pool.emit('error', new Error(`terminating connection; password=${FAKE_SECRET}`))).not.toThrow();
    expect(log.error).toHaveBeenCalledOnce();
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

describe('createDatabase with a real pg.Pool (no server)', () => {
  it('check fails fast when nothing listens on the port, and close cleans up', async () => {
    const port = String(await freePort());
    const database = createDatabase(dbConfig({ DB_PORT: port }), logger());
    const error = await database.check().catch((e: unknown) => e);
    expect((error as Error).cause).toMatchObject({ code: 'ECONNREFUSED' });
    expect(JSON.stringify((error as Error).cause)).not.toContain(FAKE_SECRET);
    await database.close();
    expect(database.stats().total).toBe(0);
  });
});

describe('helpers', () => {
  it('withTimeout resolves fast promises and rejects slow ones', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('toSafeError handles non-Error values and drops non-string codes', () => {
    expect(toSafeError('boom')).toEqual({ name: 'Error', message: 'boom' });
    expect(toSafeError(Object.assign(new Error('x'), { code: 42 }))).toEqual({ name: 'Error', message: 'x' });
  });
});
