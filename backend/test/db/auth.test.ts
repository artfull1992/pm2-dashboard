// Real PostgreSQL tests for auth/RBAC/audit — ONLY the isolated test DB (TEST_DB_*), in a per-run schema.
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { hashPassword } from '../../src/auth/password.js';
import { createRateLimiter } from '../../src/auth/rate-limit.js';
import { EXIT, runBootstrapCli } from '../../src/bootstrap-cli.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { captureLogs } from '../helpers.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Db-Passw0rd-913';
const noLog = { error: () => undefined };

let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];
const databases: Database[] = [];

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
});

afterAll(async () => {
  await Promise.all(databases.map((d) => d.close()));
  for (const schema of schemas) await dropRunSchema(admin, schema);
  await admin.end();
});

/** Fresh per-run schema with all migrations applied, plus a Database whose pool is pinned to it. */
async function migratedSchema(): Promise<{ schema: string; db: Database; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult> }> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try {
    await migrateUp(client, { schema });
  } finally {
    await client.end();
  }
  const db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  databases.push(db);
  const sql = async (q: string, v: unknown[] = []) => {
    await admin.query(`SET search_path TO "${schema}"`);
    try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
  };
  return { schema, db, sql };
}

function authApp(db: Database): { app: FastifyInstance; logs: ReturnType<typeof captureLogs> } {
  const logs = captureLogs();
  const app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 2_000, createDatabase: () => db, logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      extra: { accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }) },
    },
  });
  // Closing the app also closes this schema's pool (close() is idempotent; afterAll calls it again).
  return { app, logs };
}

async function login(app: FastifyInstance, email: string, cookie?: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) }, payload: { email, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { res, cookie: (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0], csrf: res.statusCode === 200 ? res.json<{ csrfToken: string }>().csrfToken : undefined };
}

describe('auth schema (migration 1791900000001)', () => {
  let ctx: Awaited<ReturnType<typeof migratedSchema>>;
  beforeAll(async () => { ctx = await migratedSchema(); });

  it('users.role defaults to viewer and is constrained', async () => {
    await ctx.sql(`INSERT INTO users (email, password_hash) VALUES ('d@example.test', 'h')`);
    expect((await ctx.sql(`SELECT role FROM users WHERE email = 'd@example.test'`)).rows).toEqual([{ role: 'viewer' }]);
    await expect(ctx.sql(`INSERT INTO users (email, password_hash, role) VALUES ('r@example.test', 'h', 'root')`)).rejects.toMatchObject({ code: '23514' });
  });

  it('sessions: FK, 32-byte digest, expiry after creation, unique digest; indexes exist', async () => {
    const { rows: [u] } = await ctx.sql(`INSERT INTO users (email, password_hash) VALUES ('s@example.test', 'h') RETURNING id`) as { rows: { id: string }[] };
    const digest = Buffer.alloc(32, 1);
    await ctx.sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [u?.id, digest]);
    await expect(ctx.sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [u?.id, digest])).rejects.toMatchObject({ code: '23505' });
    await expect(ctx.sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [u?.id, Buffer.alloc(31)])).rejects.toMatchObject({ code: '23514' });
    await expect(ctx.sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 hour')`, [u?.id, Buffer.alloc(32, 2)])).rejects.toMatchObject({ code: '23514' });
    await expect(ctx.sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, now() + interval '1 hour')`, [Buffer.alloc(32, 3)])).rejects.toMatchObject({ code: '23503' });
    const { rows } = await admin.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename IN ('sessions', 'audit_log') ORDER BY 1`, [ctx.schema]);
    expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual(['audit_log_actor_idx', 'audit_log_pkey', 'sessions_expires_at_idx', 'sessions_pkey', 'sessions_token_hash_key', 'sessions_user_id_idx']);
  });

  it('audit_log: event format, outcome, object details with size cap', async () => {
    const insert = (event: string, outcome: string, details: string) =>
      ctx.sql('INSERT INTO audit_log (event, outcome, details) VALUES ($1, $2, $3::jsonb)', [event, outcome, details]);
    await insert('auth.login', 'success', '{}');
    await expect(insert('Auth Login', 'success', '{}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('auth.login', 'maybe', '{}')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('auth.login', 'success', '[1]')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('auth.login', 'success', JSON.stringify({ x: 'y'.repeat(3000) }))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('session lifecycle through the API', () => {
  let ctx: Awaited<ReturnType<typeof migratedSchema>>;
  let app: FastifyInstance;
  let adminId: string;

  beforeAll(async () => {
    ctx = await migratedSchema();
    const result = await bootstrapAdmin(ctx.db, { email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD) });
    if (result.status !== 'created') throw new Error('bootstrap failed');
    adminId = result.userId;
    ({ app } = authApp(ctx.db));
  });
  afterAll(async () => { await app.close(); });

  it('login → me → audit → logout → me 401; only digests stored; audit trail written', async () => {
    const { res, cookie, csrf } = await login(app, 'admin@example.test');
    expect(res.statusCode).toBe(200);
    const token = cookie?.split('=')[1] ?? '';
    const stored = await ctx.sql('SELECT encode(token_hash, \'hex\') AS h FROM sessions');
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(token);

    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie ?? '' } })).statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=10', headers: { cookie: cookie ?? '' } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{ items: { event: string }[] }>().items.map((i) => i.event)).toEqual(['auth.login', 'admin.bootstrap']);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookie ?? '', origin: ORIGIN, 'x-csrf-token': csrf ?? '' } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie ?? '' } })).statusCode).toBe(401);
    expect((await ctx.sql('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NOT NULL')).rows[0]).toEqual({ n: 1 });
    const events = await ctx.sql('SELECT event, outcome, actor_user_id FROM audit_log ORDER BY id');
    expect(events.rows).toEqual([
      { event: 'admin.bootstrap', outcome: 'success', actor_user_id: adminId },
      { event: 'auth.login', outcome: 'success', actor_user_id: adminId },
      { event: 'auth.logout', outcome: 'success', actor_user_id: adminId },
    ]);
  });

  it('fixation: re-login with the old cookie revokes it in the same transaction', async () => {
    const first = await login(app, 'admin@example.test');
    const second = await login(app, 'admin@example.test', first.cookie);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: first.cookie ?? '' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: second.cookie ?? '' } })).statusCode).toBe(200);
  });

  it('expiry and current role/active flag come from the database', async () => {
    const { cookie } = await login(app, 'admin@example.test');
    const me = () => app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie ?? '' } });
    await ctx.sql(`UPDATE users SET role = 'operator' WHERE id = $1`, [adminId]);
    expect((await me()).json<{ user: { role: string } }>().user.role).toBe('operator');
    expect((await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookie ?? '' } })).statusCode).toBe(403);
    const denied = await ctx.sql(`SELECT details FROM audit_log WHERE event = 'authz.denied'`);
    expect(denied.rows).toEqual([{ details: { permission: 'audit:read', route: '/api/audit' } }]);
    await ctx.sql(`UPDATE users SET role = 'admin', is_active = false WHERE id = $1`, [adminId]);
    expect((await me()).statusCode).toBe(401);
    await ctx.sql(`UPDATE users SET is_active = true WHERE id = $1`, [adminId]);
    expect((await me()).statusCode).toBe(200);
    await ctx.sql(`UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE revoked_at IS NULL`);
    expect((await me()).statusCode).toBe(401);
  });

  it('failed logins are audited without the submitted email', async () => {
    const count = async () => ((await ctx.sql('SELECT count(*)::int AS n FROM audit_log')).rows[0] as { n: number }).n;
    const before = await count();
    await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'ghost-user@example.test', password: PASSWORD } });
    const rows = (await ctx.sql('SELECT event, outcome, actor_user_id, details FROM audit_log ORDER BY id DESC LIMIT 1')).rows;
    expect(rows).toEqual([{ event: 'auth.login', outcome: 'failure', actor_user_id: null, details: { reason: 'invalid_credentials' } }]);
    expect(await count()).toBe(before + 1);
    expect(JSON.stringify((await ctx.sql('SELECT * FROM audit_log')).rows)).not.toContain('ghost-user');
  });
});

describe('atomicity with real transactions', () => {
  it('login: audit insert failure rolls back the session (503, no row)', async () => {
    const ctx = await migratedSchema();
    await bootstrapAdmin(ctx.db, { email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD) });
    const { app } = authApp(ctx.db);
    await ctx.sql('ALTER TABLE audit_log RENAME TO audit_log_offline');
    try {
      const { res } = await login(app, 'admin@example.test');
      expect(res.statusCode).toBe(503);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect((await ctx.sql('SELECT count(*)::int AS n FROM sessions')).rows[0]).toEqual({ n: 0 });
    } finally {
      await ctx.sql('ALTER TABLE audit_log_offline RENAME TO audit_log');
      await app.close();
    }
  });

  it('bootstrap: audit failure leaves no user', async () => {
    const ctx = await migratedSchema();
    await ctx.sql('ALTER TABLE audit_log RENAME TO audit_log_offline');
    await expect(bootstrapAdmin(ctx.db, { email: 'admin@example.test', passwordHash: await hashPassword(PASSWORD) })).rejects.toThrow();
    expect((await ctx.sql('SELECT count(*)::int AS n FROM users')).rows[0]).toEqual({ n: 0 });
    await ctx.sql('ALTER TABLE audit_log_offline RENAME TO audit_log');
  });
});

describe('bootstrap', () => {
  it('concurrent bootstraps create exactly one admin and one audit event', async () => {
    const ctx = await migratedSchema();
    const hash = await hashPassword(PASSWORD);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => bootstrapAdmin(ctx.db, { email: `admin${String(i)}@example.test`, passwordHash: hash })));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'admin-exists')).toHaveLength(4);
    expect((await ctx.sql(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`)).rows[0]).toEqual({ n: 1 });
    expect((await ctx.sql(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'admin.bootstrap'`)).rows[0]).toEqual({ n: 1 });
  });

  it('refuses to promote an existing user and never resets a password', async () => {
    const ctx = await migratedSchema();
    await ctx.sql(`INSERT INTO users (email, password_hash) VALUES ('viewer@example.test', 'original-hash')`);
    await expect(bootstrapAdmin(ctx.db, { email: 'viewer@example.test', passwordHash: 'new' })).resolves.toEqual({ status: 'email-taken' });
    expect((await ctx.sql(`SELECT role, password_hash FROM users`)).rows).toEqual([{ role: 'viewer', password_hash: 'original-hash' }]);
  });

  it('CLI end-to-end on the real DB: stdin password → admin created → second run refused', async () => {
    const ctx = await migratedSchema();
    const run = async () => {
      const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume: () => stdin, pause: () => stdin });
      setImmediate(() => { stdin.emit('data', Buffer.from(`${PASSWORD}\n`)); stdin.emit('end'); });
      let out = '';
      let err = '';
      const code = await runBootstrapCli(['--email', 'Root@Example.test', '--password-stdin'], {
        env: { DB_HOST: config.host, DB_PORT: String(config.port), DB_NAME: config.database, DB_USER: config.user, DB_PASS: config.password },
        stdin, stdout: { write: (c: string) => { out += c; } }, stderr: { write: (c: string) => { err += c; } },
        createDatabase: (cfg) => createDatabase(cfg, noLog, createPool(cfg, { searchPath: ctx.schema })),
      });
      return { code, text: out + err };
    };
    const first = await run();
    expect(first.code).toBe(EXIT.created);
    expect(first.text).not.toContain(PASSWORD);
    expect(first.text).not.toContain(config.password);
    expect((await run()).code).toBe(EXIT.refused);
    const { rows } = await ctx.sql('SELECT email, role, is_active, password_hash FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'root@example.test', role: 'admin', is_active: true });
    expect((rows[0] as { password_hash: string }).password_hash).toMatch(/^scrypt\$v1\$/);
  });
});
