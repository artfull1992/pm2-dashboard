import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AuthPluginOptions } from '../src/auth/plugin.js';
import { createLimiter } from '../src/auth/password.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../src/auth/rbac.js';
import type { AuthConfig } from '../src/config.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Passw0rd-7f3a9c';
const SECRET_MARKERS = [PASSWORD];
const AUTH: AuthConfig = { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 };

let store: FakeAuthStore;
let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;

function build(options: { config?: Partial<AuthConfig>; extra?: Partial<Omit<AuthPluginOptions, 'config' | 'store'>>; setup?: (a: FastifyInstance) => void } = {}) {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info',
    readinessTimeoutMs: 200,
    createDatabase: () => fakeDatabase(),
    logStream: logs.stream,
    auth: {
      config: { ...AUTH, ...options.config },
      createStore: () => store,
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        ...options.extra,
      },
    },
  });
  options.setup?.(app);
  return app;
}

beforeEach(() => { store = new FakeAuthStore(); });
afterEach(async () => { await app.close(); });

const headers = (extra: Record<string, string> = {}) => ({ origin: ORIGIN, ...extra });

function cookieOf(res: LightMyRequestResponse): string | undefined {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(';')[0];
}

async function login(email: string, password = PASSWORD, extraHeaders: Record<string, string> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(extraHeaders), payload: { email, password } });
  const body = res.statusCode === 200 ? res.json<{ csrfToken: string; user: { id: string } }>() : undefined;
  return { res, cookie: cookieOf(res), csrf: body?.csrfToken };
}

function expectGenericLoginFailure(res: LightMyRequestResponse) {
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid email or password' });
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(res.headers['cache-control']).toBe('no-store');
}

function expectNoSecrets(...texts: string[]) {
  for (const text of texts) for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
}

describe('login', () => {
  it('success: 200 with user/permissions/csrf, hardened cookie, no-store, audit row, nothing secret in body', async () => {
    const user = await store.addUser({ email: 'admin@example.test', password: PASSWORD, role: 'admin' });
    build();
    const { res, cookie } = await login('  Admin@Example.TEST ');
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['csrfToken', 'expiresAt', 'permissions', 'user']);
    expect(body.user).toEqual({ id: user.id, email: 'admin@example.test', role: 'admin' });
    expect(body.permissions).toEqual(['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read']);
    expect(res.body).not.toMatch(/scrypt|passwordHash|password_hash/);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^__Host-nc_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
    expect(res.body).not.toContain(cookie?.split('=')[1]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(store.audit.map((a) => [a.event, a.outcome, a.actorUserId])).toEqual([['auth.login', 'success', user.id]]);
  });

  it('wrong password, unknown user, inactive user and malformed input all get the identical 401', async () => {
    const active = await store.addUser({ email: 'op@example.test', password: PASSWORD, role: 'operator' });
    const inactive = await store.addUser({ email: 'gone@example.test', password: PASSWORD, isActive: false });
    build();
    expectGenericLoginFailure((await login('op@example.test', 'Wrong-password-123')).res);
    expectGenericLoginFailure((await login('nobody@example.test')).res);
    expectGenericLoginFailure((await login('gone@example.test')).res);
    expectGenericLoginFailure((await login('not-an-email')).res);
    expectGenericLoginFailure((await login('op@example.test', 'short')).res);
    expect(store.sessions).toHaveLength(0);
    expect(store.audit.map((a) => [a.outcome, a.actorUserId, a.details.reason])).toEqual([
      ['failure', active.id, 'invalid_credentials'],
      ['failure', null, 'invalid_credentials'],
      ['failure', inactive.id, 'inactive_user'],
      ['failure', null, 'invalid_credentials'],
      ['failure', null, 'invalid_credentials'],
    ]);
    // Unknown/malformed email is never stored in the audit trail.
    expect(JSON.stringify(store.audit)).not.toMatch(/nobody@|not-an-email/);
  });

  it('unknown users still pay for a hash verification (dummy), malformed input does not reach the DB', async () => {
    build();
    await login('nobody@example.test');
    await login('not-an-email');
    expect(store.calls.findLoginUser).toBe(1);
  });

  it('missing fields → 400 validation; secrets never in logs', async () => {
    build();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { email: 'a@b.c' } });
    expect(res.statusCode).toBe(400);
    await login('x@example.test');
    expectNoSecrets(logs.text(), res.body, JSON.stringify(store.audit));
  });
});

describe('login rate limiting and hashing capacity', () => {
  it('per-account limit returns 429 with Retry-After before any lookup/hash', async () => {
    await store.addUser({ email: 'op@example.test', password: PASSWORD });
    build({ extra: { accountLimiter: createRateLimiter({ max: 2, windowMs: 60_000 }) } });
    await login('op@example.test', 'Wrong-password-1');
    await login('OP@example.test ', 'Wrong-password-2');
    const lookupsBefore = store.calls.findLoginUser;
    const res = (await login('op@example.test')).res;
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ statusCode: 429, error: 'Too Many Requests', message: 'Too many login attempts, try again later' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(store.calls.findLoginUser).toBe(lookupsBefore);
  });

  it('per-address limit applies across accounts', async () => {
    build({ extra: { addressLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }) } });
    await login('a@example.test');
    expect((await login('b@example.test')).res.statusCode).toBe(429);
  });

  it('hash capacity exhausted → 503 with Retry-After, never a login', async () => {
    await store.addUser({ email: 'op@example.test', password: PASSWORD });
    build({ extra: { hashLimiter: createLimiter(1, 0) } });
    const results = await Promise.all([login('op@example.test'), login('op@example.test')]);
    const statuses = results.map((r) => r.res.statusCode).sort();
    expect(statuses).toEqual([200, 503]);
    const busy = results.find((r) => r.res.statusCode === 503)?.res;
    expect(busy?.headers['retry-after']).toBe('1');
  });
});

describe('Origin / CSRF', () => {
  beforeEach(async () => { await store.addUser({ email: 'op@example.test', password: PASSWORD, role: 'operator' }); });

  it.each([
    ['missing Origin', {}],
    ['foreign Origin', { origin: 'https://evil.example' }],
    ['Origin with path-like suffix', { origin: `${ORIGIN}.evil.example` }],
    ['cross-site Sec-Fetch-Site', { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
  ])('login rejected with %s (login CSRF), nothing looked up', async (_name, hdrs) => {
    build();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: hdrs, payload: { email: 'op@example.test', password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ statusCode: 403, error: 'Forbidden', message: 'Request origin not allowed' });
    expect(store.calls.findLoginUser).toBeUndefined();
  });

  it('empty allowlist refuses every login (fail closed)', async () => {
    build({ config: { allowedOrigins: [] } });
    expect((await login('op@example.test')).res.statusCode).toBe(403);
  });

  it('logout requires Origin and the session-bound CSRF header', async () => {
    build();
    const a = await login('op@example.test');
    const b = await login('op@example.test');
    const logout = (hdrs: Record<string, string>) => app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: a.cookie ?? '', ...hdrs } });
    expect((await logout({ origin: ORIGIN })).statusCode).toBe(403); // no CSRF header
    expect((await logout({ origin: ORIGIN, 'x-csrf-token': 'x'.repeat(43) })).statusCode).toBe(403); // wrong token
    expect((await logout({ origin: ORIGIN, 'x-csrf-token': b.csrf ?? '' })).statusCode).toBe(403); // other session's token
    expect((await logout({ 'x-csrf-token': a.csrf ?? '' })).statusCode).toBe(403); // missing Origin
    expect((await logout({ origin: 'https://evil.example', 'x-csrf-token': a.csrf ?? '' })).statusCode).toBe(403);
    expect(store.sessions.filter((s) => s.revokedAt)).toHaveLength(0);
    expect((await logout({ origin: ORIGIN, 'x-csrf-token': a.csrf ?? '' })).statusCode).toBe(204);
  });
});

describe('sessions', () => {
  beforeEach(async () => { await store.addUser({ email: 'op@example.test', password: PASSWORD, role: 'operator' }); });
  const me = (cookie?: string) => app.inject({ method: 'GET', url: '/api/auth/me', headers: cookie ? { cookie } : {} });

  it('anonymous me → 401 no-store; garbage or unknown cookie → 401 and the cookie is cleared', async () => {
    build();
    const anon = await me();
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Authentication required' });
    expect(anon.headers['cache-control']).toBe('no-store');
    expect(anon.headers['set-cookie']).toBeUndefined();
    for (const bad of ['__Host-nc_session=garbage', `__Host-nc_session=${'A'.repeat(43)}`]) {
      const res = await me(bad);
      expect(res.statusCode).toBe(401);
      expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    }
  });

  it('me returns the same session info and CSRF token as login, without secrets', async () => {
    build();
    const { cookie, csrf, res } = await login('op@example.test');
    const info = await me(cookie);
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual(res.json());
    expect(info.json<{ csrfToken: string }>().csrfToken).toBe(csrf);
    expect(info.body).not.toContain(cookie?.split('=')[1]);
  });

  it('fixation: login with an existing session issues a new token and revokes the old one', async () => {
    build();
    const first = await login('op@example.test');
    const second = await login('op@example.test', PASSWORD, { cookie: first.cookie ?? '' });
    expect(second.cookie).not.toBe(first.cookie);
    expect((await me(first.cookie)).statusCode).toBe(401);
    expect((await me(second.cookie)).statusCode).toBe(200);
  });

  it('expired sessions are not authenticated', async () => {
    build();
    const { cookie } = await login('op@example.test');
    store.expireAll();
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('logout revokes the session, clears the cookie and is audited; the old cookie stops working', async () => {
    build();
    const { cookie, csrf } = await login('op@example.test');
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookie ?? '', origin: ORIGIN, 'x-csrf-token': csrf ?? '' } });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toBe('__Host-nc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(store.audit.at(-1)).toMatchObject({ event: 'auth.logout', outcome: 'success' });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('role and active flag are re-read on every request', async () => {
    const viewer = await store.addUser({ email: 'v@example.test', password: PASSWORD, role: 'viewer' });
    build();
    const { cookie } = await login('v@example.test');
    const audit = () => app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookie ?? '' } });
    expect((await audit()).statusCode).toBe(403);
    store.users.set(viewer.id, { ...viewer, role: 'admin' });
    expect((await audit()).statusCode).toBe(200);
    expect((await me(cookie)).json<{ user: { role: string } }>().user.role).toBe('admin');
    store.users.set(viewer.id, { ...viewer, role: 'admin', isActive: false });
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('insecure dev cookie mode uses nc_session without Secure', async () => {
    build({ config: { cookieSecure: false } });
    const { res, cookie } = await login('op@example.test');
    expect(String(res.headers['set-cookie'])).toMatch(/^nc_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
    expect((await me(cookie)).statusCode).toBe(200);
  });
});

describe('RBAC', () => {
  function withTestRoutes(a: FastifyInstance) {
    for (const permission of PERMISSIONS) {
      a.get(`/api/__test/${permission.replace(':', '-')}`, { config: { access: { permission } } }, () => ({ ok: true }));
    }
    a.post('/api/__test/write', { config: { access: { permission: 'processes:control' } } }, () => ({ ok: true }));
  }

  it('permission matrix: every role × permission → 200 or 403 (+ authz.denied audit)', async () => {
    for (const role of ROLES) await store.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
    build({ setup: withTestRoutes });
    for (const role of ROLES) {
      const { cookie } = await login(`${role}@example.test`);
      for (const permission of PERMISSIONS) {
        const res = await app.inject({ method: 'GET', url: `/api/__test/${permission.replace(':', '-')}`, headers: { cookie: cookie ?? '' } });
        expect([role, permission, res.statusCode]).toEqual([role, permission, ROLE_PERMISSIONS[role].includes(permission) ? 200 : 403]);
      }
    }
    const denied = store.audit.filter((a) => a.event === 'authz.denied');
    expect(denied.length).toBe(ROLES.length * PERMISSIONS.length - Object.values(ROLE_PERMISSIONS).flat().length);
    expect(denied[0]?.details).toEqual({ permission: expect.any(String) as string, route: expect.stringMatching(/^\/api\/__test\//) as string });
  });

  it('401 before 403; state-changing protected routes also need Origin + CSRF', async () => {
    await store.addUser({ email: 'op@example.test', password: PASSWORD, role: 'operator' });
    build({ setup: withTestRoutes });
    expect((await app.inject({ method: 'GET', url: '/api/__test/audit-read' })).statusCode).toBe(401);
    const { cookie, csrf } = await login('op@example.test');
    const write = (hdrs: Record<string, string>) => app.inject({ method: 'POST', url: '/api/__test/write', headers: { cookie: cookie ?? '', ...hdrs } });
    expect((await write({ origin: ORIGIN })).statusCode).toBe(403);
    expect((await write({ origin: ORIGIN, 'x-csrf-token': csrf ?? '' })).statusCode).toBe(200);
  });

  it('a client cannot claim a role: headers/body are ignored', async () => {
    await store.addUser({ email: 'v@example.test', password: PASSWORD, role: 'viewer' });
    build({ setup: withTestRoutes });
    const { cookie } = await login('v@example.test');
    const res = await app.inject({ method: 'GET', url: '/api/__test/audit-read?role=admin', headers: { cookie: cookie ?? '', 'x-role': 'admin' } });
    expect(res.statusCode).toBe(403);
  });

  it('deny by default: an /api route without config.access fails at registration', async () => {
    build();
    expect(() => app.get('/api/forgot-access', () => ({}))).toThrow(/must declare config.access/);
    await Promise.resolve();
  });

  it('denied access stays denied when the audit write fails', async () => {
    await store.addUser({ email: 'v@example.test', password: PASSWORD, role: 'viewer' });
    build();
    const { cookie } = await login('v@example.test');
    store.failAuditWrites = true;
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookie ?? '' } });
    expect(res.statusCode).toBe(403);
    expect(logs.text()).toContain('Audit write failed; request still denied');
  });
});

describe('audit API', () => {
  it('admin pages through events in stable descending order with bounded size', async () => {
    await store.addUser({ email: 'admin@example.test', password: PASSWORD, role: 'admin' });
    build();
    const { cookie } = await login('admin@example.test');
    for (let i = 0; i < 4; i++) await login('nobody@example.test'); // 4 failure events → 5 total
    const get = (qs: string) => app.inject({ method: 'GET', url: `/api/audit${qs}`, headers: { cookie: cookie ?? '' } });
    const first = await get('?limit=2');
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const page1 = first.json<{ items: { id: string }[]; nextBeforeId: string | null }>();
    expect(page1.items.map((i) => i.id)).toEqual(['5', '4']);
    expect(page1.nextBeforeId).toBe('4');
    const page2 = (await get(`?limit=2&beforeId=${page1.nextBeforeId ?? ''}`)).json<{ items: { id: string }[]; nextBeforeId: string | null }>();
    expect(page2.items.map((i) => i.id)).toEqual(['3', '2']);
    const page3 = (await get(`?limit=2&beforeId=2`)).json<{ items: { id: string }[]; nextBeforeId: string | null }>();
    expect(page3).toMatchObject({ items: [{ id: '1' }], nextBeforeId: null });
    expect((await get('')).json<{ items: unknown[] }>().items).toHaveLength(5);
  });

  it.each(['?limit=0', '?limit=101', '?limit=abc', '?beforeId=0', '?beforeId=-1', '?beforeId=1e3'])('rejects %s with 400', async (qs) => {
    await store.addUser({ email: 'admin@example.test', password: PASSWORD, role: 'admin' });
    build();
    const { cookie } = await login('admin@example.test');
    expect((await app.inject({ method: 'GET', url: `/api/audit${qs}`, headers: { cookie: cookie ?? '' } })).statusCode).toBe(400);
  });
});

describe('database failures fail closed', () => {
  beforeEach(async () => { await store.addUser({ email: 'op@example.test', password: PASSWORD, role: 'admin' }); });

  it('lookup outage → 503 Retry-After, no cookie', async () => {
    build();
    store.failing.add('findLoginUser');
    const { res } = await login('op@example.test');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ statusCode: 503, error: 'Service Unavailable', message: 'Service temporarily unavailable' });
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body + logs.text()).not.toContain('ECONNREFUSED 127.0.0.1');
  });

  it('audit write failure inside login transaction → 503 and no session is created', async () => {
    build();
    store.failAuditWrites = true;
    const { res } = await login('op@example.test');
    expect(res.statusCode).toBe(503);
    expect(store.sessions).toHaveLength(0);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('failed-login audit failure still returns 401 (never grants access)', async () => {
    build();
    store.failAuditWrites = true;
    expectGenericLoginFailure((await login('op@example.test', 'Wrong-password-123')).res);
  });

  it('session lookup outage → 503 on protected routes (not 200, not 401)', async () => {
    build();
    const { cookie } = await login('op@example.test');
    store.failing.add('resolveSession');
    expect((await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: cookie ?? '' } })).statusCode).toBe(503);
  });

  it('logout audit failure → 503 and the session stays valid (atomic revoke + audit)', async () => {
    build();
    const { cookie, csrf } = await login('op@example.test');
    store.failAuditWrites = true;
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookie ?? '', origin: ORIGIN, 'x-csrf-token': csrf ?? '' } });
    expect(res.statusCode).toBe(503);
    store.failAuditWrites = false;
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie ?? '' } })).statusCode).toBe(200);
  });
});

describe('non-auth behaviour preserved', () => {
  it('health endpoints stay public; no CORS headers', async () => {
    build();
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('session token and CSRF token never appear in logs', async () => {
    await store.addUser({ email: 'op@example.test', password: PASSWORD });
    build();
    const { cookie, csrf } = await login('op@example.test');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookie ?? '', origin: ORIGIN, 'x-csrf-token': csrf ?? '' } });
    const token = cookie?.split('=')[1] ?? 'missing';
    expect(logs.text()).not.toContain(token);
    expect(logs.text()).not.toContain(csrf ?? 'missing');
    expectNoSecrets(logs.text());
  });
});
