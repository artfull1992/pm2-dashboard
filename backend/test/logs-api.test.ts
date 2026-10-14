import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { LOG_LIMITS, LogHub } from '../src/servers/logs.js';
import { captureLogs, fakeDatabase } from './helpers.js';
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
let clock: number;
let logs: ReturnType<typeof captureLogs>;

function build() {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createServerStore: () => servers, logHub: hub,
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
}

beforeEach(() => {
  auth = new FakeAuthStore(); servers = new FakeServerStore(); clock = Date.now(); hub = new LogHub(() => clock);
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
      const r = h.create({ serverId, targetKey: 'api', actorUserId: 'u1', lines: 10 });
      if (typeof r === 'string') { results.push(r); break; }
      h.agentResult(serverId, r.request.requestId, { outcome: 'ok', reason: null, readAt: new Date(now).toISOString(), stdout: null, stderr: null });
      now += 100;
    }
    expect(results).toEqual(['rate_limited']);
    now += 61_000;
    void poll();
    expect(typeof h.create({ serverId, targetKey: 'api', actorUserId: 'u1', lines: 10 })).toBe('object');
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
