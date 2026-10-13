import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import type { CommandView, PollReport, ResultReport } from '../src/servers/control.js';
import type { ControlStore, CreateResult } from '../src/servers/control-store.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeServerStore } from './support/fake-server-store.js';

// PM2 control API boundary (Task 009, ADR-017): permissions, session/Origin/CSRF, feature flag, strict schemas,
// machine/browser separation. Command lifecycle SQL is covered by backend/test/db/control.test.ts.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Control-Passw0rd';
const SECRET = 'SYNTHETIC_CONTROL_API_SECRET_19';
const SERVER = '11111111-1111-4111-8111-111111111111';
let app: FastifyInstance;
let auth: FakeAuthStore;
let servers: FakeServerStore;
let logs: ReturnType<typeof captureLogs>;

const command = (over: Partial<CommandView> = {}): CommandView => ({
  id: randomUUID(), serverId: SERVER, targetKey: 'api', action: 'restart', status: 'queued', reason: null, requestedBy: randomUUID(),
  requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null,
  attempts: 0, before: null, after: null, ...over,
});

class StubControlStore implements ControlStore {
  createResult: CreateResult = { command: command(), created: true };
  creates: unknown[] = [];
  polls: { report: PollReport; controlEnabled: boolean }[] = [];
  results: ResultReport[] = [];
  pollResult: Awaited<ReturnType<ControlStore['poll']>> = { commands: [] };
  resultStatus: Awaited<ReturnType<ControlStore['recordResult']>> = 'recorded';
  failing = false;
  private check() { if (this.failing) throw Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }); }
  controlView(serverId: string) {
    this.check();
    return Promise.resolve(serverId === SERVER ? { serverId, serverStatus: 'online' as const, broker: null, targets: [] } : null);
  }
  createCommand(input: unknown) { this.check(); this.creates.push(input); return Promise.resolve(this.createResult); }
  listCommands(serverId: string) { this.check(); return Promise.resolve(serverId === SERVER ? [command()] : null); }
  getCommand(id: string) { this.check(); return Promise.resolve(id === SERVER ? command({ id }) : null); }
  poll(input: { report: PollReport; controlEnabled: boolean }) { this.check(); this.polls.push(input); return Promise.resolve(this.pollResult); }
  recordResult(input: { result: ResultReport }) { this.check(); this.results.push(input.result); return Promise.resolve(this.resultStatus); }
}
let control: StubControlStore;

function build(enabled = true) {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createServerStore: () => servers, createControlStore: () => control, controlEnabled: enabled,
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
  return app;
}

beforeEach(() => { auth = new FakeAuthStore(); servers = new FakeServerStore(); control = new StubControlStore(); });
afterEach(async () => { await app.close(); });

async function session(role: Role) {
  await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof session>>;
const body = (over: Record<string, unknown> = {}) => ({ targetKey: 'api', action: 'restart', idempotencyKey: randomUUID(), ...over });
const post = (s: Session | null, payload: unknown, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: `/api/servers/${SERVER}/control-commands`,
  headers: { ...(s ? { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf } : {}), ...headers }, payload: payload as object,
});

async function agentToken() {
  const s = await session('admin');
  const headers = { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf };
  const created = await app.inject({ method: 'POST', url: '/api/servers', headers, payload: { name: 'node-1' } });
  const serverId = created.json<{ id: string }>().id;
  const issued = await app.inject({ method: 'POST', url: `/api/servers/${serverId}/agent-credentials`, headers });
  return issued.json<{ token: string }>().token;
}
const report = (over: Partial<PollReport> = {}) => ({ version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: [{ targetKey: 'api', name: 'api', pmId: 1, actions: ['restart'], matchStatus: 'ok' }], ...over });
const machine = (token: string | null, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as object });

describe('browser: command creation', () => {
  it('viewer is denied (403, audited); operator and admin may request; reads are monitoring:read', async () => {
    build();
    const viewer = await session('viewer');
    expect((await post(viewer, body())).statusCode).toBe(403);
    expect(auth.audit.some((a) => a.event === 'authz.denied')).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${SERVER}/control`, headers: { cookie: viewer.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${SERVER}/control-commands`, headers: { cookie: viewer.cookie } })).statusCode).toBe(200);
    for (const role of ['operator', 'admin'] as const) {
      const s = await session(role);
      expect((await post(s, body())).statusCode).toBe(201);
    }
    expect(control.creates).toHaveLength(2);
  });

  it('session, exact Origin and CSRF are required; a bearer token is not a browser credential', async () => {
    build();
    const s = await session('operator');
    expect((await post(null, body())).statusCode).toBe(403); // Origin is checked first for state-changing requests
    expect((await post(null, body(), { origin: ORIGIN })).statusCode).toBe(401); // no session
    expect((await post(null, body(), { cookie: s.cookie, 'x-csrf-token': s.csrf })).statusCode).toBe(403); // no Origin
    expect((await post(null, body(), { cookie: s.cookie, origin: 'https://evil.example', 'x-csrf-token': s.csrf })).statusCode).toBe(403);
    expect((await post(null, body(), { cookie: s.cookie, origin: ORIGIN })).statusCode).toBe(403); // no CSRF
    expect((await post(null, body(), { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': 'x'.repeat(43) })).statusCode).toBe(403);
    expect((await post(s, body(), { authorization: `Bearer ncag_${'a'.repeat(43)}` })).statusCode).toBe(401);
    expect(control.creates).toHaveLength(0);
  });

  it('control disabled (PM2_CONTROL_ENABLED=false, the default) → 409 before touching the store', async () => {
    build(false);
    const s = await session('admin');
    expect((await post(s, body())).statusCode).toBe(409);
    expect(control.creates).toHaveLength(0);
    const view = await app.inject({ method: 'GET', url: `/api/servers/${SERVER}/control`, headers: { cookie: s.cookie } });
    expect(view.json()).toMatchObject({ enabled: false });
  });

  it.each([
    ['pm_id instead of target', { pmId: 1 }],
    ['script path', { script: '/srv/app.js' }],
    ['env', { env: { X: SECRET } }],
    ['shell text', { command: `pm2 restart all; echo ${SECRET}` }],
    ['delete action', { action: 'delete' }],
    ['reload action', { action: 'reload' }],
    ['all target', { targetKey: 'all*' }],
    ['wildcard', { targetKey: '*' }],
    ['no idempotency key', { idempotencyKey: undefined }],
    ['bad idempotency key', { idempotencyKey: 'abc' }],
  ])('%s → 400 without creating anything', async (_name, over) => {
    build();
    const s = await session('operator');
    const res = await post(s, body(over));
    expect(res.statusCode).toBe(400);
    expect(control.creates).toHaveLength(0);
    expect(res.body).not.toContain(SECRET);
    expect(logs.text()).not.toContain(SECRET);
  });

  it('store outcomes map to 200 (replay) / 404 / 409; failures → 503 without secrets', async () => {
    build();
    const s = await session('operator');
    control.createResult = { command: command(), created: false };
    expect((await post(s, body())).statusCode).toBe(200);
    control.createResult = 'not_found';
    expect((await post(s, body())).statusCode).toBe(404);
    for (const r of ['server_offline', 'target_unavailable', 'action_not_allowed', 'command_in_progress', 'idempotency_conflict'] as const) {
      control.createResult = r;
      expect((await post(s, body())).statusCode).toBe(409);
    }
    control.failing = true;
    const failed = await post(s, body());
    expect(failed.statusCode).toBe(503);
    expect(logs.text()).not.toContain(SECRET);
  });

  it('command lookups: 404 for unknown, 400 for malformed ids', async () => {
    build();
    const s = await session('viewer');
    expect((await app.inject({ method: 'GET', url: `/api/control-commands/${SERVER}`, headers: { cookie: s.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/control-commands/${randomUUID()}`, headers: { cookie: s.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/control-commands/nope', headers: { cookie: s.cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/servers/${randomUUID()}/control`, headers: { cookie: s.cookie } })).statusCode).toBe(404);
  });
});

describe('machine: poll and result', () => {
  it('poll requires the Agent credential; browser context and sessions are refused', async () => {
    build();
    const token = await agentToken();
    const s = await session('operator');
    expect((await machine(null, '/api/agent/control/poll', report())).statusCode).toBe(401);
    expect((await machine(token, '/api/agent/control/poll', report(), { origin: ORIGIN })).statusCode).toBe(403);
    expect((await machine(token, '/api/agent/control/poll', report(), { cookie: s.cookie })).statusCode).toBe(401);
    const ok = await machine(token, '/api/agent/control/poll', report());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ controlEnabled: true, commands: [], intervalSeconds: 10 });
    expect(control.polls[0]?.controlEnabled).toBe(true);
  });

  it('poll payload is strict: no extra fields, unique targets, consistent pmId/matchStatus, no targets without broker', async () => {
    build();
    const token = await agentToken();
    const bad: unknown[] = [
      { ...report(), serverId: SERVER },
      report({ targets: [{ targetKey: 'api', name: 'api', pmId: 1, actions: ['restart'], matchStatus: 'ok', path: '/srv' } as never] }),
      report({ targets: [report().targets[0], report().targets[0]] as never }),
      report({ targets: [{ targetKey: 'api', name: 'api', pmId: null, actions: ['restart'], matchStatus: 'ok' }] }),
      report({ broker: 'unavailable' }),
      report({ targets: [{ targetKey: 'api', name: 'api', pmId: 1, actions: ['delete'], matchStatus: 'ok' } as never] }),
    ];
    for (const b of bad) expect((await machine(token, '/api/agent/control/poll', b)).statusCode).toBe(400);
    expect(control.polls).toHaveLength(0);
  });

  it('control disabled: polls still report state but get the slow interval and never a command', async () => {
    build(false);
    const token = await agentToken();
    const r = await machine(token, '/api/agent/control/poll', report());
    expect(r.json()).toEqual({ controlEnabled: false, commands: [], intervalSeconds: 60 });
    expect(control.polls[0]?.controlEnabled).toBe(false);
  });

  it('result: strict schema; reason required unless succeeded; store outcomes mapped', async () => {
    build();
    const token = await agentToken();
    const result = (over: Record<string, unknown> = {}) => ({ version: 1, commandId: randomUUID(), attempt: 1, outcome: 'succeeded', reason: null, before: { status: 'online' }, after: { status: 'online' }, ...over });
    expect((await machine(token, '/api/agent/control/result', result())).json()).toEqual({ status: 'recorded' });
    for (const b of [result({ outcome: 'failed' }), result({ raw: SECRET }), result({ attempt: 4 }), result({ reason: 'because' }), result({ after: { status: 'online', env: SECRET } })]) {
      expect((await machine(token, '/api/agent/control/result', b)).statusCode).toBe(400);
    }
    control.resultStatus = 'duplicate';
    expect((await machine(token, '/api/agent/control/result', result())).json()).toEqual({ status: 'duplicate' });
    control.resultStatus = 'not_found';
    expect((await machine(token, '/api/agent/control/result', result())).statusCode).toBe(404);
    control.resultStatus = 'conflict';
    expect((await machine(token, '/api/agent/control/result', result())).statusCode).toBe(409);
    control.resultStatus = 'unauthorized';
    expect((await machine(token, '/api/agent/control/result', result())).statusCode).toBe(401);
    expect(logs.text()).not.toContain(SECRET);
    expect(logs.text()).not.toContain(token);
  });

  it('results are accepted even when control is disabled (in-flight commands can finish)', async () => {
    build(false);
    const token = await agentToken();
    const r = await machine(token, '/api/agent/control/result', { version: 1, commandId: randomUUID(), attempt: 1, outcome: 'unknown', reason: 'timeout', before: null, after: null });
    expect(r.statusCode).toBe(200);
  });
});
