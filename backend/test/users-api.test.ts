import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLimiter, type Limiter } from '../src/auth/password.js';
import { createRateLimiter, type RateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { decideUserChange } from '../src/auth/users-store.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';

// User administration and self-service password change (Task 011, ADR-019): permissions, Origin/CSRF, strict
// validation, session revocation, self/last-admin protection, atomic audit, no credentials in responses/logs/audit.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Users-Passw0rd-41';
const NEW_PASSWORD = 'synthetic-New-Passw0rd-9b7e';
const CREATED_PASSWORD = 'synthetic-Created-Passw0rd-3c';
let store: FakeAuthStore;
let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;

function build(over: { hashLimiter?: Limiter; userAdminLimiter?: RateLimiter; passwordChangeLimiter?: RateLimiter } = {}) {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => store, createUserStore: () => store,
      ...(over.userAdminLimiter ? { userAdminLimiter: over.userAdminLimiter } : {}),
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        ...(over.hashLimiter ? { hashLimiter: over.hashLimiter } : {}),
        ...(over.passwordChangeLimiter ? { passwordChangeLimiter: over.passwordChangeLimiter } : {}),
      },
    },
  });
}
beforeEach(() => { store = new FakeAuthStore(); build(); });
afterEach(async () => { await app.close(); });

const cookieOf = (res: LightMyRequestResponse) => { const raw = res.headers['set-cookie']; return (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? ''; };
async function login(email: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
  return { res, cookie: cookieOf(res), csrf: res.statusCode === 200 ? res.json<{ csrfToken: string }>().csrfToken : '' };
}
type Session = Awaited<ReturnType<typeof login>> & { id: string };
async function user(role: Role, email = `${role}-${randomUUID().slice(0, 8)}@example.test`): Promise<Session> {
  const u = await store.addUser({ email, password: PASSWORD, role });
  return { ...(await login(email)), id: u.id };
}
const h = (s: Session) => ({ cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf });
const list = (s: Session, query = '') => app.inject({ method: 'GET', url: `/api/users${query}`, headers: { cookie: s.cookie } });
const create = (s: Session, payload: object) => app.inject({ method: 'POST', url: '/api/users', headers: h(s), payload });
const patch = (s: Session, id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: h(s), payload });
const changePassword = (s: Session, payload: object = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }) =>
  app.inject({ method: 'POST', url: '/api/auth/change-password', headers: h(s), payload });
const me = (s: Session) => app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
const events = (name: string) => store.audit.filter((a) => a.event === name);

function noCredentials(...responses: LightMyRequestResponse[]) {
  const text = [logs.text(), JSON.stringify(store.audit), ...responses.map((r) => r.body)].join('\n');
  for (const secret of [PASSWORD, NEW_PASSWORD, CREATED_PASSWORD, 'scrypt$', 'passwordHash', 'password_hash']) expect(text).not.toContain(secret);
}

describe('permissions, Origin and CSRF', () => {
  it('anonymous → 401; viewer/operator → 403 (+authz.denied) on list/create/update; admin → 200', async () => {
    const id = randomUUID();
    for (const req of [
      { method: 'GET' as const, url: '/api/users' }, { method: 'POST' as const, url: '/api/users', payload: {} },
      { method: 'PATCH' as const, url: `/api/users/${id}`, payload: { role: 'viewer' } }, { method: 'POST' as const, url: '/api/auth/change-password', payload: {} },
    ]) expect((await app.inject({ ...req, headers: { origin: ORIGIN } })).statusCode).toBe(401);
    for (const role of ['viewer', 'operator'] as const) {
      const s = await user(role);
      expect((await list(s)).statusCode).toBe(403);
      expect((await create(s, { email: 'x@example.test', password: CREATED_PASSWORD, role: 'admin' })).statusCode).toBe(403);
      expect((await patch(s, s.id, { role: 'admin' })).statusCode).toBe(403);
    }
    expect(events('authz.denied')).toHaveLength(6);
    expect(store.users.size).toBe(2); // nothing created
    expect((await list(await user('admin'))).statusCode).toBe(200);
  });

  it('mutations need the allowed Origin and the session CSRF token', async () => {
    const admin = await user('admin');
    const target = await user('viewer');
    const body = { email: 'n@example.test', password: CREATED_PASSWORD, role: 'viewer' };
    for (const headers of [{ cookie: admin.cookie, 'x-csrf-token': admin.csrf }, { cookie: admin.cookie, origin: 'https://evil.example', 'x-csrf-token': admin.csrf }, { cookie: admin.cookie, origin: ORIGIN }]) {
      expect((await app.inject({ method: 'POST', url: '/api/users', headers, payload: body })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: `/api/users/${target.id}`, headers, payload: { role: 'admin' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/auth/change-password', headers, payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } })).statusCode).toBe(403);
    }
    expect(store.users.size).toBe(2);
    expect(store.users.get(target.id)?.role).toBe('viewer');
    expect((await login(admin.res.json<{ user: { email: string } }>().user.email)).res.statusCode).toBe(200); // password unchanged
  });
});

describe('validation', () => {
  it('create: email/password policy, role whitelist, strict body; email is normalized', async () => {
    const admin = await user('admin');
    for (const payload of [
      { email: 'not-an-email', password: CREATED_PASSWORD, role: 'viewer' }, { email: 'a@example.test', password: 'short', role: 'viewer' },
      { email: 'a@example.test', password: CREATED_PASSWORD, role: 'root' }, { email: 'a@example.test', password: CREATED_PASSWORD },
      { email: 'a@example.test', password: CREATED_PASSWORD, role: 'viewer', isActive: false }, { email: 'a@example.test', password: 'x'.repeat(1025), role: 'viewer' },
    ]) expect((await create(admin, payload)).statusCode).toBe(400);
    const res = await create(admin, { email: '  New.User@Example.TEST ', password: CREATED_PASSWORD, role: 'operator' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'new.user@example.test', role: 'operator', isActive: true });
    expect(Object.keys(res.json<object>()).sort()).toEqual(['createdAt', 'email', 'id', 'isActive', 'role', 'updatedAt']);
    noCredentials(res);
  });

  it('PATCH: UUID param, non-empty whitelisted body; list: bounded limit and UUID cursor', async () => {
    const admin = await user('admin');
    const target = await user('viewer');
    for (const [id, payload] of [
      ['not-a-uuid', { role: 'viewer' }], [target.id, {}], [target.id, { email: 'x@example.test' }], [target.id, { role: 'root' }],
      [target.id, { isActive: 'false' }], [target.id, { role: 'admin', password: CREATED_PASSWORD }],
    ] as const) expect((await patch(admin, id, payload)).statusCode).toBe(400);
    for (const q of ['?limit=0', '?limit=101', '?after=x', '?after=1', '?email=a']) expect({ q, status: (await list(admin, q)).statusCode }).toEqual({ q, status: 400 });
    expect(store.users.get(target.id)?.role).toBe('viewer');
  });
});

describe('list', () => {
  it('keyset pages in creation order; no hashes', async () => {
    const admin = await user('admin');
    for (let i = 0; i < 4; i++) await store.addUser({ email: `u${String(i)}@example.test`, password: PASSWORD });
    const first = await list(admin, '?limit=2');
    const page1 = first.json<{ items: { email: string }[]; nextAfter: string }>();
    expect(page1.items).toHaveLength(2);
    const page2 = (await list(admin, `?limit=2&after=${page1.nextAfter}`)).json<{ items: { email: string }[]; nextAfter: string }>();
    const page3 = (await list(admin, `?limit=2&after=${page2.nextAfter}`)).json<{ items: { email: string }[]; nextAfter: string | null }>();
    expect([...page1.items, ...page2.items, ...page3.items].map((u) => u.email)).toEqual([admin.res.json<{ user: { email: string } }>().user.email, 'u0@example.test', 'u1@example.test', 'u2@example.test', 'u3@example.test']);
    expect(page3.nextAfter).toBeNull();
    noCredentials(first);
  });
});

describe('create', () => {
  it('admin creates an active user (audited); the user can sign in; duplicate email (any case) → 409 + rejected audit', async () => {
    const admin = await user('admin');
    const res = await create(admin, { email: 'fresh@example.test', password: CREATED_PASSWORD, role: 'viewer' });
    expect(res.statusCode).toBe(201);
    expect(events('user.created')).toEqual([expect.objectContaining({ actorUserId: admin.id, details: { targetUserId: res.json<{ id: string }>().id, role: 'viewer' } })]);
    expect((await login('fresh@example.test', CREATED_PASSWORD)).res.statusCode).toBe(200);
    const dup = await create(admin, { email: 'FRESH@example.test', password: CREATED_PASSWORD, role: 'admin' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ message: 'A user with this email already exists' });
    expect(events('user.create_rejected')).toEqual([expect.objectContaining({ outcome: 'failure', details: { reason: 'email_taken' } })]);
    noCredentials(res, dup);
  });

  it('hashing overload → 503 Retry-After 1; rate limit → 429; DB or audit failure → 503 and nothing is created', async () => {
    await app.close();
    build({ hashLimiter: createLimiter(0, 0), userAdminLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }) });
    // Login itself needs hashing: create the admin session through a normal app first.
    const admin = await (async () => {
      await app.close(); build({ userAdminLimiter: createRateLimiter({ max: 100, windowMs: 60_000 }) });
      const s = await user('admin');
      await app.close(); build({ hashLimiter: createLimiter(0, 0), userAdminLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }) });
      return s;
    })();
    const body = { email: 'busy@example.test', password: CREATED_PASSWORD, role: 'viewer' };
    const busy = await create(admin, body);
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    const limited = await create(admin, body);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
    build();
    store.failing.add('createUser');
    expect((await create(admin, body)).statusCode).toBe(503);
    store.failing.clear();
    store.failAuditWrites = true;
    expect((await create(admin, body)).statusCode).toBe(503);
    store.failAuditWrites = false;
    expect([...store.users.values()].some((u) => u.email === 'busy@example.test')).toBe(false);
    noCredentials();
  });
});

describe('role and activity', () => {
  it('role change revokes all target sessions (audited with from/to); the target keeps working after a new login', async () => {
    const admin = await user('admin');
    const target = await user('viewer');
    const second = await login(target.res.json<{ user: { email: string } }>().user.email);
    const res = await patch(admin, target.id, { role: 'operator' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: target.id, role: 'operator', isActive: true });
    expect((await me(target)).statusCode).toBe(401);
    expect((await me({ ...target, cookie: second.cookie })).statusCode).toBe(401);
    expect(events('user.role_changed')).toEqual([expect.objectContaining({ details: { targetUserId: target.id, fromRole: 'viewer', toRole: 'operator', sessionsRevoked: 2 } })]);
    const again = await login(target.res.json<{ user: { email: string } }>().user.email);
    expect(again.res.json()).toMatchObject({ user: { role: 'operator' }, permissions: expect.arrayContaining(['logs:read']) as unknown });
    expect((await me(admin)).statusCode).toBe(200); // the actor is unaffected
    noCredentials(res);
  });

  it('deactivation ends sessions and blocks login; reactivation does not restore old sessions; PATCH keeps omitted fields', async () => {
    const admin = await user('admin');
    const target = await user('operator');
    const email = target.res.json<{ user: { email: string } }>().user.email;
    expect((await patch(admin, target.id, { isActive: false })).json()).toMatchObject({ role: 'operator', isActive: false });
    expect((await me(target)).statusCode).toBe(401);
    expect((await login(email)).res.statusCode).toBe(401);
    expect(events('user.deactivated')).toEqual([expect.objectContaining({ details: { targetUserId: target.id, sessionsRevoked: 1 } })]);
    expect((await patch(admin, target.id, { isActive: true })).json()).toMatchObject({ role: 'operator', isActive: true });
    expect(events('user.activated')).toEqual([expect.objectContaining({ details: { targetUserId: target.id, sessionsRevoked: 0 } })]);
    expect((await me(target)).statusCode).toBe(401);
    expect((await login(email)).res.statusCode).toBe(200);
  });

  it('role + activity in one PATCH → two audit rows; no-op → 200 without audit or revocation', async () => {
    const admin = await user('admin');
    const target = await user('viewer');
    const before = store.audit.length;
    expect((await patch(admin, target.id, { role: 'viewer', isActive: true })).statusCode).toBe(200);
    expect(store.audit.length).toBe(before);
    expect((await me(target)).statusCode).toBe(200);
    expect((await patch(admin, target.id, { role: 'admin', isActive: false })).statusCode).toBe(200);
    expect(store.audit.slice(before).map((a) => a.event)).toEqual(['user.role_changed', 'user.deactivated']);
  });

  it('own account → 403 + update_rejected (even a no-op); unknown user → 404', async () => {
    const admin = await user('admin');
    for (const body of [{ role: 'viewer' }, { isActive: false }, { role: 'admin' }]) expect((await patch(admin, admin.id, body)).statusCode).toBe(403);
    expect(events('user.update_rejected')).toHaveLength(3);
    expect(events('user.update_rejected')[0]).toMatchObject({ outcome: 'denied', details: { targetUserId: admin.id, reason: 'self_change' } });
    expect((await me(admin)).json()).toMatchObject({ user: { role: 'admin' } });
    expect((await patch(admin, randomUUID(), { role: 'viewer' })).statusCode).toBe(404);
  });

  it('an actor demoted between the request check and the commit gets 401, nothing changes', async () => {
    const admin = await user('admin');
    const other = await user('admin');
    const target = await user('viewer');
    const original = store.updateUser.bind(store);
    store.updateUser = async (input) => {
      // Another admin removes this actor's rights just before its transaction.
      await original({ actor: { userId: other.id, sessionId: store.sessions.find((s) => s.userId === other.id)?.id ?? '' }, targetId: admin.id, role: 'viewer', requestId: randomUUID() });
      return original(input);
    };
    const res = await patch(admin, target.id, { role: 'admin' });
    expect(res.statusCode).toBe(401);
    expect(store.users.get(target.id)?.role).toBe('viewer');
    expect(store.users.get(admin.id)?.role).toBe('viewer');
  });

  it('audit failure or DB failure → 503, role/activity and sessions unchanged', async () => {
    const admin = await user('admin');
    const target = await user('viewer');
    store.failAuditWrites = true;
    expect((await patch(admin, target.id, { role: 'admin', isActive: false })).statusCode).toBe(503);
    store.failAuditWrites = false;
    store.failing.add('updateUser');
    expect((await patch(admin, target.id, { role: 'admin' })).statusCode).toBe(503);
    store.failing.clear();
    expect(store.users.get(target.id)).toMatchObject({ role: 'viewer', isActive: true, credentialVersion: 1 });
    expect((await me(target)).statusCode).toBe(200);
  });

  it('decideUserChange: self, last admin, no-op and omitted fields', () => {
    const admin = { id: 'b', role: 'admin' as const, isActive: true };
    expect(decideUserChange('b', admin, { role: 'viewer' }, 5)).toEqual({ status: 'self_change' });
    expect(decideUserChange('a', admin, { role: 'viewer' }, 0)).toEqual({ status: 'last_admin' });
    expect(decideUserChange('a', admin, { isActive: false }, 0)).toEqual({ status: 'last_admin' });
    expect(decideUserChange('a', admin, { role: 'admin', isActive: true }, 0)).toEqual({ status: 'ok', role: 'admin', isActive: true, changed: false });
    expect(decideUserChange('a', admin, { role: 'operator' }, 1)).toEqual({ status: 'ok', role: 'operator', isActive: true, changed: true });
    expect(decideUserChange('a', { ...admin, isActive: false }, { role: 'viewer' }, 0)).toEqual({ status: 'ok', role: 'viewer', isActive: false, changed: true });
    expect(decideUserChange('a', { id: 'v', role: 'viewer', isActive: true }, { isActive: false }, 0)).toEqual({ status: 'ok', role: 'viewer', isActive: false, changed: true });
  });
});

describe('change own password', () => {
  it.each(['admin', 'operator', 'viewer'] as const)('%s: 204, cookie cleared, ALL sessions revoked, old password refused, new accepted', async (role) => {
    const s = await user(role);
    const email = s.res.json<{ user: { email: string } }>().user.email;
    const other = await login(email);
    const res = await changePassword(s);
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await me(s)).statusCode).toBe(401);
    expect((await me({ ...s, cookie: other.cookie })).statusCode).toBe(401);
    expect((await login(email)).res.statusCode).toBe(401);
    expect((await login(email, NEW_PASSWORD)).res.statusCode).toBe(200);
    expect(events('auth.password_change')).toEqual([expect.objectContaining({ outcome: 'success', actorUserId: s.id, details: { sessionsRevoked: 2 } })]);
    noCredentials(res);
  });

  it('wrong current password → 422, nothing changes, failure audited; same/short new password → 400 without hashing', async () => {
    const s = await user('viewer');
    const wrong = await changePassword(s, { currentPassword: 'synthetic-Wrong-Passw0rd', newPassword: NEW_PASSWORD });
    expect(wrong.statusCode).toBe(422);
    expect((await changePassword(s, { currentPassword: 'short', newPassword: NEW_PASSWORD })).statusCode).toBe(422);
    expect(events('auth.password_change')).toEqual([
      expect.objectContaining({ outcome: 'failure', details: { reason: 'invalid_current_password' } }),
      expect.objectContaining({ outcome: 'failure', details: { reason: 'invalid_current_password' } }),
    ]);
    const lookups = store.calls.getCredentials;
    expect((await changePassword(s, { currentPassword: PASSWORD, newPassword: PASSWORD })).statusCode).toBe(400);
    expect((await changePassword(s, { currentPassword: PASSWORD, newPassword: 'too-short' })).statusCode).toBe(400);
    expect((await changePassword(s, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirm: NEW_PASSWORD })).statusCode).toBe(400);
    expect(store.calls.getCredentials).toBe(lookups);
    expect((await me(s)).statusCode).toBe(200);
    expect(store.users.get(s.id)?.credentialVersion).toBe(1);
    noCredentials(wrong);
  });

  it('5 attempts / 15 min per user → 429; hashing overload → 503 Retry-After 1; DB failure → 503', async () => {
    const s = await user('viewer');
    for (let i = 0; i < 5; i++) expect((await changePassword(s, { currentPassword: 'synthetic-Wrong-Passw0rd', newPassword: NEW_PASSWORD })).statusCode).toBe(422);
    const limited = await changePassword(s);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
    build({ hashLimiter: createLimiter(0, 0) });
    const busy = await changePassword(s);
    expect(busy.statusCode).toBe(503);
    expect(busy.headers['retry-after']).toBe('1');
    await app.close();
    build();
    store.failing.add('changePassword');
    expect((await changePassword(s)).statusCode).toBe(503);
    expect(store.users.get(s.id)?.credentialVersion).toBe(1);
    expect((await me(s)).statusCode).toBe(200);
  });

  it('credentials changed between verification and commit (CAS) → 409, nothing written, stale audited', async () => {
    const s = await user('viewer');
    const original = store.getCredentials.bind(store);
    store.getCredentials = async (id) => {
      const c = await original(id);
      const u = store.users.get(id);
      if (u) u.credentialVersion += 1; // a concurrent change commits meanwhile
      return c;
    };
    const res = await changePassword(s);
    expect(res.statusCode).toBe(409);
    expect(events('auth.password_change')).toEqual([expect.objectContaining({ outcome: 'failure', details: { reason: 'stale_credentials' } })]);
    expect((await login(s.res.json<{ user: { email: string } }>().user.email)).res.statusCode).toBe(200);
  });

  it('audit failure inside the change → 503 and the old password and sessions stay valid', async () => {
    const s = await user('operator');
    store.failAuditWrites = true;
    expect((await changePassword(s)).statusCode).toBe(503);
    store.failAuditWrites = false;
    expect((await me(s)).statusCode).toBe(200);
    expect((await login(s.res.json<{ user: { email: string } }>().user.email)).res.statusCode).toBe(200);
  });
});

describe('login against a concurrent credential change', () => {
  it('a login that verified the password before a change creates no session (401, stale_credentials)', async () => {
    const u = await store.addUser({ email: 'late@example.test', password: PASSWORD, role: 'viewer' });
    const original = store.findLoginUser.bind(store);
    store.findLoginUser = async (email) => {
      const found = await original(email);
      const stored = found ? store.users.get(found.id) : undefined;
      if (found && stored) stored.credentialVersion = found.credentialVersion + 1;
      return found;
    };
    const res = await login('late@example.test');
    expect(res.res.statusCode).toBe(401);
    expect(store.sessions.filter((x) => x.userId === u.id)).toHaveLength(0);
    expect(events('auth.login')).toEqual([expect.objectContaining({ outcome: 'failure', details: { reason: 'stale_credentials' } })]);
  });
});
