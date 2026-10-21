import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { type AgentLogReport, LogHub } from '../src/servers/logs.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAccessChecker } from './support/fake-access.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeServerStore } from './support/fake-server-store.js';

// Review Codex e621e31 (ADR-028), real Fastify inject:
//  P1a — an OPEN log long-poll must not hand out log text after the reader lost the session, the active flag, the role
//        permission (logs:read) or the resource grant while it was waiting;
//  P1b — a queued log request is bound to the service (and, with protocol v2, the definition identity) it was
//        authorised for: a targetKey that now points to another service never reads/returns that service's log.
// Denied answers never contain the synthetic log marker.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-LogAccess-Passw0rd';
const MARKER = 'SYNTHETIC_LOG_MARKER_REVALIDATE_51c';
const ID_A = 'a'.repeat(16);
const ID_B = 'b'.repeat(16);
let app: FastifyInstance;
let auth: FakeAuthStore;
let servers: FakeServerStore;
let hub: LogHub;
let access: FakeAccessChecker;
let logs: ReturnType<typeof captureLogs>;

beforeEach(() => {
  auth = new FakeAuthStore(); servers = new FakeServerStore(); hub = new LogHub();
  access = new FakeAccessChecker(async (id) => (await servers.get(id, null)) !== null); access.actors = (id) => auth.users.get(id);
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
});
afterEach(async () => { await app.close(); expect(logs.text()).not.toContain(MARKER); });

async function session(role: Role, email = `${role}@example.test`) {
  const user = await auth.addUser({ email, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { userId: user.id, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof session>>;

async function node(admin: Session) {
  const headers = { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf };
  const serverId = (await app.inject({ method: 'POST', url: '/api/servers', headers, payload: { name: 'node-logs' } })).json<{ id: string }>().id;
  const token = (await app.inject({ method: 'POST', url: `/api/servers/${serverId}/agent-credentials`, headers })).json<{ token: string }>().token;
  return { serverId, token };
}
type Target = { targetKey: string; name: string; pmId: number; matchStatus: 'ok'; identity?: string };
const report = (targets: Target[], version: 1 | 2 = 2) => (version === 2
  ? { version: 2, mode: 'auto', broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: targets.map((t) => ({ identity: null, ...t })), total: targets.length }
  : { version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: targets.map(({ identity: _i, ...t }) => t) });
const agentPoll = (token: string, body: object) => app.inject({ method: 'POST', url: '/api/agent/logs/poll', headers: { authorization: `Bearer ${token}` }, payload: body });
const agentResult = (token: string, requestId: string) => app.inject({
  method: 'POST', url: '/api/agent/logs/result', headers: { authorization: `Bearer ${token}` },
  payload: { version: 1, requestId, outcome: 'ok', reason: null, readAt: new Date().toISOString(), stdout: { state: 'ok', text: `line ${MARKER}`, lines: 1, truncated: false, sizeBytes: 10, modifiedAt: new Date().toISOString() }, stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null } },
});
const create = (s: Session, serverId: string, targetKey: string) => app.inject({
  method: 'POST', url: `/api/servers/${serverId}/log-requests`, headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf }, payload: { targetKey },
});
const read = (s: Session, id: string) => app.inject({ method: 'GET', url: `/api/log-requests/${id}`, headers: { cookie: s.cookie } });
const tick = () => new Promise((r) => setTimeout(r, 30));
/** The stored user (FakeAuthStore = the users table): changed in place like an UPDATE that keeps sessions. */
function user(id: string) {
  const u = auth.users.get(id);
  if (!u) throw new Error('unknown user');
  return u;
}

/** The Agent's last report, without a waiting long-poll (so a new request stays pending until the next poll). */
async function register(serverId: string, body: object) {
  let close: () => void = () => undefined;
  const polled = hub.agentPoll(serverId, body as AgentLogReport, (cb) => { close = cb; });
  close();
  await polled;
}

/** Agent connected with `targets`; the user creates a request, the Agent takes it; returns its id. */
async function delivered(n: { serverId: string; token: string }, s: Session, targets: Target[], key: string, version: 1 | 2 = 2) {
  await register(n.serverId, report(targets, version));
  const created = await create(s, n.serverId, key);
  expect(created.statusCode, created.body).toBe(202);
  const requestId = created.json<{ requestId: string }>().requestId;
  const took = await agentPoll(n.token, report(targets, version));
  expect(took.json<{ requests: { requestId: string }[] }>().requests.map((r) => r.requestId)).toEqual([requestId]);
  return requestId;
}

describe('P1a — an open long-poll re-checks session, active flag, role and grant before handing out text', () => {
  const T: Target[] = [{ targetKey: 'api', name: 'api', pmId: 1, matchStatus: 'ok', identity: ID_A }];
  const scenarios: [string, Role, (s: Session, serverId: string) => void | Promise<void>, number][] = [
    ['operator → viewer', 'operator', (s) => { user(s.userId).role = 'viewer'; }, 403],
    ['admin → viewer', 'admin', (s) => { user(s.userId).role = 'viewer'; }, 403],
    ['admin → operator without a grant', 'admin', (s) => { user(s.userId).role = 'operator'; access.revoke(s.userId); }, 404],
    ['deactivated', 'operator', (s) => { user(s.userId).isActive = false; }, 401],
    ['session revoked (logout)', 'operator', (s) => { for (const x of auth.sessions) if (x.userId === s.userId) x.revokedAt = new Date(); }, 401],
    ['server grant revoked', 'operator', (s, id) => { access.revoke(s.userId, id); }, 404],
    ['service grant narrowed to another service', 'operator', (s, id) => { access.grant(s.userId, id, 'selected', ['other']); }, 404],
  ];
  for (const [name, role, change, status] of scenarios) {
    it(`${name} while waiting → ${String(status)}, no log text`, async () => {
      const admin = await session('admin', 'boss@example.test');
      const n = await node(admin);
      const s = await session(role, `${role}-reader@example.test`);
      access.grant(s.userId, n.serverId, 'all');
      const requestId = await delivered(n, s, T, 'api');
      const held = read(s, requestId);
      await tick();
      await change(s, n.serverId);
      expect((await agentResult(n.token, requestId)).statusCode).toBe(200);
      const res: LightMyRequestResponse = await held;
      expect(res.statusCode).toBe(status);
      expect(res.body).not.toContain(MARKER);
      // A finished, cached result is refused the same way.
      const again = await read(s, requestId);
      expect(again.statusCode).toBe(status);
      expect(again.body).not.toContain(MARKER);
    });
  }

  it('still allowed (role, session and grant unchanged) → 200 with the result', async () => {
    const admin = await session('admin', 'boss@example.test');
    const n = await node(admin);
    const s = await session('operator', 'op@example.test');
    access.grant(s.userId, n.serverId, 'selected', ['api']);
    const requestId = await delivered(n, s, T, 'api');
    const held = read(s, requestId);
    await tick();
    await agentResult(n.token, requestId);
    const res = await held;
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(MARKER);
  });

  it('a ready result read after the grant was revoked → 404 without text', async () => {
    const admin = await session('admin', 'boss@example.test');
    const n = await node(admin);
    const s = await session('operator', 'op@example.test');
    access.grant(s.userId, n.serverId, 'all');
    const requestId = await delivered(n, s, T, 'api');
    await agentResult(n.token, requestId);
    access.revoke(s.userId);
    const res = await read(s, requestId);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(MARKER);
  });
});

describe('P1b — a queued request stays bound to the authorised service and definition', () => {
  async function pending(version: 1 | 2, role: Role = 'operator') {
    const admin = await session('admin', 'boss@example.test');
    const n = await node(admin);
    const s = role === 'admin' ? admin : await session(role, 'op@example.test');
    if (role !== 'admin') access.grant(s.userId, n.serverId, 'selected', ['allowed-app']);
    const before: Target[] = [{ targetKey: 'shared-key', name: 'allowed-app', pmId: 1, matchStatus: 'ok', identity: ID_A }];
    await register(n.serverId, report(before, version));
    const created = await create(s, n.serverId, 'shared-key');
    return { n, s, created };
  }

  it('targetKey re-assigned to another service before delivery → the request is not delivered and ends rejected (v2)', async () => {
    const { n, s, created } = await pending(2);
    expect(created.statusCode).toBe(202);
    const requestId = created.json<{ requestId: string }>().requestId;
    // The Agent's next poll reports the key for another service: nothing is handed out (the poll is just held).
    await register(n.serverId, report([{ targetKey: 'shared-key', name: 'forbidden-app', pmId: 2, matchStatus: 'ok', identity: ID_B }]));
    expect((await agentResult(n.token, requestId)).statusCode).toBe(409); // a forged/late result is refused
    const res = await read(s, requestId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'done', result: { outcome: 'rejected', reason: 'target_changed', stdout: null } });
    expect(res.body).not.toContain(MARKER);
  });

  it('same name, different definition identity before delivery → rejected identity_changed (v2)', async () => {
    const { n, s, created } = await pending(2);
    const requestId = created.json<{ requestId: string }>().requestId;
    await register(n.serverId, report([{ targetKey: 'shared-key', name: 'allowed-app', pmId: 1, matchStatus: 'ok', identity: ID_B }]));
    expect((await read(s, requestId)).json()).toMatchObject({ status: 'done', result: { outcome: 'rejected', reason: 'identity_changed' } });
  });

  it('v2 delivery carries the expected name and identity, so the broker can refuse a changed target at read time', async () => {
    const { n, created } = await pending(2);
    const requestId = created.json<{ requestId: string }>().requestId;
    const took = await agentPoll(n.token, report([{ targetKey: 'shared-key', name: 'allowed-app', pmId: 1, matchStatus: 'ok', identity: ID_A }]));
    expect(took.json()).toMatchObject({ accessModel: 'scoped', requests: [{ requestId, targetKey: 'shared-key', name: 'allowed-app', identity: ID_A }] });
  });

  it('grant revoked or role lost before delivery → not delivered, rejected not_authorized', async () => {
    for (const lose of ['grant', 'role', 'inactive'] as const) {
      await app.close();
      auth = new FakeAuthStore(); servers = new FakeServerStore(); hub = new LogHub();
      access = new FakeAccessChecker(async (id) => (await servers.get(id, null)) !== null); access.actors = (id) => auth.users.get(id);
      app = buildApp({
        logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
        auth: { config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 }, createStore: () => auth, createServerStore: () => servers, logHub: hub, accessChecker: access },
      });
      const { n, s, created } = await pending(2);
      const requestId = created.json<{ requestId: string }>().requestId;
      if (lose === 'grant') access.revoke(s.userId);
      if (lose === 'role') user(s.userId).role = 'viewer';
      if (lose === 'inactive') user(s.userId).isActive = false;
      const took = await agentPoll(n.token, report([{ targetKey: 'shared-key', name: 'allowed-app', pmId: 1, matchStatus: 'ok', identity: ID_A }]));
      expect(took.json<{ requests: unknown[] }>().requests, lose).toEqual([]);
      expect(hub.peek(requestId, s.userId), lose).not.toBeNull();
    }
  });

  it('legacy v1 Agent: scoped (non-admin) users get no log viewing (fail closed); admin keeps it with a name check at delivery', async () => {
    const { n, s, created } = await pending(1);
    expect(created.statusCode).toBe(409);
    expect(created.body).toMatch(/not supported/);
    const targets = await app.inject({ method: 'GET', url: `/api/servers/${n.serverId}/log-targets`, headers: { cookie: s.cookie } });
    expect(targets.json()).toMatchObject({ state: 'unsupported', targets: [] });
  });

  it('legacy v1 Agent, admin: re-assigned targetKey before delivery → rejected target_changed, never the other service', async () => {
    const { n, s, created } = await pending(1, 'admin');
    expect(created.statusCode).toBe(202);
    const requestId = created.json<{ requestId: string }>().requestId;
    await register(n.serverId, report([{ targetKey: 'shared-key', name: 'forbidden-app', pmId: 2, matchStatus: 'ok' }], 1));
    expect((await read(s, requestId)).json()).toMatchObject({ status: 'done', result: { outcome: 'rejected', reason: 'target_changed' } });
  });

  it('unchanged target and valid access → delivered and served (v2)', async () => {
    const { n, s, created } = await pending(2);
    const requestId = created.json<{ requestId: string }>().requestId;
    const took = await agentPoll(n.token, report([{ targetKey: 'shared-key', name: 'allowed-app', pmId: 1, matchStatus: 'ok', identity: ID_A }]));
    expect(took.json<{ requests: unknown[] }>().requests).toHaveLength(1);
    await agentResult(n.token, requestId);
    expect((await read(s, requestId)).body).toContain(MARKER);
  });
});
