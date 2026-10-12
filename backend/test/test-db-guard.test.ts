import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertRunSchemaName, assertTestIdentity, dropRunSchema, newRunSchemaName, readTestDbEnv, TestDbConfigError, testDbConfig,
} from './support/test-db.js';

const SECRET = 'synthetic-test-db-pass-0123456789abcdef';
const valid = {
  TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '15432', TEST_DB_NAME: 'node_control_test_db', TEST_DB_USER: 'node_control_test_user', TEST_DB_PASS: SECRET,
};
const dir = mkdtempSync(join(tmpdir(), 'nc-testdb-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('testDbConfig', () => {
  it('accepts an explicit test identity', () => {
    expect(testDbConfig(valid)).toMatchObject({ host: '127.0.0.1', port: 15432, database: 'node_control_test_db', user: 'node_control_test_user' });
  });

  it('requires every TEST_DB_* key and never falls back to DB_*', () => {
    const env = { DB_HOST: 'h', DB_PORT: '5432', DB_NAME: 'node_control_db', DB_USER: 'node_control_user', DB_PASS: SECRET };
    expect(() => testDbConfig(env)).toThrow(/TEST_DB_HOST, TEST_DB_PORT, TEST_DB_NAME, TEST_DB_USER, TEST_DB_PASS/);
    expect(() => testDbConfig({ ...valid, TEST_DB_PASS: '' })).toThrow(/TEST_DB_PASS/);
  });

  it.each([
    ['TEST_DB_NAME', 'node_control_db'], ['TEST_DB_USER', 'node_control_user'],
    ['TEST_DB_NAME', 'postgres'], ['TEST_DB_USER', 'secrets-manager'],
  ])('rejects production identity %s=%s', (key, value) => {
    expect(() => testDbConfig({ ...valid, [key]: value })).toThrow(/production/);
  });

  it.each([['TEST_DB_NAME', 'node_control_db_copy'], ['TEST_DB_USER', 'tester'], ['TEST_DB_NAME', 'contest_db']])(
    'requires a "test" token: %s=%s',
    (key, value) => { expect(() => testDbConfig({ ...valid, [key]: value })).toThrow(/"test" token/); },
  );

  it('errors never include the password', () => {
    for (const env of [{ ...valid, TEST_DB_NAME: 'node_control_db' }, { ...valid, TEST_DB_PORT: 'x' }]) {
      try { testDbConfig(env); } catch (error) { expect(String(error)).not.toContain(SECRET); }
    }
  });
});

describe('readTestDbEnv', () => {
  it('reads only TEST_DB_* from the explicit file; process env wins', () => {
    const file = join(dir, 'test.env');
    writeFileSync(file, `TEST_DB_HOST=127.0.0.1\nTEST_DB_PORT=5432\nTEST_DB_NAME=node_control_test_db\nTEST_DB_USER=node_control_test_user\nTEST_DB_PASS=${SECRET}\nDB_PASS=ignored\n`);
    const env = readTestDbEnv({ TEST_DB_ENV_FILE: file, TEST_DB_PORT: '15432', DB_NAME: 'node_control_db' });
    expect(env).toEqual({ ...valid });
    expect(env).not.toHaveProperty('DB_PASS');
  });

  it('without TEST_DB_ENV_FILE nothing is read from disk', () => {
    expect(readTestDbEnv({ DB_PASS: SECRET })).toEqual({
      TEST_DB_HOST: undefined, TEST_DB_PORT: undefined, TEST_DB_NAME: undefined, TEST_DB_USER: undefined, TEST_DB_PASS: undefined,
    });
  });

  it('a missing explicit file is an error', () => {
    expect(() => readTestDbEnv({ TEST_DB_ENV_FILE: join(dir, 'nope.env') })).toThrow(TestDbConfigError);
  });
});

describe('identity and cleanup scope', () => {
  const config = testDbConfig(valid);
  const fakeClient = (db: string, usr: string) => ({ query: () => Promise.resolve({ rows: [{ db, usr }] }) }) as never;

  it('assertTestIdentity passes only for the configured database and user', async () => {
    await expect(assertTestIdentity(fakeClient('node_control_test_db', 'node_control_test_user'), config)).resolves.toBeUndefined();
    await expect(assertTestIdentity(fakeClient('node_control_db', 'node_control_test_user'), config)).rejects.toThrow(/identity/);
    await expect(assertTestIdentity(fakeClient('node_control_test_db', 'node_control_user'), config)).rejects.toThrow(/identity/);
  });

  it('run schema names are unique and well-formed', () => {
    const a = newRunSchemaName();
    expect(assertRunSchemaName(a)).toBe(a);
    expect(newRunSchemaName()).not.toBe(a);
  });

  it.each(['public', 'pg_catalog', 'nc_test_1', 'nc_test_1234567890123_zzzzzzzz', 'nc_test_1234567890123_abcd1234"; DROP SCHEMA public; --', ''])(
    'refuses to drop %j',
    async (schema) => {
      const queries: string[] = [];
      const client = { query: (sql: string) => { queries.push(sql); return Promise.resolve({ rows: [] }); } } as never;
      await expect(dropRunSchema(client, schema)).rejects.toThrow(TestDbConfigError);
      expect(queries).toEqual([]);
    },
  );

  it('drops exactly the given run schema', async () => {
    const queries: string[] = [];
    const client = { query: (sql: string) => { queries.push(sql); return Promise.resolve({ rows: [] }); } } as never;
    await dropRunSchema(client, 'nc_test_1791900000000_abcdef12');
    expect(queries).toEqual(['DROP SCHEMA IF EXISTS "nc_test_1791900000000_abcdef12" CASCADE']);
  });
});
