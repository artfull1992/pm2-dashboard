import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { LOG_LIMITS, LogHub } from '../src/servers/logs.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAccessChecker } from './support/fake-access.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeServerStore } from './support/fake-server-store.js';

// Bounded authorized log viewing (Task 010, ADR-018): permissions, CSRF, machine/browser separation, request/result
// binding, deadlines, limits, audit without content, no log text in service logs.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Logs-Passw0rd';
const SECRET = 'SYNTHETIC_LOG_TEXT_MARKER_93ab';
let app: FastifyInstance;
let auth: FakeAuthStore;
let servers: FakeServerStore;
let hub: LogHub;
let access: FakeAccessChecker;
let clock: number;
let logs: ReturnType<typeof captureLogs>;

function build() {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createServerStore: () => servers, logHub: hub, accessChecker: access,
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
}

beforeEach(() => {
  auth = new FakeAuthStore(); servers = new FakeServerStore(); clock = Date.now(); hub = new LogHub(() => clock);
  // These lifecycle tests are not about grants (see the scope tests below): every user is treated as granted.
  access = new FakeAccessChecker(async (id) => (await servers.get(id, null)) !== null); access.allowUngranted = true;
  build();
});
afterEach(async () => { await app.close(); });

async function session(role: Role, email = `${role}@example.test`) {
  await auth.addUser({ email, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof session>>;

async function node(admin: Session, name = 'node-1') {
  const headers = { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf };
  const serverId = (await app.inject({ method: 'POST', url: '/api/servers', headers, payload: { name } })).json<{ id: string }>().id;
  const token = (await app.inject({ method: 'POST', url: `/api/servers/${serverId}/agent-credentials`, headers })).json<{ token: string }>().token;
  return { serverId, token };
}

const report = (over: Record<string, unknown> = {}) => ({
  version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: [{ targetKey: 'api', name: 'api', pmId: 0, matchStatus: 'ok' }], ...over,
});
const agentPoll = (token: string, body: unknown = report()) => app.inject({ method: 'POST', url: '/api/agent/logs/poll', headers: { authorization: `Bearer ${token}` }, payload: body as object });
const agentResult = (token: string, body: unknown) => app.inject({ method: 'POST', url: '/api/agent/logs/result', headers: { authorization: `Bearer ${token}` }, payload: body as object });
const create = (s: Session, serverId: string, body: unknown = { targetKey: 'api' }) =>
  app.inject({ method: 'POST', url: `/api/servers/${serverId}/log-requests`, headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf }, payload: body as object });
const getReq = (s: Session, id: string) => app.inject({ method: 'GET', url: `/api/log-requests/${id}`, headers: { cookie: s.cookie } });
const stream = (text: string) => ({ state: 'ok', text, lines: text.split('\n').length, truncated: false, sizeBytes: 100, modifiedAt: new Date().toISOString() });
const okResult = (requestId: string, text = `hello\n${SECRET}`) =>
  ({ version: 1, requestId, outcome: 'ok', reason: null, readAt: new Date().toISOString(), stdout: stream(text), stderr: stream('err') });

/** Starts an Agent long-poll (held by the API) and waits until the API has registered it. */
async function connected(n: { serverId: string; token: string }, body: unknown = report()): Promise<{ held: Promise<LightMyRequestResponse> }> {
  const held = agentPoll(n.token, body);
  await new Promise((r) => setTimeout(r, 30));
  return { held };
}

async function fullCycle(s: Session, n: { serverId: string; token: string }, text?: string) {
  const { held } = await connected(n);
  const created = await create(s, n.serverId);
  expect(created.statusCode).toBe(202);
  const delivered = (await held).json<{ requests: { requestId: string; targetKey: string; lines: number }[] }>();
  expect(delivered.requests).toHaveLength(1);
  const requestId = delivered.requests[0]?.requestId ?? '';
  expect(created.json<{ requestId: string }>().requestId).toBe(requestId);
  expect((await agentResult(n.token, okResult(requestId, text))).json()).toEqual({ status: 'recorded' });
  return requestId;
}

function noSecrets() {
  expect(logs.text()).not.toContain(SECRET);
  expect(JSON.stringify(auth.audit)).not.toContain(SECRET);
}

describe('permissions and CSRF', () => {
  it('viewer is denied (authz.denied); anonymous 401; operator and admin may read', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const viewer = await session('viewer');
    expect((await create(viewer, n.serverId)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets`, headers: { cookie: viewer.cookie } })).statusCode).toBe(403);
    expect(auth.audit.filter((a) => a.event === 'authz.denied').length).toBeGreaterThanOrEqual(2);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets` })).statusCode).toBe(401);
    for (const s of [admin, await session('operator')]) {
      expect((await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets`, headers: { cookie: s.cookie } })).statusCode).toBe(200);
    }
  });

  it('POST needs Origin + CSRF; a bearer token is not a browser credential; strict body', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const op = await session('operator');
    const url = `/api/servers/${n.serverId}/log-requests`;
    expect((await app.inject({ method: 'POST', url, headers: { cookie: op.cookie, 'x-csrf-token': op.csrf }, payload: { targetKey: 'api' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: op.cookie, origin: ORIGIN }, payload: { targetKey: 'api' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${n.token}`, origin: ORIGIN }, payload: { targetKey: 'api' } })).statusCode).toBe(401);
    for (const body of [{ targetKey: 'api', path: '/etc/passwd' }, { targetKey: '../x' }, { targetKey: 'api', lines: 101 }, { targetKey: 'api', lines: 0 }, {}]) {
      expect((await create(op, n.serverId, body)).statusCode).toBe(400);
    }
  });
});

describe('request lifecycle', () => {
  it('not connected / unsupported broker / target not allowed → 409 (denied is audited)', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    expect((await create(admin, n.serverId)).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets`, headers: { cookie: admin.cookie } })).json()).toMatchObject({ state: 'not_connected', targets: [] });
    await connected(n, report({ broker: 'unsupported', targets: [] }));
    expect((await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets`, headers: { cookie: admin.cookie } })).json()).toMatchObject({ state: 'unsupported' });
    expect((await create(admin, n.serverId)).statusCode).toBe(409);
    hub.close();
    const n2 = await node(admin, 'node-2');
    void connected(n2, report({ targets: [{ targetKey: 'api', name: 'api', pmId: null, matchStatus: 'fingerprint_mismatch' }] }));
    await new Promise((r) => setTimeout(r, 30));
    expect((await create(admin, n2.serverId)).statusCode).toBe(409);
    expect((await create(admin, n2.serverId, { targetKey: 'other' })).statusCode).toBe(409);
    expect(auth.audit.filter((a) => a.event === 'logs.view_denied')).toHaveLength(2);
    expect((await create(admin, randomUUID())).statusCode).toBe(404);
  }, 40_000);

  it('full cycle: request → agent → result → requester; another user cannot see it; text never logged or audited', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const op = await session('operator');
    const id = await fullCycle(op, n);
    const view = await getReq(op, id);
    expect(view.json()).toMatchObject({ requestId: id, serverId: n.serverId, targetKey: 'api', status: 'done', result: { outcome: 'ok', stdout: { text: `hello\n${SECRET}` } } });
    expect(view.headers['cache-control']).toBe('no-store');
    expect((await getReq(admin, id)).statusCode).toBe(404); // not the requester
    expect(auth.audit.filter((a) => a.event === 'logs.view_opened')).toEqual([expect.objectContaining({ details: { serverId: n.serverId, targetKey: 'api' } })]);
    noSecrets();
  });

  it('result binding: other server → 404; duplicate → 409; unknown id → 404; strict/oversized result rejected', async () => {
    const admin = await session('admin');
    const n = await node(admin, 'a');
    const m = await node(admin, 'b');
    const { held } = await connected(n);
    await create(admin, n.serverId);
    const requestId = (await held).json<{ requests: { requestId: string }[] }>().requests[0]?.requestId ?? '';
    expect((await agentResult(m.token, okResult(requestId))).statusCode).toBe(404);
    expect((await agentResult(n.token, { ...okResult(requestId), path: '/var/log/x' })).statusCode).toBe(400);
    expect((await agentResult(n.token, { ...okResult(requestId), outcome: 'ok', reason: 'timeout' })).statusCode).toBe(400);
    expect((await agentResult(n.token, okResult(requestId, 'x'.repeat(50 * 1024)))).statusCode).toBe(413);
    expect((await agentResult(n.token, okResult(requestId))).statusCode).toBe(200);
    expect((await agentResult(n.token, okResult(requestId))).statusCode).toBe(409);
    expect((await agentResult(n.token, okResult(randomUUID()))).statusCode).toBe(404);
    expect((await agentPoll('ncag_' + 'x'.repeat(43))).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/agent/logs/poll', headers: { authorization: `Bearer ${n.token}`, origin: ORIGIN }, payload: report() })).statusCode).toBe(403);
    noSecrets();
  });

  it('protocol v2 (ADR-028): an auto broker without allowlist; the reply declares scoped access; strict total/targets', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const v2 = (over: Record<string, unknown> = {}) => ({ version: 2, mode: 'auto', broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: report().targets, total: 1, ...over });
    const { held } = await connected(n, v2());
    expect((await create(admin, n.serverId)).statusCode).toBe(202);
    const reply = (await held).json<{ accessModel?: string; requests: unknown[] }>();
    expect(reply.accessModel).toBe('scoped');
    expect(reply.requests).toHaveLength(1);
    const many = Array.from({ length: 501 }, (_, i) => ({ targetKey: `n-${String(i)}`, name: `s${String(i)}`, pmId: i, matchStatus: 'ok' }));
    for (const b of [v2({ targets: many, total: 501 }), v2({ mode: 'open' }), { ...v2(), version: 1 }, v2({ total: -1 })]) {
      expect((await agentPoll(n.token, b)).statusCode).toBe(400);
    }
  });

  it('deadline: an unanswered request expires; a late result is refused; results are dropped after the TTL', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const { held } = await connected(n);
    const requestId = (await create(admin, n.serverId)).json<{ requestId: string }>().requestId;
    await held;
    clock += LOG_LIMITS.requestDeadlineMs + 1;
    expect((await getReq(admin, requestId)).json()).toMatchObject({ status: 'expired', result: null });
    expect((await agentResult(n.token, okResult(requestId))).statusCode).toBe(409);
    clock += LOG_LIMITS.resultTtlMs + 1;
    hub.cleanup();
    expect((await getReq(admin, requestId)).statusCode).toBe(404);
    expect(hub.stats().requests).toBe(0);
  });

  it('limits: ≤ 2 pending per user (503); opening is audited once per 10 min', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    await connected(n);
    expect((await create(admin, n.serverId)).statusCode).toBe(202);
    expect((await create(admin, n.serverId)).statusCode).toBe(202);
    expect((await create(admin, n.serverId)).statusCode).toBe(503);
    expect(auth.audit.filter((a) => a.event === 'logs.view_opened')).toHaveLength(1);
    clock += LOG_LIMITS.auditThrottleMs;
    clock += LOG_LIMITS.requestDeadlineMs + 1;
    await connected(n);
    expect((await create(admin, n.serverId)).statusCode).toBe(202);
    expect(auth.audit.filter((a) => a.event === 'logs.view_opened')).toHaveLength(2);
  });
});

describe('LogHub (bounded memory)', () => {
  const t = report().targets;
  it('rate limit 30/min per actor; finished requests do not count as pending', () => {
    let now = 1_000_000;
    const h = new LogHub(() => now);
    const serverId = randomUUID();
    const poll = () => h.agentPoll(serverId, { version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: t as never }, () => undefined);
    const results: string[] = [];
    for (let i = 0; i < 31; i++) {
      void poll();
      const r = h.create({ serverId, targetKey: 'api', serviceName: 'api', actorUserId: 'u1', lines: 10 });
      if (typeof r === 'string') { results.push(r); break; }
      h.agentResult(serverId, r.request.requestId, { outcome: 'ok', reason: null, readAt: new Date(now).toISOString(), stdout: null, stderr: null });
      now += 100;
    }
    expect(results).toEqual(['rate_limited']);
    now += 61_000;
    void poll();
    expect(typeof h.create({ serverId, targetKey: 'api', serviceName: 'api', actorUserId: 'u1', lines: 10 })).toBe('object');
    h.close();
  });

  it('a newer poll supersedes an older one; a closed poll frees its slot; close() releases everyone', async () => {
    const h = new LogHub();
    const serverId = randomUUID();
    let closeCb: (() => void) | undefined;
    const report1 = { version: 1 as const, broker: 'ok' as const, daemon: 'ok' as const, allowlist: 'ok' as const, targets: t as never };
    const first = h.agentPoll(serverId, report1, () => undefined);
    const second = h.agentPoll(serverId, report1, (cb) => { closeCb = cb; });
    expect(await first).toEqual([]);
    closeCb?.();
    expect(await second).toEqual([]);
    const third = h.agentPoll(serverId, report1, () => undefined);
    h.close();
    expect(await third).toEqual([]);
  });
});

describe('agent long-poll over real HTTP', () => {
  it('is held by the API (not answered as soon as the request body is read) and released when the client goes away', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const started = Date.now();
    const outcome = await fetch(`${address}/api/agent/logs/poll`, {
      method: 'POST', headers: { authorization: `Bearer ${n.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(report()), signal: AbortSignal.timeout(1_500),
    }).then(() => 'answered', (e: unknown) => (e instanceof Error ? e.name : 'error'));
    expect(outcome).toBe('TimeoutError'); // still held after 1.5 s
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    await new Promise((r) => setTimeout(r, 100));
    // The disconnected poll released its slot; the agent state is still known for request routing.
    expect((await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets`, headers: { cookie: admin.cookie } })).json()).toMatchObject({ state: 'supported' });
  });
});

// Task 010.1: result waiters (GET /api/log-requests/:id) are bounded per request, per actor and globally, and every
// exit path (result, deadline, wait timeout, client disconnect, shutdown) frees the waiter, its timer and its counters
// exactly once.
describe('result waiters (bounded)', () => {
  const t = report().targets;
  const rep = { version: 1 as const, broker: 'ok' as const, daemon: 'ok' as const, allowlist: 'ok' as const, targets: t as never };
  const ok = (now: number) => ({ outcome: 'ok' as const, reason: null, readAt: new Date(now).toISOString(), stdout: null, stderr: null });
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  function open(h: LogHub, serverId: string, actorUserId: string): string {
    void h.agentPoll(serverId, rep, () => undefined);
    const r = h.create({ serverId, targetKey: 'api', serviceName: 'api', actorUserId, lines: 10 });
    if (typeof r === 'string') throw new Error(r);
    return r.request.requestId;
  }
  const consistent = (h: LogHub) => { const s = h.stats(); expect(s.waiters).toBe(s.waitersInRequests); return s; };

  it('1000 concurrent GETs of one request: only maxWaitersPerRequest wait, the rest are refused before any timer; the result wakes the allowed ones', async () => {
    const h = new LogHub();
    const serverId = randomUUID();
    const id = open(h, serverId, 'u1');
    const before = timeouts();
    const all = Array.from({ length: 1000 }, () => h.get(id, 'u1'));
    await tick();
    expect(consistent(h)).toMatchObject({ waiters: LOG_LIMITS.maxWaitersPerRequest, waitingActors: 1 });
    expect(timeouts() - before).toBe(LOG_LIMITS.maxWaitersPerRequest);
    expect(h.agentResult(serverId, id, ok(Date.now()))).toBe('recorded');
    const out = await Promise.all(all);
    expect(out.filter((v) => v === 'limit_request')).toHaveLength(1000 - LOG_LIMITS.maxWaitersPerRequest);
    expect(out.filter((v) => typeof v === 'object' && v?.status === 'done')).toHaveLength(LOG_LIMITS.maxWaitersPerRequest);
    expect(consistent(h)).toMatchObject({ waiters: 0, waitingActors: 0 });
    expect(timeouts()).toBeLessThanOrEqual(before);
    h.close();
  });

  it('per-actor and global limits; other actors and other requests are unaffected; foreign/unknown ids reveal nothing', async () => {
    const h = new LogHub();
    const serverId = randomUUID();
    const a = open(h, serverId, 'u1');
    const b = open(h, serverId, 'u1');
    const waits = [h.get(a, 'u1', { waitMs: 5_000 }), h.get(a, 'u1', { waitMs: 5_000 })];
    expect(await h.get(a, 'u1', { waitMs: 5_000 })).toBe('limit_request');
    waits.push(h.get(b, 'u1', { waitMs: 5_000 }));
    expect(await h.get(b, 'u1', { waitMs: 5_000 })).toBe('limit_actor');
    // Foreign or unknown → null even when the request's waiter slots are full (no information leak, no slot taken).
    expect(await h.get(a, 'u2', { waitMs: 5_000 })).toBeNull();
    expect(await h.get(randomUUID(), 'u1', { waitMs: 5_000 })).toBeNull();
    expect(consistent(h)).toMatchObject({ waiters: LOG_LIMITS.maxWaitersPerActor, waitingActors: 1 });
    // Global: fill up with other actors, then the next actor gets limit_global.
    let actor = 0;
    while (h.stats().waiters < LOG_LIMITS.maxWaiters) {
      const u = `g${String(actor++)}`;
      const id = open(h, serverId, u);
      for (let i = 0; i < LOG_LIMITS.maxWaitersPerRequest && h.stats().waiters < LOG_LIMITS.maxWaiters; i++) waits.push(h.get(id, u, { waitMs: 5_000 }));
    }
    const late = open(h, serverId, 'late');
    expect(await h.get(late, 'late', { waitMs: 5_000 })).toBe('limit_global');
    expect(consistent(h).waiters).toBe(LOG_LIMITS.maxWaiters);
    // Shutdown releases every waiter and counter; nothing left behind.
    h.close();
    await Promise.all(waits);
    expect(consistent(h)).toMatchObject({ waiters: 0, waitingActors: 0 });
  });

  it('disconnect frees the slot at once without cancelling the request; timeout, deadline and repeated cleanup leave counters intact', async () => {
    let now = Date.now();
    const h = new LogHub(() => now);
    const serverId = randomUUID();
    const id = open(h, serverId, 'u1');
    const before = timeouts();
    let gone: (() => void) | undefined;
    const aborted = h.get(id, 'u1', { onClose: (cb) => { gone = cb; } });
    const other = h.get(id, 'u1');
    await tick();
    expect(h.stats().waiters).toBe(2);
    gone?.();
    gone?.(); // a second close event is harmless
    expect(await aborted).toMatchObject({ status: 'pending' });
    expect(consistent(h)).toMatchObject({ waiters: 1 });
    // The other reader still waits; the shared request is still pending, and a new GET takes the freed slot.
    const next = h.get(id, 'u1', { waitMs: 20 });
    expect(await next).toMatchObject({ status: 'pending' }); // wait timeout frees it
    expect(consistent(h)).toMatchObject({ waiters: 1 });
    // Deadline: cleanup wakes and frees the remaining waiter; repeated cleanup/close do not corrupt counters.
    now += LOG_LIMITS.requestDeadlineMs + 1;
    h.cleanup();
    expect(await other).toMatchObject({ status: 'expired' });
    h.cleanup();
    h.close();
    expect(consistent(h)).toMatchObject({ waiters: 0, waitingActors: 0 });
    expect(timeouts()).toBeLessThanOrEqual(before);
    // Limits still exact after all exits: exactly maxWaitersPerRequest admitted again.
    const fresh = new LogHub();
    const id2 = open(fresh, serverId, 'u1');
    const again = [fresh.get(id2, 'u1', { waitMs: 50 }), fresh.get(id2, 'u1', { waitMs: 50 }), fresh.get(id2, 'u1', { waitMs: 50 })];
    expect((await Promise.all(again)).filter((v) => v === 'limit_request')).toHaveLength(1);
    fresh.close();
  });

  it('many completed cycles accumulate no waiters or timers', async () => {
    const h = new LogHub();
    const serverId = randomUUID();
    const before = timeouts();
    for (let i = 0; i < 50; i++) {
      const id = open(h, serverId, `c${String(i)}`);
      const w = h.get(id, `c${String(i)}`);
      await tick();
      h.agentResult(serverId, id, ok(Date.now()));
      expect(await w).toMatchObject({ status: 'done' });
    }
    expect(consistent(h)).toMatchObject({ waiters: 0, waitingActors: 0 });
    h.close();
    expect(timeouts()).toBeLessThanOrEqual(before);
  });

  it('HTTP: excess waiting GETs → 429/Retry-After; viewer 403, anonymous 401, other user 404', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const op = await session('operator');
    const viewer = await session('viewer');
    const { held } = await connected(n);
    const requestId = (await create(op, n.serverId)).json<{ requestId: string }>().requestId;
    await held;
    const waits = [getReq(op, requestId), getReq(op, requestId)];
    await new Promise((r) => setTimeout(r, 30));
    const refused = await getReq(op, requestId);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect((await getReq(admin, requestId)).statusCode).toBe(404);
    expect((await getReq(viewer, requestId)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/log-requests/${requestId}` })).statusCode).toBe(401);
    expect((await agentResult(n.token, okResult(requestId))).statusCode).toBe(200);
    for (const w of await Promise.all(waits)) expect(w.json()).toMatchObject({ status: 'done', result: { outcome: 'ok' } });
    expect(hub.stats().waiters).toBe(0);
    noSecrets();
  });

  it('HTTP: a real client abort frees the waiter immediately (not after the 8 s wait); the next GET works', async () => {
    const admin = await session('admin');
    const n = await node(admin);
    const op = await session('operator');
    const { held } = await connected(n);
    const requestId = (await create(op, n.serverId)).json<{ requestId: string }>().requestId;
    await held;
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const pending = fetch(`${address}/api/log-requests/${requestId}`, { headers: { cookie: op.cookie }, signal: controller.signal }).catch((e: unknown) => (e instanceof Error ? e.name : 'error'));
    for (let i = 0; i < 100 && hub.stats().waiters === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hub.stats().waiters).toBe(1); // held: the request body being consumed did not end the wait
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.stats().waiters).toBe(1);
    controller.abort();
    expect(await pending).toBe('AbortError');
    for (let i = 0; i < 100 && hub.stats().waiters > 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hub.stats()).toMatchObject({ waiters: 0, waitingActors: 0 });
    expect((await agentResult(n.token, okResult(requestId))).statusCode).toBe(200);
    const res = await fetch(`${address}/api/log-requests/${requestId}`, { headers: { cookie: op.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'done' });
    expect(logs.text()).not.toMatch(/"level":(50|60)/);
    noSecrets();
  });
});

// Task 013: graceful shutdown must not wait for a held Agent long-poll (up to 25 s) or a result waiter (up to 8 s).
// The hub is released in preClose — before Fastify waits for in-flight requests — so close() finishes promptly.
describe('graceful shutdown with long-polls in flight (real HTTP)', () => {
  it('API close with a held Agent long-poll and a waiting result GET completes cleanly within the shutdown timeout', async () => {
    const { createLifecycle } = await import('../src/lifecycle.js');
    const admin = await session('admin');
    const n = await node(admin);
    const op = await session('operator');
    const { held } = await connected(n);
    const requestId = (await create(op, n.serverId)).json<{ requestId: string }>().requestId;
    await held;
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const poll = fetch(`${address}/api/agent/logs/poll`, {
      method: 'POST', headers: { authorization: `Bearer ${n.token}`, 'content-type': 'application/json' }, body: JSON.stringify(report()),
    }).then((r) => r.status, (e: unknown) => (e instanceof Error ? e.name : 'error'));
    const wait = fetch(`${address}/api/log-requests/${requestId}`, { headers: { cookie: op.cookie } })
      .then((r) => r.status, (e: unknown) => (e instanceof Error ? e.name : 'error'));
    for (let i = 0; i < 100 && (hub.stats().waiters === 0); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100)); // both requests are now held by the API
    expect(hub.stats().waiters).toBe(1);
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port: 0, shutdownTimeoutMs: 3_000 });
    const started = Date.now();
    expect(await lifecycle.shutdown('SIGTERM')).toBe(true); // clean, not "Shutdown failed or timed out"
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await poll).toBe(200);
    expect(await wait).toBe(200);
    expect(logs.text()).not.toContain('Shutdown failed');
  }, 20_000);
});
