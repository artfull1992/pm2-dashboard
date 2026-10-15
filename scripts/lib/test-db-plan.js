// Pure decision logic for scripts/setup-test-db.js (unit-tested). Mirrors setup-plan.js for the test database.

import { MIN_PASSWORD_LENGTH } from './password.js';

export const TEST_DB = Object.freeze({ database: 'node_control_test_db', user: 'node_control_test_user' });
// Marks resources created by this project so that same-named foreign resources are never reused.
export const MANAGED_COMMENT = 'Node Control isolated test resource (managed by scripts/setup-test-db.js)';
export const TEST_ENV_KEYS = Object.freeze(['TEST_DB_HOST', 'TEST_DB_PORT', 'TEST_DB_NAME', 'TEST_DB_USER', 'TEST_DB_PASS']);

/**
 * state.role:     { exists, comment, memberships }   state.database: { exists, owner, comment }
 * state.creds:    parsed credentials file ({} if absent)
 * previousComment: optional, given explicitly by the operator — the exact marker an earlier version of this project
 *                  wrote; resources carrying it are adopted and re-labelled with MANAGED_COMMENT (never guessed).
 */
export function planTestDbSetup({ role, database, creds, rotatePassword = false, previousComment = null }) {
  const managed = (comment) => comment === MANAGED_COMMENT || (previousComment !== null && previousComment !== '' && comment === previousComment);
  if (role.exists && !managed(role.comment)) {
    throw new Error(`role ${TEST_DB.user} exists but is not managed by this project; refusing to reuse it`);
  }
  if (database.exists && (!managed(database.comment) || database.owner !== TEST_DB.user)) {
    throw new Error(`database ${TEST_DB.database} exists but is not a managed test database owned by ${TEST_DB.user}; refusing`);
  }
  if (role.exists && role.memberships > 0) {
    throw new Error(`role ${TEST_DB.user} is a member of other roles; refusing (isolation)`);
  }

  const credsPasswordUsable = typeof creds.TEST_DB_PASS === 'string' && creds.TEST_DB_PASS.length >= MIN_PASSWORD_LENGTH;
  let password;
  if (rotatePassword) password = 'generate';
  else if (role.exists) {
    if (!credsPasswordUsable) throw new Error('test role exists but the credentials file has no usable TEST_DB_PASS; re-run with --rotate-password');
    password = 'file';
  } else password = credsPasswordUsable ? 'file' : 'generate';

  const actions = [];
  if (!role.exists) actions.push('create-role');
  else {
    actions.push('enforce-role-attributes');
    if (rotatePassword) actions.push('set-password');
  }
  if (role.exists && role.comment !== MANAGED_COMMENT) actions.push('relabel-role');
  if (!database.exists) actions.push('create-database');
  else if (database.comment !== MANAGED_COMMENT) actions.push('relabel-database');
  actions.push('restrict-database');

  const credsComplete = TEST_ENV_KEYS.every((key) => creds[key]);
  return { actions, password, writeCreds: password === 'generate' || !credsComplete };
}

export function formatTestCreds({ host, port, password }) {
  const values = { TEST_DB_HOST: host, TEST_DB_PORT: String(port), TEST_DB_NAME: TEST_DB.database, TEST_DB_USER: TEST_DB.user, TEST_DB_PASS: password };
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(value)) throw new TypeError(`${key} contains characters that need quoting`);
  }
  return `# Node Control — isolated test DB credentials. Never commit, never copy into api.env.\n${
    TEST_ENV_KEYS.map((key) => `${key}=${values[key]}`).join('\n')}\n`;
}
