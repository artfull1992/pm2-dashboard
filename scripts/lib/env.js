import { chownSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { MIN_PASSWORD_LENGTH } from './password.js';

export const REQUIRED_ENV_KEYS = Object.freeze(['DB_NAME', 'DB_USER', 'DB_HOST', 'DB_PASS', 'DB_PORT']);
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:\-]+$/;

export function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

export function validateEnv(env) {
  const errors = [];
  for (const key of REQUIRED_ENV_KEYS) {
    if (!env[key]) errors.push(`${key} is missing`);
  }
  if (env.DB_PORT && !(/^\d+$/.test(env.DB_PORT) && Number(env.DB_PORT) > 0 && Number(env.DB_PORT) < 65536)) {
    errors.push('DB_PORT must be an integer between 1 and 65535');
  }
  if (env.DB_PASS && env.DB_PASS.length < MIN_PASSWORD_LENGTH) {
    errors.push(`DB_PASS must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return errors;
}

export function formatEnv(env) {
  return REQUIRED_ENV_KEYS.map((key) => {
    const value = String(env[key] ?? '');
    if (!SAFE_VALUE_RE.test(value)) throw new TypeError(`${key} contains characters that need quoting`);
    return `${key}=${value}`;
  }).join('\n') + '\n';
}

export function dbConfigFromEnv(env) {
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASS,
  };
}

// Writes via a 0600 temp file + rename, so the secret is never readable by others, even briefly.
export function writeEnvFileAtomic(path, content, { uid, gid } = {}) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    if (uid !== undefined && gid !== undefined) chownSync(tmp, uid, gid);
    renameSync(tmp, path);
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw error;
  }
}
