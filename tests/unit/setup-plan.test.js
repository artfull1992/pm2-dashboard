import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DB_DEFAULTS } from '../../scripts/lib/config.js';
import { generatePassword } from '../../scripts/lib/password.js';
import { planDatabaseSetup } from '../../scripts/lib/setup-plan.js';

const dbUser = DB_DEFAULTS.DB_USER;
const fullEnv = () => ({ ...DB_DEFAULTS, DB_PASS: generatePassword() });
const plan = (overrides) => planDatabaseSetup({
  role: { exists: false }, database: { exists: false }, env: {}, dbUser, ...overrides,
});

test('fresh install: create everything, generate password, write .env', () => {
  assert.deepEqual(plan({}), {
    actions: ['create-role', 'create-database', 'restrict-database'],
    password: 'generate',
    writeEnv: true,
  });
});

test('fresh role but .env already has a strong password: reuse it, do not rewrite .env', () => {
  assert.deepEqual(plan({ env: fullEnv() }), {
    actions: ['create-role', 'create-database', 'restrict-database'],
    password: 'env',
    writeEnv: false,
  });
});

test('re-run on configured system is a no-op apart from idempotent enforcement', () => {
  const result = plan({ role: { exists: true }, database: { exists: true, owner: dbUser }, env: fullEnv() });
  assert.deepEqual(result, { actions: ['enforce-role-attributes', 'restrict-database'], password: 'env', writeEnv: false });
});

test('existing role without .env password refuses instead of silently resetting it', () => {
  assert.throws(() => plan({ role: { exists: true } }), /--rotate-password/);
  assert.throws(() => plan({ role: { exists: true }, env: { ...fullEnv(), DB_PASS: 'short' } }), /--rotate-password/);
});

test('--rotate-password sets a new password and rewrites .env', () => {
  const result = plan({ role: { exists: true }, database: { exists: true, owner: dbUser }, env: fullEnv(), rotatePassword: true });
  assert.deepEqual(result, {
    actions: ['enforce-role-attributes', 'set-password', 'restrict-database'],
    password: 'generate',
    writeEnv: true,
  });
});

test('existing database with a foreign owner is never touched', () => {
  assert.throws(() => plan({ database: { exists: true, owner: 'secrets-manager' } }), /owned by "secrets-manager"/);
});

test('incomplete .env with a valid password is completed', () => {
  const { DB_PASS } = fullEnv();
  assert.equal(plan({ role: { exists: true }, database: { exists: true, owner: dbUser }, env: { DB_PASS } }).writeEnv, true);
});
