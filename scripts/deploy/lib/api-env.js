// API config (/etc/node-control/api.env): created once from the legacy DB .env, never overwritten.
// Format is Node's util.parseEnv (what backend/src/config.ts reads via ENV_FILE) — simple KEY=VALUE lines.

import { parseEnv } from 'node:util';

export const DB_KEYS = Object.freeze(['DB_NAME', 'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_PASS']);
export const API_DEFAULTS = Object.freeze({
  NODE_ENV: 'production',
  API_HOST: '127.0.0.1',
  API_PORT: '3100',
  LOG_LEVEL: 'info',
});
const SAFE_VALUE_RE = /^[A-Za-z0-9_.:\-]+$/;

export function parseApiEnv(text) {
  return parseEnv(text);
}

/** Builds the new config text: DB keys copied from the legacy file + production API settings. Values are never logged. */
export function buildApiEnv(legacyEnv, overrides = {}) {
  const missing = DB_KEYS.filter((key) => !legacyEnv[key]);
  if (missing.length > 0) throw new Error(`legacy env is missing: ${missing.join(', ')}`);
  const values = { ...API_DEFAULTS, ...overrides };
  const lines = [
    '# Node Control API — managed by scripts/deploy/server-release.js (created once, never overwritten).',
    ...Object.keys(API_DEFAULTS).map((key) => [key, values[key]]),
    ...DB_KEYS.map((key) => [key, legacyEnv[key]]),
  ].map((entry) => {
    if (typeof entry === 'string') return entry;
    const [key, value] = entry;
    if (!SAFE_VALUE_RE.test(String(value))) throw new TypeError(`${key} contains characters that need quoting`);
    return `${key}=${value}`;
  });
  return `${lines.join('\n')}\n`;
}

/** Errors (empty = valid) for an existing API config; names keys only, never values. */
export function validateApiEnv(env) {
  const errors = [];
  for (const key of DB_KEYS) if (!env[key]) errors.push(`${key} is missing`);
  if (env.API_HOST !== undefined && !['127.0.0.1', '::1', 'localhost'].includes(env.API_HOST)) {
    errors.push('API_HOST must be a loopback address');
  }
  return errors;
}
