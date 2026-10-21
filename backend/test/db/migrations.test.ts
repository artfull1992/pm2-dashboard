// Real PostgreSQL integration tests for migrations — ONLY against the isolated test database (TEST_DB_*).
// Each test works in its own per-run schema and drops only that schema afterwards.
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbConfig } from '../../src/config.js';
import { MIGRATIONS_TABLE, migrateUp, migrationStatus } from '../../src/migrations.js';
import {
  assertTestIdentity, connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig,
} from '../support/test-db.js';

const FAILING_DIR = join(import.meta.dirname, '..', 'fixtures', 'migrations-failing');
const USERS_MIGRATION = '1791900000000_create-users';
const AUTH_MIGRATION = '1791900000001_auth-foundation';
const ALL = [USERS_MIGRATION, AUTH_MIGRATION, '1791900000002_server-registry', '1791900000003_pm2-inventory', '1791900000004_process-control', '1791900000005_user-credential-version', '1791900000006_alerts', '1791900000007_alert-settings', '1791900000008_retire-server-memory', '1791900000009_access-grants'];

let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
});

afterAll(async () => {
  for (const schema of schemas) await dropRunSchema(admin, schema);
  await admin.end();
});

async function freshSchema(): Promise<string> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  return schema;
}

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connectTestClient(config);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const q = (schema: string, sql: string, values?: unknown[]) =>
  withClient(async (c) => {
    await c.query(`SET search_path TO "${schema}"`);
    return c.query(sql, values);
  });

describe('isolation', () => {
  it('session is the configured test identity, not production', async () => {
    await assertTestIdentity(admin, config);
    expect(config.database).not.toBe('node_control_db');
  });

  it('test role cannot connect to the production database', async () => {
    const client = new pg.Client({
      host: config.host, port: config.port, user: config.user, password: config.password,
      database: 'node_control_db', connectionTimeoutMillis: 5_000,
    });
    await expect(client.connect()).rejects.toMatchObject({ code: '42501' });
    await client.end().catch(() => undefined);
  });

  it('test role cannot create databases', async () => {
    await expect(admin.query(`CREATE DATABASE nc_test_forbidden_${String(Date.now())}`)).rejects.toMatchObject({ code: '42501' });
  });

  it('test role has no elevated attributes and no role memberships', async () => {
    const { rows } = await admin.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
              (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
              has_database_privilege(r.oid, 'node_control_db', 'CONNECT') AS prod_connect
         FROM pg_roles r WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, memberships: 0, prod_connect: false });
  });
});

describe('migrations on a clean schema', () => {
  let schema: string;

  beforeAll(async () => {
    schema = await freshSchema();
  });

  it('status before up: everything pending, nothing created', async () => {
    const status = await withClient((c) => migrationStatus(c, { schema }));
    expect(status).toEqual({ applied: [], pending: ALL, unknown: [] });
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1', [schema]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('up applies all migrations in order and records each once', async () => {
    await expect(withClient((c) => migrateUp(c, { schema }))).resolves.toEqual(ALL);
    const { rows } = await q(schema, `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
    expect(rows).toEqual(ALL.map((name) => ({ name })));
  });

  it('creates the expected users structure', async () => {
    const { rows: columns } = await admin.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'users' ORDER BY ordinal_position`, [schema],
    );
    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
      { column_name: 'email', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'password_hash', data_type: 'text', is_nullable: 'NO', column_default: null },
      { column_name: 'is_active', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()' },
      { column_name: 'role', data_type: 'text', is_nullable: 'NO', column_default: "'viewer'::text" },
      { column_name: 'credential_version', data_type: 'bigint', is_nullable: 'NO', column_default: '1' },
      { column_name: 'access_revision', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
    ]);
    const { rows: constraints } = await admin.query(
      // PostgreSQL 18 also records NOT NULL as pg_constraint rows (contype 'n'); those are covered by the column check above.
      `SELECT conname, contype FROM pg_constraint
        WHERE conrelid = format('%I.users', $1::text)::regclass AND contype <> 'n' ORDER BY conname`, [schema],
    );
    expect(constraints).toEqual([
      { conname: 'users_access_revision_nonnegative', contype: 'c' },
      { conname: 'users_credential_version_positive', contype: 'c' },
      { conname: 'users_email_format', contype: 'c' },
      { conname: 'users_email_key', contype: 'u' },
      { conname: 'users_email_normalized', contype: 'c' },
      { conname: 'users_password_hash_not_empty', contype: 'c' },
      { conname: 'users_pkey', contype: 'p' },
      { conname: 'users_role_valid', contype: 'c' },
    ]);
    const { rows: triggers } = await admin.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = format('%I.users', $1::text)::regclass AND NOT tgisinternal`, [schema],
    );
    expect(triggers).toEqual([{ tgname: 'users_set_updated_at' }]);
  });

  it('second up is a no-op and status shows nothing pending', async () => {
    await expect(withClient((c) => migrateUp(c, { schema }))).resolves.toEqual([]);
    await expect(withClient((c) => migrationStatus(c, { schema }))).resolves.toEqual({ applied: ALL, pending: [], unknown: [] });
    const { rows } = await q(schema, `SELECT count(*)::int AS n FROM ${MIGRATIONS_TABLE}`);
    expect(rows[0]).toEqual({ n: ALL.length });
  });

  it('defaults: uuid id, is_active=true, timestamps set; updated_at maintained by trigger', async () => {
    const inserted = await q(schema, `INSERT INTO users (email, password_hash) VALUES ('first@example.test', 'hash:x') RETURNING *`);
    const row = inserted.rows[0] as { id: string; is_active: boolean; created_at: Date; updated_at: Date };
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.is_active).toBe(true);
    expect(row.created_at).toBeInstanceOf(Date);
    const updated = await q(schema, `UPDATE users SET is_active = false WHERE id = $1 RETURNING created_at, updated_at`, [row.id]);
    const after = updated.rows[0] as { created_at: Date; updated_at: Date };
    expect(after.created_at.getTime()).toBe(row.created_at.getTime());
    expect(after.updated_at.getTime()).toBeGreaterThan(row.updated_at.getTime());
  });

  it('email policy: normalized form required, unique', async () => {
    await q(schema, `INSERT INTO users (email, password_hash) VALUES ('second@example.test', 'h')`);
    await expect(q(schema, `INSERT INTO users (email, password_hash) VALUES ('second@example.test', 'h')`)).rejects.toMatchObject({ code: '23505' });
    for (const email of ['Second@Example.test', ' second@example.test', 'SECOND@EXAMPLE.TEST']) {
      await expect(q(schema, 'INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, 'h'])).rejects.toMatchObject({ code: '23514' });
    }
    for (const email of ['no-at-sign', 'a@b@c', 'with space@x.y']) {
      await expect(q(schema, 'INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, 'h'])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('required fields: email and password_hash NOT NULL, empty hash rejected', async () => {
    await expect(q(schema, `INSERT INTO users (password_hash) VALUES ('h')`)).rejects.toMatchObject({ code: '23502' });
    await expect(q(schema, `INSERT INTO users (email) VALUES ('third@example.test')`)).rejects.toMatchObject({ code: '23502' });
    await expect(q(schema, `INSERT INTO users (email, password_hash) VALUES ('third@example.test', '')`)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('failure and concurrency', () => {
  it('a failing migration rolls back the whole run: no partial objects, no tracking rows', async () => {
    const schema = await freshSchema();
    await expect(withClient((c) => migrateUp(c, { schema, dir: FAILING_DIR }))).rejects.toThrow();
    const { rows: tables } = await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`, [schema]);
    // The tracking table is created before the migration transaction; it must hold no rows.
    expect(tables).toEqual([{ tablename: MIGRATIONS_TABLE }]);
    const { rows } = await q(schema, `SELECT count(*)::int AS n FROM ${MIGRATIONS_TABLE}`);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('concurrent up runs serialize on the advisory lock and apply the migration exactly once', async () => {
    const schema = await freshSchema();
    const results = await Promise.all([1, 2, 3].map(() => withClient((c) => migrateUp(c, { schema }))));
    expect(results.flat()).toEqual(ALL);
    expect(results.filter((r) => r.length > 0)).toHaveLength(1);
    const { rows } = await q(schema, `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`);
    expect(rows).toEqual(ALL.map((name) => ({ name })));
  });
});

describe('cleanup scope', () => {
  it('dropRunSchema removes only the given run schema', async () => {
    const a = await freshSchema();
    const b = await freshSchema();
    await dropRunSchema(admin, a);
    const { rows } = await admin.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1) ORDER BY nspname', [[a, b]]);
    expect(rows).toEqual([{ nspname: b }]);
    const { rows: pub } = await admin.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'public'`);
    expect(pub[0]).toEqual({ n: 1 });
  });
});
