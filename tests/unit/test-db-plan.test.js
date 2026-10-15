import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { generatePassword } from '../../scripts/lib/password.js';
import { formatTestCreds, MANAGED_COMMENT, planTestDbSetup, TEST_DB } from '../../scripts/lib/test-db-plan.js';

const managedRole = { exists: true, comment: MANAGED_COMMENT, memberships: 0 };
const managedDb = { exists: true, owner: TEST_DB.user, comment: MANAGED_COMMENT };
const missing = { exists: false };
const fullCreds = () => parseEnv(formatTestCreds({ host: '127.0.0.1', port: 5432, password: generatePassword() }));

test('fresh: create role + database, generate password, write credentials', () => {
  assert.deepEqual(planTestDbSetup({ role: missing, database: missing, creds: {} }), {
    actions: ['create-role', 'create-database', 'restrict-database'], password: 'generate', writeCreds: true,
  });
});

test('re-run with complete credentials: no rotation, no rewrite', () => {
  assert.deepEqual(planTestDbSetup({ role: managedRole, database: managedDb, creds: fullCreds() }), {
    actions: ['enforce-role-attributes', 'restrict-database'], password: 'file', writeCreds: false,
  });
});

test('existing role without stored password refuses silent rotation', () => {
  assert.throws(() => planTestDbSetup({ role: managedRole, database: managedDb, creds: {} }), /--rotate-password/);
  const r = planTestDbSetup({ role: managedRole, database: managedDb, creds: {}, rotatePassword: true });
  assert.deepEqual(r, { actions: ['enforce-role-attributes', 'set-password', 'restrict-database'], password: 'generate', writeCreds: true });
});

test('same-named foreign resources are never reused', () => {
  assert.throws(() => planTestDbSetup({ role: { exists: true, comment: null, memberships: 0 }, database: missing, creds: {} }), /not managed/);
  assert.throws(() => planTestDbSetup({ role: missing, database: { exists: true, owner: 'postgres', comment: MANAGED_COMMENT }, creds: {} }), /refusing/);
  assert.throws(() => planTestDbSetup({ role: missing, database: { exists: true, owner: TEST_DB.user, comment: 'other' }, creds: {} }), /refusing/);
});

test('role with memberships is refused (would break isolation)', () => {
  assert.throws(() => planTestDbSetup({ role: { ...managedRole, memberships: 1 }, database: managedDb, creds: fullCreds() }), /member of other roles/);
});

test('formatTestCreds writes exactly the TEST_DB_* keys and rejects unsafe values', () => {
  const pass = generatePassword();
  assert.deepEqual(parseEnv(formatTestCreds({ host: '127.0.0.1', port: 5432, password: pass })), {
    TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '5432', TEST_DB_NAME: 'node_control_test_db', TEST_DB_USER: 'node_control_test_user', TEST_DB_PASS: pass,
  });
  assert.throws(() => formatTestCreds({ host: '127.0.0.1', port: 5432, password: 'a b' }), /TEST_DB_PASS/);
});

test('resources with an earlier marker are refused unless the operator names that exact marker; then they are re-labelled', () => {
  const earlier = 'Earlier project marker (managed by scripts/setup-test-db.js)';
  const role = { exists: true, comment: earlier, memberships: 0 };
  const database = { exists: true, owner: TEST_DB.user, comment: earlier };
  const creds = { TEST_DB_PASS: 'x'.repeat(48) };
  assert.throws(() => planTestDbSetup({ role, database, creds }), /not managed by this project/);
  assert.throws(() => planTestDbSetup({ role, database, creds, previousComment: 'something else' }), /not managed by this project/);
  assert.throws(() => planTestDbSetup({ role, database, creds, previousComment: '' }), /not managed by this project/);
  assert.throws(() => planTestDbSetup({ role: managedRole, database: { ...database, owner: 'postgres' }, creds, previousComment: earlier }), /refusing/);
  const plan = planTestDbSetup({ role, database, creds, previousComment: earlier });
  assert.deepEqual(plan.actions, ['enforce-role-attributes', 'relabel-role', 'relabel-database', 'restrict-database']);
  // Already current marker: nothing to re-label.
  assert.ok(!planTestDbSetup({ role: managedRole, database: managedDb, creds, previousComment: earlier }).actions.some((a) => a.startsWith('relabel')));
});
