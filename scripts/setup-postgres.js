#!/usr/bin/env node
// Idempotent PostgreSQL setup for Node Control. Run on the DB host as root:
//   npm run db:setup -- [--env-owner <user>] [--rotate-password] [--skip-hba]
// Never prints the password; only a SCRAM verifier is ever sent to PostgreSQL.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DB_DEFAULTS, ENV_PATH, HBA_RULE, HBA_RULE_COMMENT } from './lib/config.js';
import { formatEnv, readEnvFile, writeEnvFileAtomic } from './lib/env.js';
import { generatePassword } from './lib/password.js';
import { ensureRule } from './lib/pg-hba.js';
import { redactScramVerifiers, scramVerifier } from './lib/scram.js';
import { planDatabaseSetup } from './lib/setup-plan.js';
import {
  createDatabaseSql,
  createRoleSql,
  enforceRoleAttributesSql,
  quoteLiteral,
  restrictDatabaseSql,
  setRolePasswordSql,
} from './lib/sql.js';

const { values: options } = parseArgs({
  options: {
    'env-owner': { type: 'string', default: 'root' },
    'rotate-password': { type: 'boolean', default: false },
    'skip-hba': { type: 'boolean', default: false },
  },
});

const log = (message) => console.log(`[db:setup] ${message}`);

function psql(sql, database = 'postgres') {
  // SQL goes through stdin, never argv, so it is not visible in the process list.
  const result = spawnSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', database], {
    input: sql,
    encoding: 'utf8',
    cwd: '/tmp',
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${redactScramVerifiers(result.stderr || result.error?.message).trim()}`);
  }
  return result.stdout.trim();
}

function resolveOwner(user) {
  const id = (flag) => {
    const result = spawnSync('id', [flag, user], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Unknown --env-owner user: ${user}`);
    return Number(result.stdout.trim());
  };
  return { uid: id('-u'), gid: id('-g') };
}

function setupHba() {
  const hbaFile = psql('SHOW hba_file;');
  const ssl = psql('SHOW ssl;');
  if (ssl !== 'on') log('WARNING: ssl is off — the hostssl rule will not accept connections until TLS is configured.');

  const original = readFileSync(hbaFile, 'utf8');
  const { text, changed } = ensureRule(original, HBA_RULE, HBA_RULE_COMMENT);
  if (!changed) {
    log(`pg_hba.conf already contains the scoped hostssl rule (${hbaFile})`);
    return;
  }

  const backup = `${hbaFile}.backup-node-control-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(hbaFile, backup);
  chmodSync(backup, 0o640);
  log(`Backed up pg_hba.conf → ${backup}`);
  writeFileSync(hbaFile, text); // keeps existing owner and mode

  // pg_hba_file_rules parses the file on disk, so this validates before anything is reloaded.
  const errors = Number(psql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;'));
  const present = Number(psql(
    `SELECT count(*) FROM pg_hba_file_rules WHERE type = 'hostssl' AND database = ARRAY[${quoteLiteral(HBA_RULE.database)}]
       AND user_name = ARRAY[${quoteLiteral(HBA_RULE.user)}] AND auth_method = 'scram-sha-256';`,
  ));
  if (errors !== 0 || present !== 1) {
    writeFileSync(hbaFile, original);
    throw new Error(`pg_hba.conf validation failed (errors=${errors}, rule=${present}); original restored, nothing reloaded.`);
  }

  psql('SELECT pg_reload_conf();');
  log('pg_hba.conf validated and configuration reloaded (no restart).');
}

function main() {
  if (process.getuid?.() !== 0) throw new Error('Run as root on the PostgreSQL host (needs runuser postgres and pg_hba.conf access).');

  const { DB_NAME: dbName, DB_USER: dbUser } = DB_DEFAULTS;
  const env = readEnvFile(ENV_PATH);
  for (const key of ['DB_NAME', 'DB_USER']) {
    if (env[key] && env[key] !== DB_DEFAULTS[key]) throw new Error(`.env ${key} differs from expected ${DB_DEFAULTS[key]}`);
  }

  const role = { exists: psql(`SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(dbUser)};`) === '1' };
  const owner = psql(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = ${quoteLiteral(dbName)};`);
  const database = { exists: owner !== '', owner: owner || undefined };

  const plan = planDatabaseSetup({ role, database, env, dbUser, rotatePassword: options['rotate-password'] });
  log(`Role ${role.exists ? 'exists' : 'missing'}, database ${database.exists ? 'exists' : 'missing'}; actions: ${plan.actions.join(', ')}`);

  const password = plan.password === 'generate' ? generatePassword() : env.DB_PASS;

  // .env is written before the role/password changes, so a generated password is never lost.
  if (plan.writeEnv) {
    writeEnvFileAtomic(ENV_PATH, formatEnv({ ...DB_DEFAULTS, ...env, DB_PASS: password }), resolveOwner(options['env-owner']));
    log(`Wrote ${ENV_PATH} (mode 600, owner ${options['env-owner']})`);
  }

  for (const action of plan.actions) {
    switch (action) {
      case 'create-role': psql(createRoleSql(dbUser, scramVerifier(password))); break;
      case 'set-password': psql(setRolePasswordSql(dbUser, scramVerifier(password))); break;
      case 'enforce-role-attributes': psql(enforceRoleAttributesSql(dbUser)); break;
      case 'create-database': psql(createDatabaseSql(dbName, dbUser)); break;
      case 'restrict-database': psql(restrictDatabaseSql(dbName, dbUser)); break;
      default: throw new Error(`Unknown action ${action}`);
    }
    log(`✓ ${action}`);
  }

  if (options['skip-hba']) log('Skipping pg_hba.conf (--skip-hba)');
  else setupHba();

  log('Done.');
}

try {
  main();
} catch (error) {
  console.error(`[db:setup] ERROR: ${redactScramVerifiers(error.message)}`);
  process.exit(1);
}
