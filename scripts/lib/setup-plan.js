import { validateEnv } from './env.js';
import { MIN_PASSWORD_LENGTH } from './password.js';

// Decides what setup-postgres must do, from the observed state. Pure, so every branch is unit-tested.
//   state.role:      { exists: boolean }
//   state.database:  { exists: boolean, owner?: string }
//   state.env:       current .env contents ({} if absent)
export function planDatabaseSetup({ role, database, env, dbUser, rotatePassword = false }) {
  const actions = [];
  const envPasswordUsable = typeof env.DB_PASS === 'string' && env.DB_PASS.length >= MIN_PASSWORD_LENGTH;

  let password;
  if (rotatePassword) {
    password = 'generate';
  } else if (role.exists) {
    if (!envPasswordUsable) {
      throw new Error('Role already exists but .env has no usable DB_PASS; refusing to overwrite the password silently. Re-run with --rotate-password.');
    }
    password = 'env';
  } else {
    password = envPasswordUsable ? 'env' : 'generate';
  }

  if (!role.exists) actions.push('create-role');
  else {
    actions.push('enforce-role-attributes');
    if (rotatePassword) actions.push('set-password');
  }

  if (!database.exists) actions.push('create-database');
  else if (database.owner !== dbUser) {
    throw new Error(`Database already exists but is owned by "${database.owner}"; refusing to modify it.`);
  }
  actions.push('restrict-database');

  const writeEnv = password === 'generate' || validateEnv(env).length > 0;
  return { actions, password, writeEnv };
}
