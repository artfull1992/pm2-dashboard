// Starts the real stack for E2E against the ISOLATED test database only (ADR-012):
//  * TEST_DB_* via the existing guards (no DB_* / .env fallback, production identities rejected);
//  * a fresh per-run schema with all migrations; users exist only in that schema;
//  * compiled backend (backend/dist) + `vite preview` of the production build, both on 127.0.0.1;
//  * random per-run passwords, passed to workers through process.env and never printed.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { bootstrapAdmin } from '../../backend/src/auth/bootstrap.js';
import { hashPassword } from '../../backend/src/auth/password.js';
import { createDatabase, createPool } from '../../backend/src/database.js';
import { migrateUp } from '../../backend/src/migrations.js';
import { connectTestClient, createRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../../backend/test/support/test-db.js';
import { API_PORT, STATE_FILE, UI_ORIGIN, UI_PORT, USERS } from './env.js';

const ROOT = join(import.meta.dirname, '..', '..');

async function assertPortFree(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => { reject(new Error(`port ${String(port)} is busy; set NC_E2E_API_PORT / NC_E2E_UI_PORT`)); });
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolve(); }); });
  });
}

async function waitFor(url: string, child: ChildProcess, ok: (status: number) => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${url}: process exited with ${String(child.exitCode)}`);
    try {
      if (ok((await fetch(url)).status)) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not become ready`);
}

export default async function globalSetup(): Promise<void> {
  const config = testDbConfig(readTestDbEnv());
  await Promise.all([assertPortFree(API_PORT), assertPortFree(UI_PORT)]);

  const schema = newRunSchemaName();
  const admin = await connectTestClient(config);
  try {
    await createRunSchema(admin, schema);
    await migrateUp(admin, { schema });
  } finally {
    await admin.end();
  }
  writeFileSync(STATE_FILE, JSON.stringify({ schema, pids: [] }), { mode: 0o600 });

  // Test users exist only in this schema.
  const db = createDatabase(config, { error: () => undefined }, createPool(config, { searchPath: schema }));
  try {
    for (const role of USERS) {
      const email = `e2e-${role}@example.test`;
      const password = randomBytes(18).toString('base64url');
      const hash = await hashPassword(password);
      if (role === 'admin') {
        const result = await bootstrapAdmin(db, { email, passwordHash: hash });
        if (result.status !== 'created') throw new Error('E2E admin bootstrap failed');
      } else {
        await db.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)", [email, hash, role]);
      }
      process.env[`E2E_${role.toUpperCase()}_EMAIL`] = email;
      process.env[`E2E_${role.toUpperCase()}_PASSWORD`] = password;
    }
  } finally {
    await db.close();
  }
  process.env.E2E_SCHEMA = schema;

  const backend = spawn(process.execPath, [join(ROOT, 'e2e', 'support', 'start-backend.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      PATH: process.env.PATH ?? '',
      E2E_SCHEMA: schema,
      ENV_FILE: join(ROOT, 'e2e', 'support', 'no-such.env'),
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      LOG_LEVEL: 'warn',
      AUTH_COOKIE_SECURE: 'false',
      AUTH_ALLOWED_ORIGINS: UI_ORIGIN,
      // Control is enabled ONLY in this isolated E2E backend (production default: false).
      PM2_CONTROL_ENABLED: 'true',
      // Alerts engine on (evaluation only; no webhook → no delivery), short cycle for the alerts spec.
      ALERTS_ENABLED: 'true',
      ALERTS_INTERVAL_SECONDS: '10',
      AUTH_SESSION_TTL_MINUTES: '30',
      DB_HOST: config.host, DB_PORT: String(config.port), DB_NAME: config.database, DB_USER: config.user, DB_PASS: config.password,
    },
  });
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--config', 'frontend/vite.config.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { PATH: process.env.PATH ?? '', NC_API_URL: `http://127.0.0.1:${String(API_PORT)}`, NC_PREVIEW_PORT: String(UI_PORT) },
  });
  writeFileSync(STATE_FILE, JSON.stringify({ schema, pids: [backend.pid, preview.pid] }), { mode: 0o600 });

  await waitFor(`http://127.0.0.1:${String(API_PORT)}/health/ready`, backend, (s) => s === 200);
  await waitFor(`${UI_ORIGIN}/`, preview, (s) => s === 200);
}
