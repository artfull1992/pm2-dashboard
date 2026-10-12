import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { ENV_PATH } from '../../scripts/lib/config.js';
import { dbConfigFromEnv, readEnvFile } from '../../scripts/lib/env.js';

export const env = readEnvFile(ENV_PATH);

// Privileged checks (pg_authid, pg_hba.conf, systemd) need root on the PostgreSQL host.
// From a developer machine over an SSH tunnel they are skipped with this reason.
export const PRIVILEGED = process.getuid?.() === 0
  && existsSync('/etc/postgresql')
  && spawnSync('runuser', ['--version']).status === 0;
export const SKIP_UNPRIVILEGED = PRIVILEGED ? false : 'needs root on the PostgreSQL host';

export function newClient(overrides = {}) {
  return new pg.Client({ ...dbConfigFromEnv(env), connectionTimeoutMillis: 5000, ...overrides });
}

export async function withClient(fn, overrides) {
  const client = newClient(overrides);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Runs a read-only query as the postgres superuser via peer auth (server only).
export function superuserQuery(sql) {
  const result = spawnSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], {
    input: sql, encoding: 'utf8', cwd: '/tmp',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
