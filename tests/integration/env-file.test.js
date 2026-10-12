import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { ENV_PATH, PROJECT_ROOT } from '../../scripts/lib/config.js';
import { validateEnv } from '../../scripts/lib/env.js';
import { checkProject } from '../../scripts/lib/secrets.js';
import { env } from '../helpers/context.js';

test('#11 .env exists, is complete and has mode 600 owned by the current user', () => {
  assert.ok(existsSync(ENV_PATH), `${ENV_PATH} is missing`);
  assert.deepEqual(validateEnv(env), []);
  const stat = statSync(ENV_PATH);
  assert.equal((stat.mode & 0o777).toString(8), '600');
  assert.equal(stat.uid, process.getuid(), '.env must belong to the user running the app');
});

test('#12 .env is ignored and not tracked; no secrets in committable files', () => {
  const result = checkProject(PROJECT_ROOT);
  assert.equal(result.envIgnored, true, '.env is not ignored');
  assert.equal(result.envTracked, false, '.env is tracked by git');
  assert.deepEqual(result.findings, []);
});

test('db-check script connects and never prints the password', () => {
  const result = spawnSync(process.execPath, ['scripts/db-check.js'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK: SELECT 1 as node_control_user@/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(env.DB_PASS));
});
