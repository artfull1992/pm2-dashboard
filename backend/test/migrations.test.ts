import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrateCli } from '../src/migrate-cli.js';
import { assertSchemaName, DEFAULT_MIGRATIONS_DIR, listMigrations, migrationStatus } from '../src/migrations.js';
import { FAKE_SECRET, freePort } from './helpers.js';

const USERS = '1791900000000_create-users';
const AUTH = '1791900000001_auth-foundation';
const SERVERS = '1791900000002_server-registry';
const INVENTORY = '1791900000003_pm2-inventory';
const CONTROL = '1791900000004_process-control';
const USER_ADMIN = '1791900000005_user-credential-version';
const ALERTS = '1791900000006_alerts';
const dir = mkdtempSync(join(tmpdir(), 'nc-migr-'));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const dbEnv = { DB_NAME: 'n_db', DB_USER: 'n_user', DB_PASS: FAKE_SECRET };

function io(env: Record<string, string> = dbEnv) {
  let out = '';
  let err = '';
  return {
    io: { env, stdout: { write: (c: string) => { out += c; } }, stderr: { write: (c: string) => { err += c; } } },
    out: () => out,
    err: () => err,
  };
}

/** Minimal pg.Client double: answers the two status queries. */
function fakeClient(applied: string[] | null, failOn?: string) {
  const ended: boolean[] = [];
  const client = {
    connect: () => Promise.resolve(),
    end: () => { ended.push(true); return Promise.resolve(); },
    query: (sql: string) => {
      if (failOn && sql.includes(failOn)) {
        return Promise.reject(Object.assign(new Error(`relation secret ${FAKE_SECRET}`), { code: 'ECONNRESET' }));
      }
      if (sql.includes('to_regclass')) return Promise.resolve({ rows: [{ exists: applied !== null }] });
      return Promise.resolve({ rows: (applied ?? []).map((name) => ({ name })) });
    },
  };
  return { client: client as unknown as pg.Client, ended };
}

describe('migration files', () => {
  it('the packaged directory holds only well-formed SQL migrations, in order', () => {
    const names = listMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(names).toEqual([USERS, AUTH, SERVERS, INVENTORY, CONTROL, USER_ADMIN, ALERTS]);
    expect([...names].sort()).toEqual(names);
  });

  it('rejects unexpected files', () => {
    const bad = mkdtempSync(join(dir, 'bad-'));
    writeFileSync(join(bad, 'notes.md'), '');
    expect(() => listMigrations(bad)).toThrow(/unexpected file/);
  });

  it.each(['public', 'nc_test_1_abc'])('accepts schema %s', (schema) => { expect(assertSchemaName(schema)).toBe(schema); });
  it.each(['Public', 'a-b', 'x"; drop', ''])('rejects schema %j', (schema) => { expect(() => assertSchemaName(schema)).toThrow(TypeError); });
});

describe('migrationStatus (read-only)', () => {
  it('no tracking table → everything pending, nothing created', async () => {
    const { client } = fakeClient(null);
    await expect(migrationStatus(client)).resolves.toEqual({ applied: [], pending: [USERS, AUTH, SERVERS, INVENTORY, CONTROL, USER_ADMIN, ALERTS], unknown: [] });
  });

  it('reports applied and unknown migrations', async () => {
    const { client } = fakeClient([USERS, '1799999999999_from-newer-release']);
    await expect(migrationStatus(client)).resolves.toEqual({
      applied: [USERS, '1799999999999_from-newer-release'],
      pending: [AUTH, SERVERS, INVENTORY, CONTROL, USER_ADMIN, ALERTS],
      unknown: ['1799999999999_from-newer-release'],
    });
  });
});

describe('runMigrateCli', () => {
  it.each([[[]], [['down']], [['reset']], [['up', 'extra']]])('rejects %j with usage and exit 2', async (argv) => {
    const t = io();
    await expect(runMigrateCli(argv, t.io)).resolves.toBe(2);
    expect(t.err()).toContain('usage: migrate.js <status|up>');
  });

  it('invalid configuration → exit 1, keys only', async () => {
    const t = io({ DB_PASS: FAKE_SECRET, DB_PORT: 'x' });
    await expect(runMigrateCli(['status'], t.io)).resolves.toBe(1);
    expect(t.err()).toContain('DB_NAME is required');
    expect(t.err()).not.toContain(FAKE_SECRET);
  });

  it('status prints counts and names, closes the client', async () => {
    const t = io();
    const { client, ended } = fakeClient(null);
    await expect(runMigrateCli(['status'], { ...t.io, createClient: () => client })).resolves.toBe(0);
    expect(t.out()).toContain('target n_user@127.0.0.1:5432/n_db: applied=0 pending=7 unknown=0');
    expect(t.out()).toContain('pending  1791900000000_create-users');
    expect(t.out() + t.err()).not.toContain(FAKE_SECRET);
    expect(ended).toEqual([true]);
  });

  it('query failure → exit 1 with metadata only, client closed', async () => {
    const t = io();
    const { client, ended } = fakeClient([], 'to_regclass');
    await expect(runMigrateCli(['status'], { ...t.io, createClient: () => client })).resolves.toBe(1);
    expect(t.err()).toBe('[migrate] status failed (category=system code=ECONNRESET); nothing was committed by a failed up\n');
    expect(ended).toEqual([true]);
  });

  it('real connection refused → exit 1 quickly, no secret', async () => {
    const t = io({ ...dbEnv, DB_PORT: String(await freePort()) });
    const started = Date.now();
    await expect(runMigrateCli(['up'], t.io)).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(t.err()).toContain('code=ECONNREFUSED');
    expect(t.err()).not.toContain(FAKE_SECRET);
  });
});
