import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { DB_DEFAULTS, HBA_RULE } from '../../scripts/lib/config.js';
import { hasRule, parseHba, rulesForDatabase, scopedRuleErrors } from '../../scripts/lib/pg-hba.js';
import { env, newClient, PRIVILEGED, SKIP_UNPRIVILEGED, superuserQuery, withClient } from '../helpers/context.js';

const { DB_NAME, DB_USER } = DB_DEFAULTS;

describe('connection', () => {
  test('#1 PostgreSQL is reachable', async () => {
    const client = newClient();
    await client.connect();
    await client.end();
  });

  test('#7 #8 connection from .env works and SELECT 1 returns 1', async () => {
    const row = await withClient(async (c) => (await c.query('SELECT 1 AS one, current_user, current_database()')).rows[0]);
    assert.deepEqual(row, { one: 1, current_user: env.DB_USER, current_database: env.DB_NAME });
  });

  test('#13 server authenticates node_control_user with SCRAM-SHA-256', async () => {
    const client = newClient();
    let mechanisms;
    client.connection.once('authenticationSASL', (msg) => { mechanisms = msg.mechanisms; });
    await client.connect();
    const { rows: [{ password_encryption }] } = await client.query('SHOW password_encryption');
    await client.end();
    assert.ok(mechanisms?.includes('SCRAM-SHA-256'), `server did not request SCRAM (got ${mechanisms})`);
    assert.equal(password_encryption, 'scram-sha-256');
  });
});

describe('catalog', () => {
  test('#2 database node_control_db exists and is owned by node_control_user', async () => {
    const { rows } = await withClient((c) => c.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [DB_NAME]));
    assert.deepEqual(rows, [{ owner: DB_USER }]);
  });

  test('#3–#6 role exists without SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS', async () => {
    const { rows } = await withClient((c) => c.query(
      'SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [DB_USER],
    ));
    assert.equal(rows.length, 1, 'role is missing');
    assert.deepEqual(rows[0], {
      rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
    });
  });

  test('other roles (PUBLIC) cannot connect to node_control_db', async () => {
    const { rows } = await withClient((c) => c.query(
      `SELECT r.rolname FROM pg_roles r
        WHERE r.rolname NOT IN ($2, 'postgres') AND r.rolname !~ '^pg_' AND NOT r.rolsuper
          AND has_database_privilege(r.oid, (SELECT oid FROM pg_database WHERE datname = $1), 'CONNECT')`,
      [DB_NAME, DB_USER],
    ));
    assert.deepEqual(rows, []);
  });
});

describe('privileges', () => {
  // Read-only since Task 004: this suite targets the production database from .env, so it must not run DDL/DML.
  // The write-path checks (create/use/drop objects, CREATE DATABASE refused) run against the isolated test DB in
  // backend/test/db/migrations.test.ts (TEST_DB_*), which proves the same privilege model without touching production.
  test('#9 user may create objects in its own database (privilege check, read-only)', async () => {
    const row = await withClient(async (c) => (await c.query(
      `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
              has_schema_privilege(current_user, 'public', 'CREATE') AS public_create,
              pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname = current_database())) = current_user AS is_owner`,
    )).rows[0]);
    assert.deepEqual(row, { db_create: true, public_create: true, is_owner: true });
  });

  test('#10 user cannot create other databases (rolcreatedb, read-only)', async () => {
    const row = await withClient(async (c) => (await c.query(
      'SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user',
    )).rows[0]);
    assert.deepEqual(row, { rolcreatedb: false, rolsuper: false });
  });
});

describe('server configuration', { skip: SKIP_UNPRIVILEGED }, () => {
  test('#13 stored password is a SCRAM-SHA-256 verifier', () => {
    assert.equal(superuserQuery(`SELECT rolpassword ~ '^SCRAM-SHA-256\\$' FROM pg_authid WHERE rolname = '${DB_USER}'`), 't');
  });

  test('#14 pg_hba.conf: only a scoped hostssl+scram rule mentions node_control_db', () => {
    const hbaFile = superuserQuery('SHOW hba_file');
    const rules = parseHba(readFileSync(hbaFile, 'utf8'));
    assert.ok(hasRule(readFileSync(hbaFile, 'utf8'), HBA_RULE), 'project rule missing');
    const own = rulesForDatabase(rules, DB_NAME);
    assert.ok(own.length > 0);
    for (const rule of own) {
      assert.deepEqual(scopedRuleErrors(rule), [], `line ${rule.line}`);
      assert.equal(rule.user, DB_USER, `line ${rule.line}`);
    }
    // The rule is active in the running server, not just on disk.
    const loaded = superuserQuery(
      `SELECT count(*) FROM pg_hba_file_rules WHERE type = 'hostssl' AND database = ARRAY['${DB_NAME}']
         AND user_name = ARRAY['${DB_USER}'] AND auth_method = 'scram-sha-256' AND error IS NULL`,
    );
    assert.equal(loaded, '1');
  });

  test('#15 PostgreSQL is healthy after configuration changes', () => {
    assert.equal(superuserQuery('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL'), '0');
    const cluster = superuserQuery('SHOW cluster_name').replace('/', '-');
    const unit = spawnSync('systemctl', ['is-active', `postgresql@${cluster}`], { encoding: 'utf8' });
    assert.equal(unit.stdout.trim(), 'active');
    const ready = spawnSync('pg_isready', ['-h', env.DB_HOST, '-p', env.DB_PORT], { encoding: 'utf8' });
    assert.equal(ready.status, 0, ready.stdout);
  });
});

test('#15 PostgreSQL accepts new connections (any host)', async () => {
  const rows = await withClient(async (c) => (await c.query('SELECT pg_is_in_recovery() AS recovery')).rows);
  assert.deepEqual(rows, [{ recovery: false }]);
  if (!PRIVILEGED) console.log('# privileged server checks skipped: run `npm run check` on the server as well');
});
