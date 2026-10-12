// Opt-in integration test against a real PostgreSQL: `npm run test:backend:db`.
// Uses ONLY explicit TEST_DB_* (see support/test-db.ts) — never DB_* or the root .env; production identities are rejected.
// Read-only: the sole statement executed is SELECT 1 (via the readiness endpoint). No DDL/DML.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase, type Database } from '../../src/database.js';
import { captureLogs } from '../helpers.js';
import { readTestDbEnv, testDbConfig } from '../support/test-db.js';

describe('real PostgreSQL readiness', () => {
  it('GET /health/ready is 200 via SELECT 1 and the pool is fully closed afterwards', async () => {
    const db = testDbConfig(readTestDbEnv());
    const config = { db, readinessTimeoutMs: 2_500 };
    const logs = captureLogs();
    let database: Database | undefined;
    const app = buildApp({
      logLevel: 'info',
      readinessTimeoutMs: config.readinessTimeoutMs,
      createDatabase: (log) => (database = createDatabase(config.db, log)),
      logStream: logs.stream,
    });

    try {
      const res = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode, logs.text()).toBe(200);
      expect(res.json()).toEqual({ status: 'ready' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(database?.stats().total).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }

    expect(database?.stats()).toEqual({ total: 0, idle: 0, waiting: 0 });
    expect(logs.text()).not.toContain(config.db.password);
  });
});
