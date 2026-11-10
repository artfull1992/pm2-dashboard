import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import type { Scope } from '../src/auth/scope.js';
import type { ProjectInfoFields } from '../src/servers/project-info.js';
import type { ProjectInfoStore, ProjectInfoView, SaveProjectInfoResult } from '../src/servers/project-info-store.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeServerStore } from './support/fake-server-store.js';

// Project information API (ADR-036): read = monitoring:read + the scope handed to the store; save = admin only, Origin +
// CSRF, strict body, normalised values, documented status mapping, values never in logs. The SQL semantics (scope,
// revision, audit, identity) are covered on PostgreSQL by test/db/project-info.test.ts.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Project-Info-Passw0rd';
const SECRET = 'SYNTHETIC_PROJECT_INFO_DB_SECRET_41';
const MARK = 'SYNTHETIC-PROJECT-DESCRIPTION-MARK-93';
const SERVER = '22222222-2222-4222-8222-222222222222';
let app: FastifyInstance;
let auth: FakeAuthStore;
let logs: ReturnType<typeof captureLogs>;

const info = (over: Partial<ProjectInfoView> = {}): ProjectInfoView => ({
  serverId: SERVER, serviceName: 'api', githubUrl: null, projectUrl: null, description: null, revision: 0, updatedAt: null, ...over,
});

class StubStore implements ProjectInfoStore {
  gets: { serverId: string; serviceName: string; scope: Scope }[] = [];
  saves: { actor: { userId: string }; serverId: string; serviceName: string; expectedRevision: number; value: ProjectInfoFields }[] = [];
  getResult: ProjectInfoView | null = info();
  saveResult: SaveProjectInfoResult = { status: 'ok', info: info({ revision: 1 }), changed: true };
  failing = false;
  private check() { if (this.failing) throw Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }); }
  get(input: { serverId: string; serviceName: string; scope: Scope }) { this.check(); this.gets.push(input); return Promise.resolve(this.getResult); }
  save(input: { actor: { userId: string; sessionId: string }; serverId: string; serviceName: string; expectedRevision: number; value: ProjectInfoFields }) {
    this.check(); this.saves.push(input); return Promise.resolve(this.saveResult);
  }
}
let store: StubStore;

beforeEach(() => {
  auth = new FakeAuthStore();
  store = new StubStore();
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createServerStore: () => new FakeServerStore(), createProjectInfoStore: () => store,
      userAdminLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
});
afterEach(async () => { await app.close(); });

async function session(role: Role) {
  const user = await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { id: user.id, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof session>>;
const url = (service: string, server = SERVER) => `/api/servers/${server}/project-info?${new URLSearchParams({ service }).toString()}`;
const get = (s: Session | null, path: string) => app.inject({ method: 'GET', url: path, headers: s ? { cookie: s.cookie } : {} });
const body = (over: Record<string, unknown> = {}) => ({
  serviceName: 'api', expectedRevision: 0, githubUrl: 'https://github.com/acme/api', projectUrl: 'https://api.example.com', description: 'API', ...over,
});
const put = (s: Session | null, payload: unknown, headers: Record<string, string> = {}, server = SERVER) => app.inject({
  method: 'PUT', url: `/api/servers/${server}/project-info`,
  headers: { ...(s ? { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } : {}), ...headers }, payload: payload as object,
});

describe('read', () => {
  it('anonymous → 401; every role reads with its own scope (admin global, others their user id)', async () => {
    expect((await get(null, url('api'))).statusCode).toBe(401);
    for (const role of ['admin', 'operator', 'viewer'] as const) {
      const s = await session(role);
      const res = await get(s, url('api'));
      expect(res.statusCode, role).toBe(200);
      expect(res.json()).toEqual(info());
      expect(store.gets.at(-1)).toEqual({ serverId: SERVER, serviceName: 'api', scope: role === 'admin' ? null : s.id });
    }
  });

  it('not visible / unknown → 404 without telling which', async () => {
    const s = await session('viewer');
    store.getResult = null;
    const res = await get(s, url('api'));
    expect(res.statusCode).toBe(404);
    expect(res.json<{ message: string }>().message).toBe('Application not found');
  });

  it('any valid PM2 name is passed as data in the query (spaces, slashes, ?, #, %, unicode)', async () => {
    const s = await session('admin');
    for (const name of ['my app', 'api/v1', 'a?b', 'a#b', '100%', 'сервіс-1', '../x', 'a&service=b']) {
      store.getResult = info({ serviceName: name });
      expect((await get(s, url(name))).statusCode, name).toBe(200);
      expect(store.gets.at(-1)?.serviceName).toBe(name);
    }
  });

  it('bad parameters → 400 before the store: missing/empty/control-character/too long name, unknown parameter, bad id', async () => {
    const s = await session('admin');
    for (const path of [`/api/servers/${SERVER}/project-info`, url(''), url('a\u0001b'), url('x'.repeat(129)), `${url('api')}&extra=1`, url('api', 'not-a-uuid')]) {
      expect((await get(s, path)).statusCode, path).toBe(400);
    }
    expect(store.gets).toHaveLength(0);
  });

  it('a store failure → 503 with Retry-After and nothing of the error in the answer', async () => {
    const s = await session('admin');
    store.failing = true;
    const res = await get(s, url('api'));
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).not.toContain(SECRET);
  });
});

describe('save', () => {
  it('applications:metadata:write: anonymous 401 (403 without Origin), viewer 403 — nothing reaches the store', async () => {
    expect((await put(null, body())).statusCode).toBe(403);
    expect((await put(null, body(), { origin: ORIGIN })).statusCode).toBe(401);
    const viewer = await session('viewer');
    expect((await put(viewer, body())).statusCode).toBe(403);
    expect(store.saves).toHaveLength(0);
  });

  it('operator: the save reaches the store with the operator as actor (the grant is checked there, in the transaction)', async () => {
    const s = await session('operator');
    expect((await put(s, body())).statusCode).toBe(200);
    expect(store.saves).toEqual([expect.objectContaining({ actor: { userId: s.id, sessionId: expect.any(String) as string }, serverId: SERVER, serviceName: 'api' })]);
    // A service outside the operator's grants is answered by the store as not found: 404, nothing disclosed.
    store.saveResult = { status: 'not_found' };
    const res = await put(s, body());
    expect(res.statusCode).toBe(404);
    expect(res.json<{ message: string }>().message).toBe('Application not found');
  });

  it('the new permission is not servers:manage / users:manage: an operator still gets 403 on server registry, credentials and users', async () => {
    const s = await session('operator');
    const headers = { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf };
    expect((await app.inject({ method: 'POST', url: '/api/servers', headers, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/agent-credentials`, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/servers/${SERVER}/agent-credentials/revoke`, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: s.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: s.cookie } })).statusCode).toBe(403);
  });

  it('admin without CSRF token or with a foreign Origin → 403', async () => {
    const s = await session('admin');
    expect((await put(s, body(), { 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await put(s, body(), { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(store.saves).toHaveLength(0);
  });

  it('admin save: normalised values, the actor and the expected revision go to the store; the saved state is returned', async () => {
    const s = await session('admin');
    const saved = info({ revision: 3, githubUrl: 'https://github.com/acme/api', updatedAt: new Date(0).toISOString() });
    store.saveResult = { status: 'ok', info: saved, changed: true };
    const res = await put(s, body({ expectedRevision: 2, githubUrl: ' https://github.com/acme/api ', projectUrl: '', description: ` ${MARK}\r\nline 2 ` }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(saved);
    expect(store.saves).toEqual([{
      actor: { userId: s.id, sessionId: expect.any(String) as string }, serverId: SERVER, serviceName: 'api', expectedRevision: 2,
      value: { githubUrl: 'https://github.com/acme/api', projectUrl: null, description: `${MARK}\nline 2` }, requestId: expect.any(String) as string,
    }]);
    // Values are data: neither the description nor the URLs are written to the operational log.
    expect(logs.text()).not.toContain(MARK);
    expect(logs.text()).not.toContain('api.example.com');
  });

  it('status mapping: 404 not found, 409 conflict, 401 when the admin was revoked meanwhile', async () => {
    const s = await session('admin');
    store.saveResult = { status: 'not_found' };
    expect((await put(s, body())).statusCode).toBe(404);
    store.saveResult = { status: 'revision_conflict' };
    const conflict = await put(s, body());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ message: string }>().message).toMatch(/changed by someone else/);
    store.saveResult = { status: 'actor_revoked' };
    expect((await put(s, body())).statusCode).toBe(401);
    store.saveResult = { status: 'forbidden' }; // the role lost the permission meanwhile
    expect((await put(s, body())).statusCode).toBe(403);
  });

  it('invalid values → 400 with a fixed message, never echoing the value', async () => {
    const s = await session('admin');
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ githubUrl: 'javascript:alert(1)' }, /GitHub must be a repository address/],
      [{ githubUrl: 'https://user:pw@github.com/o/r' }, /GitHub must be a repository address/],
      [{ projectUrl: 'javascript:alert(1)' }, /explicit http/],
      [{ projectUrl: 'https://user:pw@example.com' }, /explicit http/],
      [{ projectUrl: 'data:text/html,x' }, /explicit http/],
      [{ description: 'bell\u0007' }, /plain text/],
      [{ description: 'x'.repeat(2001) }, /too long/],
    ];
    for (const [over, message] of cases) {
      const res = await put(s, body(over));
      expect(res.statusCode, JSON.stringify(over).slice(0, 60)).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(message);
      expect(res.body).not.toContain('alert(1)');
      expect(res.body).not.toContain(':pw@');
    }
    expect(store.saves).toHaveLength(0);
  });

  it('strict body → 400: unknown field, missing field, wrong types, URL over 2048, negative revision, bad name or id', async () => {
    const s = await session('admin');
    const missing = { serviceName: 'api', expectedRevision: 0, projectUrl: null, description: null };
    const bad: [unknown, string][] = [
      [{ ...body(), secret: 'x' }, 'unknown field'], [missing, 'missing field'], [body({ expectedRevision: -1 }), 'negative revision'],
      [body({ githubUrl: 1 }), 'number url'], [body({ expectedRevision: 1.5 }), 'fractional revision'],
      [body({ projectUrl: `https://example.com/${'a'.repeat(2048)}` }), 'url too long'], [body({ serviceName: '' }), 'empty name'],
      [body({ serviceName: 'a\nb' }), 'control in name'], [body({ serviceName: 'x'.repeat(129) }), 'name too long'],
    ];
    for (const [payload, why] of bad) expect((await put(s, payload)).statusCode, why).toBe(400);
    expect((await put(s, body(), {}, 'nope')).statusCode).toBe(400);
    expect(store.saves).toHaveLength(0);
  });

  it('null and empty strings clear fields', async () => {
    const s = await session('admin');
    expect((await put(s, body({ githubUrl: null, projectUrl: '', description: '   ' }))).statusCode).toBe(200);
    expect(store.saves[0]?.value).toEqual({ githubUrl: null, projectUrl: null, description: null });
  });

  it('a store failure → 503 without details', async () => {
    const s = await session('admin');
    store.failing = true;
    const res = await put(s, body());
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(SECRET);
  });

  it('per-admin rate limit → 429 with Retry-After', async () => {
    await app.close();
    app = buildApp({
      logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
      auth: {
        config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
        createStore: () => auth, createServerStore: () => new FakeServerStore(), createProjectInfoStore: () => store,
        userAdminLimiter: createRateLimiter({ max: 1, windowMs: 60_000 }),
        extra: {
          accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
          agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        },
      },
    });
    const s = await session('admin');
    expect((await put(s, body())).statusCode).toBe(200);
    const limited = await put(s, body());
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
