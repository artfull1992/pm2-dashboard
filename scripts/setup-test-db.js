#!/usr/bin/env node
// Idempotent creation of the ISOLATED test database and role on the PostgreSQL host. Run as root:
//   node scripts/setup-test-db.js [--credentials /root/.config/goit-node-control/test-db.env] [--rotate-password]
// Creates only node_control_test_db / node_control_test_user. Never touches production roles, databases,
// HBA or server settings. The password is generated here, stored in a 600 file and sent to PostgreSQL
// only as a SCRAM verifier through psql stdin.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { writeEnvFileAtomic } from './lib/env.js';
import { generatePassword } from './lib/password.js';
import { redactScramVerifiers, scramVerifier } from './lib/scram.js';
import {
  createDatabaseSql, createRoleSql, enforceRoleAttributesSql, quoteIdent, quoteLiteral, restrictDatabaseSql, setRolePasswordSql,
} from './lib/sql.js';
import { formatTestCreds, MANAGED_COMMENT, planTestDbSetup, TEST_DB } from './lib/test-db-plan.js';

const { values: options } = parseArgs({
  options: {
    credentials: { type: 'string', default: '/root/.config/goit-node-control/test-db.env' },
    'rotate-password': { type: 'boolean', default: false },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '5432' },
  },
});
const PRODUCTION_DB = 'node_control_db';
const log = (message) => console.log(`[test-db:setup] ${message}`);

function psql(sql, database = 'postgres') {
  const result = spawnSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', database], {
    input: sql, encoding: 'utf8', cwd: '/tmp',
  });
  if (result.status !== 0) throw new Error(`psql failed: ${redactScramVerifiers(result.stderr || result.error?.message).trim()}`);
  return result.stdout.trim();
}

function main() {
  if (process.getuid?.() !== 0) throw new Error('run as root on the PostgreSQL host');
  const creds = existsSync(options.credentials) ? parseEnv(readFileSync(options.credentials, 'utf8')) : {};

  const roleRow = psql(`SELECT coalesce(shobj_description(oid, 'pg_authid'), '') || '|' ||
      (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE rolname = ${quoteLiteral(TEST_DB.user)};`);
  const [roleComment, memberships] = roleRow === '' ? [] : roleRow.split('|');
  const role = { exists: roleRow !== '', comment: roleComment || null, memberships: Number(memberships ?? 0) };
  const dbRow = psql(`SELECT pg_get_userbyid(datdba) || '|' || coalesce(shobj_description(oid, 'pg_database'), '')
      FROM pg_database WHERE datname = ${quoteLiteral(TEST_DB.database)};`);
  const [dbOwner, dbComment] = dbRow === '' ? [] : dbRow.split('|');
  const database = { exists: dbRow !== '', owner: dbOwner, comment: dbComment || null };

  const plan = planTestDbSetup({ role, database, creds, rotatePassword: options['rotate-password'] });
  log(`role ${role.exists ? 'exists' : 'missing'}, database ${database.exists ? 'exists' : 'missing'}; actions: ${plan.actions.join(', ')}`);
  const password = plan.password === 'generate' ? generatePassword() : creds.TEST_DB_PASS;

  if (plan.writeCreds) {
    mkdirSync(dirname(options.credentials), { recursive: true, mode: 0o700 });
    chmodSync(dirname(options.credentials), 0o700);
    writeEnvFileAtomic(options.credentials, formatTestCreds({ host: options.host, port: options.port, password }), { uid: 0, gid: 0 });
    log(`wrote ${options.credentials} (mode 600, root)`);
  }

  const managed = quoteLiteral(MANAGED_COMMENT);
  for (const action of plan.actions) {
    switch (action) {
      case 'create-role':
        psql(`${createRoleSql(TEST_DB.user, scramVerifier(password))}\nCOMMENT ON ROLE ${quoteIdent(TEST_DB.user)} IS ${managed};`);
        break;
      case 'set-password': psql(setRolePasswordSql(TEST_DB.user, scramVerifier(password))); break;
      case 'enforce-role-attributes': psql(enforceRoleAttributesSql(TEST_DB.user)); break;
      case 'create-database':
        psql(createDatabaseSql(TEST_DB.database, TEST_DB.user));
        psql(`COMMENT ON DATABASE ${quoteIdent(TEST_DB.database)} IS ${managed};`);
        break;
      case 'restrict-database': psql(restrictDatabaseSql(TEST_DB.database, TEST_DB.user)); break;
      default: throw new Error(`unknown action ${action}`);
    }
    log(`✓ ${action}`);
  }

  // Isolation checks; production objects are only read, never changed.
  const prodConnect = psql(`SELECT has_database_privilege(${quoteLiteral(TEST_DB.user)}, ${quoteLiteral(PRODUCTION_DB)}, 'CONNECT');`);
  if (prodConnect !== 'f') throw new Error('isolation check failed: test role can CONNECT to the production database');
  const attrs = psql(`SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = ${quoteLiteral(TEST_DB.user)};`);
  if (attrs !== 'f') throw new Error('isolation check failed: test role has elevated attributes');
  log('isolation checks passed (no production CONNECT, no elevated attributes)');
  log('done');
}

try {
  main();
} catch (error) {
  console.error(`[test-db:setup] ERROR: ${redactScramVerifiers(error.message)}`);
  process.exit(1);
}
