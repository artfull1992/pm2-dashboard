import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, LIMITS, loadConfig, mergeEnv, readEnvFile } from '../src/config.js';
import { FAKE_SECRET } from './helpers.js';

const base = { DB_NAME: 'node_control_db', DB_USER: 'node_control_user', DB_PASS: FAKE_SECRET };
const dir = mkdtempSync(join(tmpdir(), 'nc-config-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function issuesOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('applies loopback and documented defaults', () => {
    const config = loadConfig(base);
    expect(config.nodeEnv).toBe('development');
    expect(config.api).toEqual({ host: '127.0.0.1', port: 3100 });
    expect(config.logLevel).toBe('info');
    expect(config.db).toMatchObject({ host: '127.0.0.1', port: 5432, database: 'node_control_db', user: 'node_control_user' });
  });

  it('uses bounded pool and timeouts', () => {
    const { db, readinessTimeoutMs, shutdownTimeoutMs } = loadConfig(base);
    expect(db.poolMax).toBe(LIMITS.poolMax);
    for (const ms of [db.connectionTimeoutMs, db.idleTimeoutMs, db.queryTimeoutMs, readinessTimeoutMs, shutdownTimeoutMs]) {
      expect(ms).toBeGreaterThan(0);
      expect(Number.isFinite(ms)).toBe(true);
    }
  });

  it('accepts explicit valid values', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production', API_HOST: 'localhost', API_PORT: '8081', LOG_LEVEL: 'warn', DB_HOST: '::1', DB_PORT: '15432' });
    expect(config).toMatchObject({ nodeEnv: 'production', api: { host: 'localhost', port: 8081 }, logLevel: 'warn' });
    expect(config.db).toMatchObject({ host: '::1', port: 15432 });
  });

  it('treats empty strings as unset for optional keys', () => {
    expect(loadConfig({ ...base, API_PORT: '', LOG_LEVEL: '' }).api.port).toBe(3100);
  });

  it.each([
    ['API_PORT', '0'], ['API_PORT', '65536'], ['API_PORT', 'abc'], ['API_PORT', '80.5'], ['API_PORT', '-1'],
    ['DB_PORT', '99999'], ['DB_PORT', ' 5432'],
  ])('rejects invalid port %s=%s', (key, value) => {
    expect(issuesOf({ ...base, [key]: value })).toEqual([`${key} must be an integer between 1 and 65535`]);
  });

  it.each([['NODE_ENV', 'staging'], ['LOG_LEVEL', 'verbose']])('rejects enum %s=%s', (key, value) => {
    expect(issuesOf({ ...base, [key]: value })[0]).toMatch(new RegExp(`^${key} must be one of: `));
  });

  it.each([['API_HOST', 'bad host'], ['DB_HOST', 'a;b'], ['API_HOST', '-leading.dash']])('rejects host %s=%s', (key, value) => {
    expect(issuesOf({ ...base, [key]: value })).toEqual([`${key} must be an IP address or hostname`]);
  });

  it('reports every missing required key at once', () => {
    expect(issuesOf({})).toEqual(['DB_NAME is required', 'DB_USER is required', 'DB_PASS is required']);
  });

  it('never includes values in error messages', () => {
    const env = { ...base, API_PORT: 'leak-port-value', LOG_LEVEL: FAKE_SECRET, DB_HOST: 'leak host' };
    let message = '';
    try { loadConfig(env); } catch (error) { message = (error as Error).message + JSON.stringify(error); }
    expect(message).toContain('API_PORT');
    expect(message).not.toContain('leak-port-value');
    expect(message).not.toContain(FAKE_SECRET);
    expect(message).not.toContain('leak host');
  });

  it('describeConfig exposes no database fields', () => {
    const summary = JSON.stringify(describeConfig(loadConfig(base)));
    expect(summary).not.toContain(FAKE_SECRET);
    expect(summary).not.toMatch(/node_control_(db|user)/);
  });
});

describe('environment sources', () => {
  it('process environment overrides .env values; undefined does not erase them', () => {
    const merged = mergeEnv({ API_PORT: '4000', DB_PASS: 'from-file', LOG_LEVEL: 'debug' }, { API_PORT: '5000', LOG_LEVEL: undefined });
    expect(merged).toEqual({ API_PORT: '5000', DB_PASS: 'from-file', LOG_LEVEL: 'debug' });
  });

  it('readEnvFile parses a given file and returns {} when it is missing', () => {
    const path = join(dir, 'test.env');
    writeFileSync(path, `# comment\nDB_NAME=x\nAPI_PORT=4100\n`);
    expect(readEnvFile(path)).toEqual({ DB_NAME: 'x', API_PORT: '4100' });
    expect(readEnvFile(join(dir, 'missing.env'))).toEqual({});
  });

  it('a value only in the file is used, an explicit process value wins', () => {
    const path = join(dir, 'precedence.env');
    writeFileSync(path, `DB_NAME=file_db\nDB_USER=file_user\nDB_PASS=${FAKE_SECRET}\nAPI_PORT=4200\n`);
    const config = loadConfig(mergeEnv(readEnvFile(path), { API_PORT: '4300' }));
    expect(config.api.port).toBe(4300);
    expect(config.db.database).toBe('file_db');
  });
});
