// Opt-in integration test against a real PostgreSQL: `npm run test:backend:db`.
// Uses ONLY explicit TEST_DB_* variables — never falls back to the root .env.
// Read-only: the sole statement executed is SELECT 1 (via the readiness endpoint). No DDL/DML.
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDatabase, type Database } from '../../src/database.js';
import { captureLogs } from '../helpers.js';

const REQUIRED = ['TEST_DB_HOST', 'TEST_DB_PORT', 'TEST_DB_NAME', 'TEST_DB_USER', 'TEST_DB_PASS'] as const;

function testDbConfig() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Real-DB test needs explicit ${missing.join(', ')} (see README "Backend: перевірка з реальною PostgreSQL")`);
  }
  return loadConfig({
    DB_HOST: process.env.TEST_DB_HOST,
    DB_PORT: process.env.TEST_DB_PORT,
    DB_NAME: process.env.TEST_DB_NAME,
    DB_USER: process.env.TEST_DB_USER,
    DB_PASS: process.env.TEST_DB_PASS,
  });
}

describe('real PostgreSQL readiness', () => {
  it('GET /health/ready is 200 via SELECT 1 and the pool is fully closed afterwards', async () => {
    const config = testDbConfig();
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
