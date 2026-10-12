import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixed loopback ports for the E2E stack (overridable). global-setup refuses to start if they are busy.
export const API_PORT = Number(process.env.NC_E2E_API_PORT ?? 41300);
export const UI_PORT = Number(process.env.NC_E2E_UI_PORT ?? 41730);
export const UI_ORIGIN = `http://127.0.0.1:${String(UI_PORT)}`;
/** Teardown bookkeeping (pids, schema name). No credentials are written here. */
export const STATE_FILE = join(tmpdir(), `nc-e2e-state-${String(API_PORT)}.json`);

export const USERS = ['admin', 'operator', 'viewer'] as const;
export type E2eRole = (typeof USERS)[number];

/** Credentials are generated per run in global-setup and passed to workers via process.env only. */
export function credentials(role: E2eRole): { email: string; password: string } {
  const email = process.env[`E2E_${role.toUpperCase()}_EMAIL`];
  const password = process.env[`E2E_${role.toUpperCase()}_PASSWORD`];
  if (!email || !password) throw new Error('E2E credentials missing: run through `npm run test:e2e`');
  return { email, password };
}
