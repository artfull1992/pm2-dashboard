import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AccessStore, GrantInput, SaveResult, UserAccessView } from '../src/auth/access-store.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeServerStore } from './support/fake-server-store.js';

// Resource grants administration API (ADR-028): admin only (users:manage), Origin + CSRF for the change, strict body,
// documented status mapping. Grant semantics (atomicity, revision, audit, scope) are covered by test/db/access.test.ts.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Access-Passw0rd';
const SECRET = 'SYNTHETIC_ACCESS_API_SECRET_77';
const TARGET = '11111111-1111-4111-8111-111111111111';
const SERVER = '22222222-2222-4222-8222-222222222222';
let app: FastifyInstance;
let auth: FakeAuthStore;
let logs: ReturnType<typeof captureLogs>;

const view = (over: Partial<UserAccessView> = {}): UserAccessView => ({
  userId: TARGET, email: 'op@example.test', role: 'operator', isActive: true, global: false, revision: 1,
  servers: [{ serverId: SERVER, serverName: 'alpha', serverActive: true, mode: 'selected', grantedAt: new Date().toISOString(), services: [{ name: 'api', available: true }] }],
  ...over,
});

class StubAccessStore implements AccessStore {
  saves: { userId: string; expectedRevision: number; servers: GrantInput[]; actor: { userId: string } }[] = [];
  saveResult: SaveResult = { status: 'ok', access: view() };
  failing = false;
  searches: unknown[] = [];
  private check() { if (this.failing) throw Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }); }
  getAccess(userId: string) { this.check(); return Promise.resolve(userId === TARGET ? view() : null); }
  saveAccess(input: { actor: { userId: string; sessionId: string }; userId: string; expectedRevision: number; servers: GrantInput[] }) {
    this.check(); this.saves.push(input); return Promise.resolve(this.saveResult);
  }
  searchServers(input: unknown) { this.check(); this.searches.push(input); return Promise.resolve({ items: [{ id: SERVER, name: 'alpha', isActive: true }], nextAfterName: null }); }
  serverServices(input: { serverId: string }) { this.check(); return Promise.resolve(input.serverId === SERVER ? { items: [{ name: 'api', processes: 1 }], truncated: false } : null); }
}
let store: StubAccessStore;

function build() {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createServerStore: () => new FakeServerStore(), createAccessStore: () => store,
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
  return app;
}

beforeEach(() => { auth = new FakeAuthStore(); store = new StubAccessStore(); build(); });
afterEach(async () => { await app.close(); });

async function session(role: Role) {
  await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof session>>;
const get = (s: Session | null, url: string) => app.inject({ method: 'GET', url, headers: s ? { cookie: s.cookie } : {} });
const put = (s: Session | null, payload: unknown, headers: Record<string, string> = {}, id = TARGET) => app.inject({
  method: 'PUT', url: `/api/users/${id}/access`,
  headers: { ...(s ? { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } : {}), ...headers }, payload: payload as object,
});
const body = (over: Record<string, unknown> = {}) => ({ expectedRevision: 1, servers: [{ serverId: SERVER, mode: 'selected', services: ['api'] }], ...over });
const ROUTES = [`/api/users/${TARGET}/access`, '/api/access/servers', `/api/access/servers/${SERVER}/services`];

describe('authorization', () => {
  it('anonymous → 401; operator and viewer → 403 on every route (read and change); nothing reaches the store', async () => {
    for (const url of ROUTES) expect((await get(null, url)).statusCode, url).toBe(401);
    expect((await put(null, body())).statusCode).toBe(403); // no Origin: refused before authentication
    expect((await put(null, body(), { origin: ORIGIN })).statusCode).toBe(401);
    for (const role of ['operator', 'viewer'] as const) {
      const s = await session(role);
      for (const url of ROUTES) expect((await get(s, url)).statusCode, `${role} ${url}`).toBe(403);
      expect((await put(s, body())).statusCode, role).toBe(403);
      // An operator cannot grant itself access either.
      expect((await put(s, body(), {}, randomUUID())).statusCode).toBe(403);
    }
    expect(store.saves).toEqual([]);
    expect(store.searches).toEqual([]);
  });

  it('admin: read, search, services; the change needs Origin and CSRF', async () => {
    const s = await session('admin');
    expect((await get(s, `/api/users/${TARGET}/access`)).json()).toMatchObject({ userId: TARGET, revision: 1, servers: [{ mode: 'selected' }] });
    expect((await get(s, '/api/access/servers?q=al&limit=10')).json()).toEqual({ items: [{ id: SERVER, name: 'alpha', isActive: true }], nextAfterName: null });
    expect(store.searches).toEqual([{ q: 'al', limit: 10, afterName: null }]);
    expect((await get(s, `/api/access/servers/${SERVER}/services?q=a`)).json()).toEqual({ serverId: SERVER, items: [{ name: 'api', processes: 1 }], truncated: false });
    expect((await get(s, `/api/access/servers/${randomUUID()}/services`)).statusCode).toBe(404);
    expect((await get(s, `/api/users/${randomUUID()}/access`)).statusCode).toBe(404);
    expect((await put(s, body(), { 'x-csrf-token': 'x'.repeat(43) })).statusCode).toBe(403);
    expect((await put(s, body(), { origin: 'https://evil.example.test' })).statusCode).toBe(403);
    expect(store.saves).toEqual([]);
    const ok = await put(s, body());
    expect(ok.statusCode).toBe(200);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toMatchObject({ userId: TARGET, expectedRevision: 1, servers: [{ serverId: SERVER, mode: 'selected', services: ['api'] }] });
  });
});

describe('validation and status mapping', () => {
  it('strict body: no extra fields, known modes, bounded names without control characters, unique services', async () => {
    const s = await session('admin');
    const bad: unknown[] = [
      { servers: [] }, body({ extra: 1 }), body({ expectedRevision: -1 }),
      body({ servers: [{ serverId: SERVER, mode: 'everything', services: [] }] }),
      body({ servers: [{ serverId: 'not-a-uuid', mode: 'all', services: [] }] }),
      body({ servers: [{ serverId: SERVER, mode: 'selected', services: ['a\nb'] }] }),
      body({ servers: [{ serverId: SERVER, mode: 'selected', services: ['x'.repeat(129)] }] }),
      body({ servers: [{ serverId: SERVER, mode: 'selected', services: ['api', 'api'] }] }),
      body({ servers: [{ serverId: SERVER, mode: 'selected', services: ['api'], role: 'admin' }] }),
      body({ servers: [{ serverId: SERVER, mode: 'selected', services: Array.from({ length: 501 }, (_, i) => `s${String(i)}`) }] }),
    ];
    for (const b of bad) expect((await put(s, b)).statusCode, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await put(s, body(), {}, 'nope')).statusCode).toBe(400);
    expect(store.saves).toEqual([]);
  });

  it('store results → 404 / 409 (stale revision, admin target) / 400 (invalid) / 401 (revoked actor); store failure → 503 without details', async () => {
    const s = await session('admin');
    const cases: [SaveResult, number][] = [
      [{ status: 'not_found' }, 404], [{ status: 'revision_conflict' }, 409], [{ status: 'role_global' }, 409],
      [{ status: 'invalid', reason: 'empty_selection', serverId: SERVER }, 400], [{ status: 'invalid', reason: 'unknown_service', serverId: SERVER, service: 'x' }, 400],
      [{ status: 'invalid', reason: 'unknown_server', serverId: SERVER }, 400],
    ];
    for (const [result, code] of cases) {
      store.saveResult = result;
      expect((await put(s, body())).statusCode, result.status).toBe(code);
    }
    store.saveResult = { status: 'actor_revoked' };
    expect((await put(s, body())).statusCode).toBe(401);
    store.failing = true;
    const failed = await put(s, body());
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain(SECRET);
    expect((await get(s, `/api/users/${TARGET}/access`)).statusCode).toBe(503);
    expect(logs.text()).not.toContain(SECRET);
  });
});
