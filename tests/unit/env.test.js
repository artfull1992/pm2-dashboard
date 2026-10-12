import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DB_DEFAULTS } from '../../scripts/lib/config.js';
import { dbConfigFromEnv, formatEnv, readEnvFile, validateEnv, writeEnvFileAtomic } from '../../scripts/lib/env.js';
import { generatePassword } from '../../scripts/lib/password.js';

const dir = mkdtempSync(join(tmpdir(), 'nc-env-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const validEnv = () => ({ ...DB_DEFAULTS, DB_PASS: generatePassword() });

test('validateEnv accepts a complete env', () => {
  assert.deepEqual(validateEnv(validEnv()), []);
});

test('validateEnv reports missing keys, bad port and short password', () => {
  assert.equal(validateEnv({}).length, 5);
  assert.deepEqual(validateEnv({ ...validEnv(), DB_PORT: '99999' }), ['DB_PORT must be an integer between 1 and 65535']);
  assert.deepEqual(validateEnv({ ...validEnv(), DB_PORT: '54x' }), ['DB_PORT must be an integer between 1 and 65535']);
  assert.match(validateEnv({ ...validEnv(), DB_PASS: 'short' })[0], /at least 32/);
});

test('formatEnv writes the required keys in order and parses back', () => {
  const env = validEnv();
  const text = formatEnv({ ...env, EXTRA: 'ignored' });
  assert.deepEqual(text.trim().split('\n').map((l) => l.split('=')[0]), ['DB_NAME', 'DB_USER', 'DB_HOST', 'DB_PASS', 'DB_PORT']);
  const path = join(dir, 'roundtrip.env');
  writeFileSync(path, text);
  assert.deepEqual(readEnvFile(path), env);
});

test('formatEnv refuses values that would need quoting', () => {
  assert.throws(() => formatEnv({ ...validEnv(), DB_HOST: 'a b' }), TypeError);
  assert.throws(() => formatEnv({ ...validEnv(), DB_PASS: 'x\ny' }), TypeError);
});

test('readEnvFile returns {} for a missing file', () => {
  assert.deepEqual(readEnvFile(join(dir, 'missing.env')), {});
});

test('dbConfigFromEnv maps keys to pg options', () => {
  const env = validEnv();
  assert.deepEqual(dbConfigFromEnv(env), {
    host: '127.0.0.1', port: 5432, database: 'node_control_db', user: 'node_control_user', password: env.DB_PASS,
  });
});

test('writeEnvFileAtomic creates a 0600 file and replaces an existing one', () => {
  const path = join(dir, 'atomic.env');
  writeFileSync(path, 'OLD=1\n', { mode: 0o644 });
  writeEnvFileAtomic(path, 'NEW=1\n', { uid: process.getuid(), gid: process.getgid() });
  assert.equal(readFileSync(path, 'utf8'), 'NEW=1\n');
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('writeEnvFileAtomic leaves no temp file behind on failure', () => {
  const path = join(dir, 'no-such-dir', 'x.env');
  assert.throws(() => writeEnvFileAtomic(path, 'A=1\n'));
});
