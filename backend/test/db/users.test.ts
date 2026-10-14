// Real PostgreSQL tests for user administration and password change (Task 011, ADR-019) — ONLY the isolated test DB
// (TEST_DB_*), in a per-run schema: real transactions, rollback, locks and races.
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { hashPassword } from '../../src/auth/password.js';
import { createRateLimiter } from '../../src/auth/rate-limit.js';
import type { Role } from '../../src/auth/rbac.js';
import { type AuthStore, createPgAuthStore } from '../../src/auth/store.js';
import { createPgUserStore, type UserStore } from '../../src/auth/users-store.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { captureLogs } from '../helpers.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Db-Users-Passw0rd-1';
const NEW_A = 'synthetic-Db-New-Passw0rd-A1';
const NEW_B = 'synthetic-Db-New-Passw0rd-B2';
const noLog = { error: () => undefined };

let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];
const databases: Database[] = [];
let hash: string;

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
  hash = await hashPassword(PASSWORD);
});
afterAll(async () => {
  await Promise.all(databases.map((d) => d.close()));
  for (const schema of schemas) await dropRunSchema(admin, schema);
  await admin.end();
});

interface Ctx {
  schema: string; db: Database; auth: AuthStore; users: UserStore;
  /** A separate connection pinned to the schema, for manual transactions that hold locks. */
  raw: pg.Client;
  sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult>;
}

async function migratedSchema(): Promise<Ctx> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  const db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  databases.push(db);
  const raw = await connectTestClient(config);
  await raw.query(`SET search_path TO "${schema}"`);
  databases.push({ close: () => raw.end() } as unknown as Database);
  const sql = (q: string, v: unknown[] = []) => raw.query(q, v);
  return { schema, db, auth: createPgAuthStore(db), users: createPgUserStore(db), raw, sql };
}

async function addUser(ctx: Ctx, role: Role, email = `${role}-${randomUUID().slice(0, 8)}@example.test`) {
  const { rows } = await ctx.sql('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id', [email, hash, role]);
  const id = (rows[0] as { id: string }).id;
  return { id, email };
}
async function session(ctx: Ctx, userId: string) {
  const version = (await ctx.sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [userId])).rows[0] as { v: number };
  await ctx.auth.createSession({ userId, credentialVersion: version.v, tokenHash: randomBytes(32), ttlSeconds: 3600, previousTokenHash: null, requestId: randomUUID() });
  const { rows } = await ctx.sql('SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
  return { userId, sessionId: (rows[0] as { id: string }).id };
}
const activeSessions = async (ctx: Ctx, userId: string) =>
  ((await ctx.sql('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0] as { n: number }).n;
const activeAdmins = async (ctx: Ctx) => ((await ctx.sql("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active")).rows[0] as { n: number }).n;
/** Narrows away null/undefined (tests fail loudly instead of non-null assertions). */
function must<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('missing value'); return value; }
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10)); };
/** True while some backend of this test waits on a lock. */
const lockWaits = async () => ((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0] as { n: number }).n > 0;

describe('migration 1791900000005 (credential version)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await migratedSchema(); });

  it('existing/new users start at version 1; the version cannot go below 1; the bootstrap admin keeps working', async () => {
    const result = await bootstrapAdmin(ctx.db, { email: 'boot@example.test', passwordHash: hash });
    expect(result.status).toBe('created');
    expect((await ctx.sql("SELECT credential_version::int AS v FROM users WHERE email = 'boot@example.test'")).rows).toEqual([{ v: 1 }]);
    await expect(ctx.sql("UPDATE users SET credential_version = 0 WHERE email = 'boot@example.test'")).rejects.toMatchObject({ code: '23514' });
    expect((await ctx.auth.findLoginUser('boot@example.test'))).toMatchObject({ role: 'admin', credentialVersion: 1 });
    expect((await ctx.sql("SELECT 1 FROM pg_indexes WHERE indexname = 'users_created_at_id_idx' AND schemaname = $1", [ctx.schema])).rows).toHaveLength(1);
  });
});

describe('admin mutations: transactions, audit, sessions', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await migratedSchema(); });

  it('create + role/activity changes revoke sessions, bump the version and audit atomically; no-op writes nothing', async () => {
    const a = await addUser(ctx, 'admin');
    const actor = await session(ctx, a.id);
    const created = await ctx.users.createUser({ actor, email: 'made@example.test', passwordHash: hash, role: 'viewer', requestId: randomUUID() });
    expect(created).toMatchObject({ status: 'created', user: { email: 'made@example.test', role: 'viewer', isActive: true } });
    const id = created.status === 'created' ? created.user.id : '';
    await session(ctx, id);
    await session(ctx, id);
    const changed = await ctx.users.updateUser({ actor, targetId: id, role: 'operator', isActive: false, requestId: randomUUID() });
    expect(changed).toMatchObject({ status: 'updated', changed: true, user: { role: 'operator', isActive: false } });
    expect(await activeSessions(ctx, id)).toBe(0);
    expect((await ctx.sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [id])).rows).toEqual([{ v: 2 }]);
    const audit = (await ctx.sql("SELECT event, details FROM audit_log WHERE event LIKE 'user.%' ORDER BY id")).rows;
    expect(audit).toEqual([
      { event: 'user.created', details: { targetUserId: id, role: 'viewer' } },
      { event: 'user.role_changed', details: { targetUserId: id, fromRole: 'viewer', toRole: 'operator', sessionsRevoked: 2 } },
      { event: 'user.deactivated', details: { targetUserId: id, sessionsRevoked: 2 } },
    ]);
    const before = (await ctx.sql('SELECT count(*)::int AS n FROM audit_log')).rows[0] as { n: number };
    expect(await ctx.users.updateUser({ actor, targetId: id, role: 'operator', requestId: randomUUID() })).toMatchObject({ status: 'updated', changed: false });
    expect((await ctx.sql('SELECT count(*)::int AS n FROM audit_log')).rows[0]).toEqual(before);
    expect(await ctx.users.createUser({ actor, email: 'made@example.test', passwordHash: hash, role: 'admin', requestId: randomUUID() })).toEqual({ status: 'email_taken' });
    const page = await ctx.users.listUsers({ limit: 1, after: null });
    expect(page.items).toHaveLength(1);
    expect((await ctx.users.listUsers({ limit: 10, after: page.nextAfter })).items.map((u) => u.email)).toContain('made@example.test');
    expect(JSON.stringify(page)).not.toContain('scrypt$');
  });

  it('an audit insert failure rolls back the user change and the session revocation (real transaction)', async () => {
    const a = await addUser(ctx, 'admin');
    const actor = await session(ctx, a.id);
    const t = await addUser(ctx, 'viewer');
    await session(ctx, t.id);
    await ctx.sql(`CREATE FUNCTION fail_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event IN ('user.role_changed', 'user.created', 'auth.password_change') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
    await ctx.sql('CREATE TRIGGER fail_role_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_role_audit()');
    try {
      await expect(ctx.users.updateUser({ actor, targetId: t.id, role: 'admin', requestId: randomUUID() })).rejects.toBeTruthy();
      await expect(ctx.users.createUser({ actor, email: 'never@example.test', passwordHash: hash, role: 'viewer', requestId: randomUUID() })).rejects.toBeTruthy();
      const v = (await ctx.sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [t.id])).rows[0] as { v: number };
      await expect(ctx.auth.changePassword({ userId: t.id, expectedVersion: v.v, passwordHash: await hashPassword(NEW_A), requestId: randomUUID() })).rejects.toBeTruthy();
      expect((await ctx.sql('SELECT role, credential_version::int AS v, password_hash = $2 AS same FROM users WHERE id = $1', [t.id, hash])).rows).toEqual([{ role: 'viewer', v: 1, same: true }]);
      expect(await activeSessions(ctx, t.id)).toBe(1);
      expect((await ctx.sql("SELECT 1 FROM users WHERE email = 'never@example.test'")).rows).toHaveLength(0);
    } finally {
      await ctx.sql('DROP TRIGGER fail_role_audit ON audit_log');
      await ctx.sql('DROP FUNCTION fail_role_audit()');
    }
  });
});

describe('races (real locks)', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await migratedSchema(); });

  it('duplicate create race: exactly one user, the other gets email_taken', async () => {
    const a = await addUser(ctx, 'admin');
    const b = await addUser(ctx, 'admin');
    const [ra, rb] = [await session(ctx, a.id), await session(ctx, b.id)];
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      ctx.users.createUser({ actor: i % 2 ? ra : rb, email: 'race@example.test', passwordHash: hash, role: 'viewer', requestId: randomUUID() })));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'email_taken')).toHaveLength(5);
    expect((await ctx.sql("SELECT count(*)::int AS n FROM users WHERE email = 'race@example.test'")).rows).toEqual([{ n: 1 }]);
  });

  it('two admins demoting / deactivating each other at once: exactly one wins, one active admin remains', async () => {
    for (const change of [{ role: 'viewer' as const }, { isActive: false }]) {
      await ctx.sql("UPDATE users SET role = 'viewer' WHERE role = 'admin'");
      const a = await addUser(ctx, 'admin');
      const b = await addUser(ctx, 'admin');
      const [sa, sb] = [await session(ctx, a.id), await session(ctx, b.id)];
      const results = await Promise.all([
        ctx.users.updateUser({ actor: sa, targetId: b.id, ...change, requestId: randomUUID() }),
        ctx.users.updateUser({ actor: sb, targetId: a.id, ...change, requestId: randomUUID() }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['actor_revoked', 'updated']);
      expect(await activeAdmins(ctx)).toBe(1);
    }
  });

  it('three admins in a cycle (A→B, B→C, C→A) concurrently: never zero active admins, the loser cannot commit late', async () => {
    await ctx.sql("UPDATE users SET role = 'viewer' WHERE role = 'admin'");
    const ids = [await addUser(ctx, 'admin'), await addUser(ctx, 'admin'), await addUser(ctx, 'admin')];
    const s = await Promise.all(ids.map((u) => session(ctx, u.id)));
    const results = await Promise.all(ids.map((_, i) =>
      ctx.users.updateUser({ actor: must(s[i]), targetId: must(ids[(i + 1) % 3]).id, isActive: false, requestId: randomUUID() })));
    expect(results.filter((r) => r.status === 'updated').length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 'updated' || r.status === 'actor_revoked')).toBe(true);
    expect(await activeAdmins(ctx)).toBeGreaterThanOrEqual(1);
    // Every successful change was made by someone who was still an active admin after all commits... or before theirs:
    const audit = (await ctx.sql("SELECT actor_user_id, details->>'targetUserId' AS target FROM audit_log WHERE event = 'user.deactivated'")).rows as { actor_user_id: string; target: string }[];
    const deactivated = new Set(audit.map((r) => r.target));
    for (const row of audit) expect(deactivated.has(row.actor_user_id) && audit.findIndex((x) => x.target === row.actor_user_id) < audit.indexOf(row)).toBe(false);
  });

  it('two concurrent password changes with the old password: exactly one succeeds (CAS)', async () => {
    const u = await addUser(ctx, 'operator');
    const v = 1;
    const [ra, rb] = await Promise.all([
      ctx.auth.changePassword({ userId: u.id, expectedVersion: v, passwordHash: await hashPassword(NEW_A), requestId: randomUUID() }),
      ctx.auth.changePassword({ userId: u.id, expectedVersion: v, passwordHash: await hashPassword(NEW_B), requestId: randomUUID() }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual(['changed', 'stale']);
    expect((await ctx.sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [u.id])).rows).toEqual([{ v: 2 }]);
  });

  it('a login that verified the old password and reaches createSession after a committed change creates no session', async () => {
    const u = await addUser(ctx, 'viewer');
    const verified = await ctx.auth.findLoginUser(u.email);
    await ctx.auth.changePassword({ userId: u.id, expectedVersion: must(verified).credentialVersion, passwordHash: await hashPassword(NEW_A), requestId: randomUUID() });
    expect(await ctx.auth.createSession({ userId: u.id, credentialVersion: must(verified).credentialVersion, tokenHash: randomBytes(32), ttlSeconds: 60, previousTokenHash: null, requestId: randomUUID() })).toBeNull();
    expect(await activeSessions(ctx, u.id)).toBe(0);
  });

  it('a login racing an UNCOMMITTED change waits on the row lock and then sees the new version (no session)', async () => {
    const u = await addUser(ctx, 'viewer');
    const verified = await ctx.auth.findLoginUser(u.email);
    await ctx.raw.query('BEGIN');
    await ctx.raw.query('UPDATE users SET credential_version = credential_version + 1 WHERE id = $1', [u.id]);
    const pending = ctx.auth.createSession({ userId: u.id, credentialVersion: must(verified).credentialVersion, tokenHash: randomBytes(32), ttlSeconds: 60, previousTokenHash: null, requestId: randomUUID() });
    await until(lockWaits);
    expect(await lockWaits()).toBe(true);
    await ctx.raw.query('COMMIT');
    expect(await pending).toBeNull();
    expect(await activeSessions(ctx, u.id)).toBe(0);
  });

  it('a login that committed first is revoked by the change that waited for it', async () => {
    const u = await addUser(ctx, 'viewer');
    // Simulated in-flight login: holds the user row FOR SHARE and inserts a session, not yet committed.
    await ctx.raw.query('BEGIN');
    await ctx.raw.query('SELECT 1 FROM users WHERE id = $1 FOR SHARE', [u.id]);
    await ctx.raw.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [u.id, randomBytes(32)]);
    const change = ctx.auth.changePassword({ userId: u.id, expectedVersion: 1, passwordHash: await hashPassword(NEW_A), requestId: randomUUID() });
    await until(lockWaits);
    expect(await lockWaits()).toBe(true);
    await ctx.raw.query('COMMIT');
    expect(await change).toEqual({ status: 'changed', sessionsRevoked: 1 });
    expect(await activeSessions(ctx, u.id)).toBe(0);
  });

  it('deactivation vs a late login: the login creates no session; reactivation does not revive revoked sessions', async () => {
    const a = await addUser(ctx, 'admin');
    const actor = await session(ctx, a.id);
    const u = await addUser(ctx, 'operator');
    await session(ctx, u.id);
    const verified = await ctx.auth.findLoginUser(u.email);
    expect(await ctx.users.updateUser({ actor, targetId: u.id, isActive: false, requestId: randomUUID() })).toMatchObject({ status: 'updated' });
    expect(await ctx.auth.createSession({ userId: u.id, credentialVersion: must(verified).credentialVersion, tokenHash: randomBytes(32), ttlSeconds: 60, previousTokenHash: null, requestId: randomUUID() })).toBeNull();
    expect(await ctx.users.updateUser({ actor, targetId: u.id, isActive: true, requestId: randomUUID() })).toMatchObject({ status: 'updated' });
    expect(await activeSessions(ctx, u.id)).toBe(0);
    expect(await ctx.auth.createSession({ userId: u.id, credentialVersion: must(verified).credentialVersion, tokenHash: randomBytes(32), ttlSeconds: 60, previousTokenHash: null, requestId: randomUUID() })).toBeNull();
  });
});

describe('HTTP over the real database', () => {
  let ctx: Ctx;
  let app: FastifyInstance;
  beforeAll(async () => {
    ctx = await migratedSchema();
    app = buildApp({
      logLevel: 'info', readinessTimeoutMs: 2_000, createDatabase: () => ctx.db, logStream: captureLogs().stream,
      auth: {
        config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
        extra: { accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }) },
      },
    });
  });
  afterAll(async () => { await app.close(); });

  const login = async (email: string, password = PASSWORD) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
    const raw = res.headers['set-cookie'];
    return { status: res.statusCode, cookie: (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '', csrf: res.statusCode === 200 ? res.json<{ csrfToken: string }>().csrfToken : '' };
  };

  it('admin creates a user → user signs in → two concurrent password changes: one 204; only that new password works', async () => {
    const a = await addUser(ctx, 'admin');
    const s = await login(a.email);
    const created = await app.inject({ method: 'POST', url: '/api/users', headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf }, payload: { email: 'http@example.test', password: PASSWORD, role: 'viewer' } });
    expect(created.statusCode).toBe(201);
    const u = await login('http@example.test');
    expect(u.status).toBe(200);
    const change = (newPassword: string) => app.inject({ method: 'POST', url: '/api/auth/change-password', headers: { cookie: u.cookie, origin: ORIGIN, 'x-csrf-token': u.csrf }, payload: { currentPassword: PASSWORD, newPassword } });
    const [ra, rb] = await Promise.all([change(NEW_A), change(NEW_B)]);
    const statuses = [ra.statusCode, rb.statusCode];
    expect(statuses.filter((x) => x === 204)).toHaveLength(1);
    expect(statuses.every((x) => [204, 401, 409].includes(x))).toBe(true);
    const winner = ra.statusCode === 204 ? NEW_A : NEW_B;
    const loser = winner === NEW_A ? NEW_B : NEW_A;
    expect((await login('http@example.test')).status).toBe(401);
    expect((await login('http@example.test', loser)).status).toBe(401);
    expect((await login('http@example.test', winner)).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: u.cookie } })).statusCode).toBe(401);
  });
});
