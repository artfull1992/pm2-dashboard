import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLimiter } from '../src/auth/password.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { decodeCursor, encodeCursor, INVENTORY_MAX_PROCESSES, type InventoryProcess, toInventoryReport } from '../src/servers/inventory.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeInventoryStore } from './support/fake-inventory-store.js';
import { FakeServerStore } from './support/fake-server-store.js';

// Read-only PM2 inventory API (Task 008, ADR-016): machine route for the Agent, browser read routes.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Inventory-Passw0rd';
const SECRET = 'SYNTHETIC_INVENTORY_SECRET_77';
let app: FastifyInstance;
let auth: FakeAuthStore;
let servers: FakeServerStore;
let inventory: FakeInventoryStore;
let logs: ReturnType<typeof captureLogs>;

function build(extra: { inventoryConcurrency?: number } = {}) {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth,
      createServerStore: () => servers,
      createInventoryStore: () => inventory,
      ...(extra.inventoryConcurrency !== undefined ? { inventoryLimiter: createLimiter(extra.inventoryConcurrency, 0) } : {}),
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
  return app;
}

beforeEach(() => { auth = new FakeAuthStore(); servers = new FakeServerStore(); inventory = new FakeInventoryStore(servers); });
afterEach(async () => { await app.close(); });

async function session(role: Role) {
  await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof session>>;

async function provisioned(admin: Session, name = 'node-1') {
  const headers = { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf };
  const created = await app.inject({ method: 'POST', url: '/api/servers', headers, payload: { name } });
  const serverId = created.json<{ id: string }>().id;
  const issued = await app.inject({ method: 'POST', url: `/api/servers/${serverId}/agent-credentials`, headers });
  return { serverId, token: issued.json<{ token: string }>().token };
}

const proc = (pmId: number, overrides: Partial<InventoryProcess> = {}): InventoryProcess => ({
  pmId, name: `app-${String(pmId)}`, status: 'online', uptimeSeconds: 60, restarts: 0, cpuPercent: 1.5, memoryBytes: 1024, execMode: 'fork', ...overrides,
});
const ok = (processes: InventoryProcess[], capturedAt = '2026-10-13T12:00:00.000Z') =>
  ({ version: 1, state: 'ok', reason: null, source: 'pm2', capturedAt, processes });
const report = (token: string | null, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/agent/inventory', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as object });

describe('machine route POST /api/agent/inventory', () => {
  it('valid report → 200 accepted with interval; identity from the credential only', async () => {
    build();
    const admin = await session('admin');
    const a = await provisioned(admin, 'a');
    const res = await report(a.token, ok([proc(0), proc(1)]));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; receivedAt: string; intervalSeconds: number }>();
    expect(body).toMatchObject({ status: 'accepted', intervalSeconds: 60 });
    expect(new Date(body.receivedAt).toISOString()).toBe(body.receivedAt);
    expect(res.headers['cache-control']).toBe('no-store');
    expect([...inventory.rows.keys()]).toEqual([a.serverId]);
  });

  it('a serverId (or any extra field) in the payload is rejected — identity cannot be spoofed', async () => {
    build();
    const admin = await session('admin');
    const a = await provisioned(admin, 'a');
    const b = await provisioned(admin, 'b');
    expect((await report(a.token, { ...ok([proc(0)]), serverId: b.serverId })).statusCode).toBe(400);
    expect((await report(a.token, ok([{ ...proc(0), env: { X: SECRET } } as unknown as InventoryProcess]))).statusCode).toBe(400);
    expect(inventory.rows.size).toBe(0);
    expect(logs.text()).not.toContain(SECRET);
  });

  it('missing/invalid/revoked token → 401; browser context → 403; session cookie → 401; nothing written', async () => {
    build();
    const admin = await session('admin');
    const a = await provisioned(admin, 'a');
    expect((await report(null, ok([]))).statusCode).toBe(401);
    expect((await report(`ncag_${'x'.repeat(43)}`, ok([]))).statusCode).toBe(401);
    expect((await report(a.token, ok([]), { origin: ORIGIN })).statusCode).toBe(403);
    expect((await report(a.token, ok([]), { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(403);
    expect((await report(a.token, ok([]), { cookie: admin.cookie })).statusCode).toBe(401);
    // A browser session cannot use the machine route either.
    expect((await app.inject({ method: 'POST', url: '/api/agent/inventory', headers: { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf }, payload: ok([]) })).statusCode).toBe(403);
    const headers = { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf };
    await app.inject({ method: 'POST', url: `/api/servers/${a.serverId}/agent-credentials/revoke`, headers });
    expect((await report(a.token, ok([]))).statusCode).toBe(401);
    expect(inventory.rows.size).toBe(0);
  });

  it.each([
    ['too many processes', () => ok(Array.from({ length: INVENTORY_MAX_PROCESSES + 1 }, (_, i) => proc(i)))],
    ['duplicate pmId', () => ok([proc(1), proc(1)])],
    ['impossible timestamp', () => ok([proc(0)], '2026-02-31T00:00:00.000Z')],
    ['ok without source', () => ({ ...ok([]), source: null })],
    ['ok with reason', () => ({ ...ok([]), reason: 'timeout' })],
    ['stale with processes', () => ({ ...ok([proc(0)]), state: 'stale' })],
    ['unavailable without reason', () => ({ ...ok([]), state: 'unavailable' })],
    ['unavailable with processes', () => ({ ...ok([proc(0)]), state: 'unavailable', reason: 'timeout' })],
    ['unknown reason', () => ({ ...ok([]), state: 'unavailable', reason: 'because' })],
    ['unknown status', () => ok([proc(0, { status: 'hacked' as never })])],
    ['control chars in name', () => ok([proc(0, { name: 'a\u001b[31m' })])],
    ['negative memory', () => ok([proc(0, { memoryBytes: -1 })])],
    ['fractional pmId', () => ok([proc(0.5)])],
    ['bad source', () => ({ ...ok([]), source: 'PM2 Prod' })],
    ['version 2', () => ({ ...ok([]), version: 2 })],
    ['not an object', () => [ok([])]],
  ])('%s → 400 without writing', async (_name, payload) => {
    build();
    const a = await provisioned(await session('admin'), 'a');
    expect((await report(a.token, payload())).statusCode).toBe(400);
    expect(inventory.calls).toBe(0);
  });

  it('body over the limit → 413 before any DB work', async () => {
    build();
    const a = await provisioned(await session('admin'), 'a');
    const huge = { ...ok([proc(0)]), padding: 'x'.repeat(600 * 1024) };
    expect((await report(a.token, huge)).statusCode).toBe(413);
    expect(inventory.calls).toBe(0);
  });

  it('unavailable and stale reports are accepted (they keep the last collected processes)', async () => {
    build();
    const a = await provisioned(await session('admin'), 'a');
    expect((await report(a.token, ok([proc(0)]))).json()).toMatchObject({ status: 'accepted' });
    expect((await report(a.token, { version: 1, state: 'unavailable', reason: 'snapshot_missing', source: null, capturedAt: null, processes: [] })).statusCode).toBe(200);
    expect(inventory.rows.get(a.serverId)?.processes).toHaveLength(1);
    expect((await report(a.token, { version: 1, state: 'stale', reason: null, source: 'pm2', capturedAt: '2026-10-13T12:00:00.000Z', processes: [] })).statusCode).toBe(200);
    expect(inventory.rows.get(a.serverId)).toMatchObject({ state: 'stale' });
    expect((await report(a.token, ok([], '2026-10-13T11:00:00.000Z'))).json()).toMatchObject({ status: 'ignored' });
  });

  it('concurrency limit → 503; store failure → 503 with metadata-only logs', async () => {
    build({ inventoryConcurrency: 1 });
    const a = await provisioned(await session('admin'), 'a');
    let release!: () => void;
    inventory.gate = new Promise((r) => { release = r; });
    const first = report(a.token, ok([proc(0)]));
    await new Promise((r) => setTimeout(r, 20));
    const second = await report(a.token, ok([proc(0)], '2026-10-13T12:00:30.000Z'));
    expect(second.statusCode).toBe(503);
    release();
    expect((await first).statusCode).toBe(200);
    inventory.gate = null;
    inventory.failing = true;
    const failed = await report(a.token, ok([proc(0, { name: SECRET })], '2026-10-13T12:01:00.000Z'));
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['retry-after']).toBe('5');
    expect(logs.text()).not.toContain(SECRET);
    expect(logs.text()).not.toContain(a.token);
  });
});

describe('browser routes', () => {
  async function seeded() {
    build();
    const admin = await session('admin');
    const a = await provisioned(admin, 'alpha');
    const b = await provisioned(admin, 'beta');
    await report(a.token, ok([proc(0, { name: 'api' }), proc(1, { name: 'worker', status: 'stopped' }), proc(2, { name: '<img src=x onerror=alert(1)>' })]));
    await report(b.token, ok([proc(0, { name: 'api' })]));
    return { admin, a, b };
  }

  it.each(['viewer', 'operator', 'admin'] as const)('%s can read applications (monitoring:read)', async (role) => {
    const { a } = await seeded();
    const s = role === 'admin' ? null : await session(role);
    const cookie = s?.cookie ?? (await (async () => { const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'admin@example.test', password: PASSWORD } }); const raw = r.headers['set-cookie']; return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? ''; })());
    const list = await app.inject({ method: 'GET', url: '/api/applications', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(4);
    const forServer = await app.inject({ method: 'GET', url: `/api/servers/${a.serverId}/applications`, headers: { cookie } });
    expect(forServer.statusCode).toBe(200);
    expect(forServer.json()).toMatchObject({ serverId: a.serverId, inventory: { state: 'current', processCount: 3 }, freshWindowSeconds: 180 });
  });

  it('anonymous → 401; agent bearer on browser routes → 401; no mutation routes exist', async () => {
    const { a } = await seeded();
    expect((await app.inject({ method: 'GET', url: '/api/applications' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${a.serverId}/applications` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/applications', headers: { authorization: `Bearer ${a.token}` } })).statusCode).toBe(401);
    const admin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'admin@example.test', password: PASSWORD } });
    const raw = admin.headers['set-cookie'];
    const headers = { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', origin: ORIGIN, 'x-csrf-token': admin.json<{ csrfToken: string }>().csrfToken };
    for (const url of ['/api/applications/x/restart', `/api/servers/${a.serverId}/applications/0/stop`, '/api/applications']) {
      expect((await app.inject({ method: 'POST', url, headers })).statusCode).toBe(404);
    }
  });

  it('filters, keyset pagination and validation', async () => {
    const { admin, a } = await seeded();
    const get = (qs: string) => app.inject({ method: 'GET', url: `/api/applications${qs}`, headers: { cookie: admin.cookie } });
    expect((await get(`?serverId=${a.serverId}`)).json<{ items: unknown[] }>().items).toHaveLength(3);
    expect((await get('?status=stopped')).json<{ items: { name: string }[] }>().items.map((i) => i.name)).toEqual(['worker']);
    const first = (await get('?limit=2')).json<{ items: { name: string }[]; nextCursor: string }>();
    expect(first.items).toHaveLength(2);
    const second = (await get(`?limit=2&cursor=${first.nextCursor}`)).json<{ items: { name: string }[]; nextCursor: string | null }>();
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i) => JSON.stringify(i))).size).toBe(4);
    for (const bad of ['?limit=0', '?limit=101', '?serverId=nope', '?status=hacked', '?cursor=***', '?cursor=bm9wZQ', '?other=1']) {
      expect((await get(bad)).statusCode).toBe(400);
    }
    // HTML-looking names are plain data in JSON (the UI renders them as text).
    expect((await get('')).body).toContain('<img src=x onerror=alert(1)>');
  });

  it('name search: case-insensitive substring with the other filters; trimmed; empty means none; invalid → 400', async () => {
    const { admin, a } = await seeded();
    const names = async (qs: string) => (await app.inject({ method: 'GET', url: `/api/applications${qs}`, headers: { cookie: admin.cookie } }))
      .json<{ items: { name: string }[] }>().items.map((i) => i.name);
    const all = await names('');
    expect(await names('?q=API')).toEqual(all.filter((n) => n.toLowerCase().includes('api')));
    expect(await names(`?q=${encodeURIComponent('  api ')}&serverId=${a.serverId}`)).toEqual(['api']);
    expect(await names('?q=api&status=stopped')).toEqual([]);
    expect(await names(`?q=${encodeURIComponent('   ')}`)).toEqual(all); // whitespace only = no search
    expect(await names('?q=')).toEqual(all);
    const status = async (qs: string) => (await app.inject({ method: 'GET', url: `/api/applications${qs}`, headers: { cookie: admin.cookie } })).statusCode;
    expect(await status(`?q=${'x'.repeat(129)}`)).toBe(400);
    expect(await status(`?q=${'x'.repeat(128)}`)).toBe(200);
    expect(await status(`?q=a${encodeURIComponent('\u0001')}b`)).toBe(400);
    expect(await status(`?q=${'y'.repeat(513)}`)).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/applications?q=api' })).statusCode).toBe(401);
  });

  it('a cursor belongs to its filters: another search/filter → 400; legacy cursors keep working without a search', async () => {
    const { admin } = await seeded();
    const get = (qs: string) => app.inject({ method: 'GET', url: `/api/applications${qs}`, headers: { cookie: admin.cookie } });
    const first = (await get('?limit=1&q=a')).json<{ nextCursor: string }>();
    expect((await get(`?limit=1&q=a&cursor=${first.nextCursor}`)).statusCode).toBe(200);
    expect((await get(`?limit=1&q=ap&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    expect((await get(`?limit=1&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    expect((await get(`?limit=1&status=online&q=a&cursor=${first.nextCursor}`)).statusCode).toBe(400);
    const legacy = encodeCursor({ name: 'a', serverId: '11111111-1111-4111-8111-111111111111', pmId: 0 });
    expect((await get(`?limit=1&cursor=${legacy}`)).statusCode).toBe(200);
    expect((await get(`?limit=1&status=online&cursor=${legacy}`)).statusCode).toBe(200);
    expect((await get(`?limit=1&q=a&cursor=${legacy}`)).statusCode).toBe(400);
  });

  it('server applications: unknown server 404, malformed id 400, never reported → not_reported', async () => {
    const { admin } = await seeded();
    const fresh = await provisioned(admin, 'gamma');
    const get = (id: string) => app.inject({ method: 'GET', url: `/api/servers/${id}/applications`, headers: { cookie: admin.cookie } });
    expect((await get('11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
    expect((await get('not-a-uuid')).statusCode).toBe(400);
    expect((await get(fresh.serverId)).json()).toMatchObject({ inventory: { state: 'not_reported', processCount: null }, items: [] });
  });

  it('store failure → 503', async () => {
    const { admin, a } = await seeded();
    inventory.failing = true;
    expect((await app.inject({ method: 'GET', url: '/api/applications', headers: { cookie: admin.cookie } })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${a.serverId}/applications`, headers: { cookie: admin.cookie } })).statusCode).toBe(503);
  });
});

describe('contract helpers', () => {
  it('cursor round-trips and rejects tampering', () => {
    const c = { name: 'api', serverId: '11111111-1111-4111-8111-111111111111', pmId: 3 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    for (const bad of [Buffer.from('[1,2,3]').toString('base64url'), Buffer.from('["a","x",1]').toString('base64url'), Buffer.from('{}').toString('base64url'), '%%%']) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it('toInventoryReport narrows only consistent reports', () => {
    expect(toInventoryReport({ version: 1, state: 'ok', reason: null, source: 'pm2', capturedAt: '2026-10-13T12:00:00.000Z', processes: [] })).not.toBeNull();
    expect(toInventoryReport({ version: 1, state: 'unavailable', reason: 'timeout', source: null, capturedAt: null, processes: [] })).not.toBeNull();
    expect(toInventoryReport({ version: 1, state: 'stale', reason: null, source: null, capturedAt: '2026-10-13T12:00:00.000Z', processes: [] })).toBeNull();
  });
});
