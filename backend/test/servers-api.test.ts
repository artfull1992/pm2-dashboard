import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createLimiter } from '../src/auth/password.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { agentTokenDigest, bearerToken, isWellFormedAgentToken, newAgentToken } from '../src/auth/tokens.js';
import { normalizeSnapshot, snapshotProblem } from '../src/servers/snapshot.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeServerStore, legacySnapshot, validSnapshot } from './support/fake-server-store.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Servers-Passw0rd';
let app: FastifyInstance;
let auth: FakeAuthStore;
let servers: FakeServerStore;
let logs: ReturnType<typeof captureLogs>;

function build(extra: { agentTokenMax?: number; agentAddressMax?: number; heartbeatConcurrency?: number } = {}) {
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth,
      createServerStore: () => servers,
      ...(extra.heartbeatConcurrency !== undefined ? { heartbeatLimiter: createLimiter(extra.heartbeatConcurrency, 0) } : {}),
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: extra.agentTokenMax ?? 1000, windowMs: 60_000 }),
        agentAddressLimiter: createRateLimiter({ max: extra.agentAddressMax ?? 1000, windowMs: 60_000 }),
      },
    },
  });
  return app;
}

beforeEach(() => { auth = new FakeAuthStore(); servers = new FakeServerStore(); });
afterEach(async () => { await app.close(); });

async function session(role: Role) {
  await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}

type Session = Awaited<ReturnType<typeof session>>;
const browserPost = (s: Session, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });

const heartbeat = (token: string | null, payload: unknown = validSnapshot(), headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as object });

async function provisioned(admin: Session, name = 'node-1') {
  const created = await browserPost(admin, '/api/servers', { name });
  const serverId = created.json<{ id: string }>().id;
  const issued = await browserPost(admin, `/api/servers/${serverId}/agent-credentials`);
  return { serverId, token: issued.json<{ token: string }>().token, issued };
}

function expectNoToken(token: string, ...responses: LightMyRequestResponse[]) {
  for (const r of responses) expect(r.body).not.toContain(token);
  expect(logs.text()).not.toContain(token);
  expect(JSON.stringify(servers.audit)).not.toContain(token);
  expect(JSON.stringify(auth.audit)).not.toContain(token);
}

describe('browser API permissions', () => {
  it.each(['viewer', 'operator', 'admin'] as const)('%s can read the registry; only admin can manage', async (role) => {
    build();
    const admin = role === 'admin' ? await session('admin') : await (async () => { await auth.addUser({ email: 'admin@example.test', password: PASSWORD, role: 'admin' }); return null; })();
    const s = admin ?? await session(role);
    servers.servers.push({ id: '11111111-1111-4111-8111-111111111111', name: 'seed', isActive: true, createdAt: new Date() });
    expect((await app.inject({ method: 'GET', url: '/api/servers', headers: { cookie: s.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/servers/11111111-1111-4111-8111-111111111111', headers: { cookie: s.cookie } })).statusCode).toBe(200);
    const manage = [
      await browserPost(s, '/api/servers', { name: `new-${role}` }),
      await browserPost(s, '/api/servers/11111111-1111-4111-8111-111111111111/agent-credentials'),
      await browserPost(s, '/api/servers/11111111-1111-4111-8111-111111111111/agent-credentials/revoke'),
    ].map((r) => r.statusCode);
    expect(manage).toEqual(role === 'admin' ? [201, 201, 200] : [403, 403, 403]);
  });

  it('anonymous → 401; mutations need Origin and CSRF', async () => {
    build();
    expect((await app.inject({ method: 'GET', url: '/api/servers' })).statusCode).toBe(401);
    const admin = await session('admin');
    expect((await browserPost(admin, '/api/servers', { name: 'x' }, { 'x-csrf-token': 'x'.repeat(43) })).statusCode).toBe(403);
    expect((await browserPost(admin, '/api/servers', { name: 'x' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(servers.servers).toHaveLength(0);
  });
});

describe('server registry', () => {
  it('create: trims, rejects duplicates/control chars/blank, audits atomically', async () => {
    build();
    const admin = await session('admin');
    const res = await browserPost(admin, '/api/servers', { name: '  web-01  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'web-01', status: 'never_connected', lastSeenAt: null, hasActiveCredential: false, isActive: true });
    expect((await browserPost(admin, '/api/servers', { name: 'web-01' })).statusCode).toBe(409);
    expect((await browserPost(admin, '/api/servers', { name: 'bad\u0007name' })).statusCode).toBe(400);
    expect((await browserPost(admin, '/api/servers', { name: '   ' })).statusCode).toBe(400);
    expect(servers.audit.map((a) => a.event)).toEqual(['server.created']);
    servers.failAudit = true;
    expect((await browserPost(admin, '/api/servers', { name: 'web-02' })).statusCode).toBe(503);
    expect(servers.servers.map((s) => s.name)).toEqual(['web-01']);
  });

  it('list is paginated with a keyset cursor and never contains credentials', async () => {
    build();
    const admin = await session('admin');
    const { token } = await provisioned(admin, 'a');
    await browserPost(admin, '/api/servers', { name: 'b' });
    await browserPost(admin, '/api/servers', { name: 'c' });
    const first = await app.inject({ method: 'GET', url: '/api/servers?limit=2', headers: { cookie: admin.cookie } });
    const page = first.json<{ items: { name: string }[]; nextAfterId: string; onlineWindowSeconds: number }>();
    expect(page.items.map((i) => i.name)).toEqual(['a', 'b']);
    expect(page.onlineWindowSeconds).toBe(90);
    const second = await app.inject({ method: 'GET', url: `/api/servers?limit=2&afterId=${page.nextAfterId}`, headers: { cookie: admin.cookie } });
    expect(second.json<{ items: { name: string }[]; nextAfterId: null }>()).toMatchObject({ items: [{ name: 'c' }], nextAfterId: null });
    expect((await app.inject({ method: 'GET', url: '/api/servers?limit=101', headers: { cookie: admin.cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/servers?afterId=not-a-uuid', headers: { cookie: admin.cookie } })).statusCode).toBe(400);
    expectNoToken(token, first, second);
  });

  it('detail: 404 for unknown, 400 for malformed id', async () => {
    build();
    const admin = await session('admin');
    expect((await app.inject({ method: 'GET', url: '/api/servers/22222222-2222-4222-8222-222222222222', headers: { cookie: admin.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/servers/abc', headers: { cookie: admin.cookie } })).statusCode).toBe(400);
  });
});

describe('agent credentials', () => {
  it('issue: one-time token, no-store, digest-only storage, audited without the token', async () => {
    build();
    const admin = await session('admin');
    const { serverId, token, issued } = await provisioned(admin);
    expect(issued.statusCode).toBe(201);
    expect(issued.headers['cache-control']).toBe('no-store');
    expect(isWellFormedAgentToken(token)).toBe(true);
    expect(servers.credentials).toEqual([{ serverId, tokenHash: agentTokenDigest(token).toString('hex'), revokedAt: null }]);
    expect(servers.audit.at(-1)).toMatchObject({ event: 'agent.credential_issued', details: { serverId, rotated: false } });
    const detail = await app.inject({ method: 'GET', url: `/api/servers/${serverId}`, headers: { cookie: admin.cookie } });
    expect(detail.json()).toMatchObject({ hasActiveCredential: true });
    expectNoToken(token, detail);
  });

  it('rotation revokes the previous token atomically; revoke stops heartbeats and keeps the server', async () => {
    build();
    const admin = await session('admin');
    const { serverId, token: first } = await provisioned(admin);
    const rotated = await browserPost(admin, `/api/servers/${serverId}/agent-credentials`);
    const second = rotated.json<{ token: string; rotated: boolean }>();
    expect(second.rotated).toBe(true);
    expect((await heartbeat(first)).statusCode).toBe(401);
    expect((await heartbeat(second.token)).statusCode).toBe(200);
    const revoke = await browserPost(admin, `/api/servers/${serverId}/agent-credentials/revoke`);
    expect(revoke.json()).toEqual({ serverId, revoked: true });
    expect((await heartbeat(second.token)).statusCode).toBe(401);
    expect((await browserPost(admin, `/api/servers/${serverId}/agent-credentials/revoke`)).json()).toEqual({ serverId, revoked: false });
    expect(servers.servers).toHaveLength(1);
    expect(servers.audit.map((a) => a.event)).toEqual(['server.created', 'agent.credential_issued', 'agent.credential_issued', 'agent.credential_revoked', 'agent.credential_revoked']);
  });

  it('issue on unknown/inactive server → 404/409; audit failure leaves no credential', async () => {
    build();
    const admin = await session('admin');
    expect((await browserPost(admin, '/api/servers/33333333-3333-4333-8333-333333333333/agent-credentials')).statusCode).toBe(404);
    const created = await browserPost(admin, '/api/servers', { name: 'off' });
    const id = created.json<{ id: string }>().id;
    const server = servers.servers.find((s) => s.id === id);
    if (server) server.isActive = false;
    expect((await browserPost(admin, `/api/servers/${id}/agent-credentials`)).statusCode).toBe(409);
    if (server) server.isActive = true;
    servers.failAudit = true;
    expect((await browserPost(admin, `/api/servers/${id}/agent-credentials`)).statusCode).toBe(503);
    expect(servers.credentials).toHaveLength(0);
  });
});

describe('machine authentication (heartbeat)', () => {
  it('valid token → 200 with server-clock receipt; identity comes from the credential, not the payload', async () => {
    build();
    const admin = await session('admin');
    const a = await provisioned(admin, 'a');
    const b = await provisioned(admin, 'b');
    // A spoofed identity/time field is rejected outright (strict schema, Task 008), not silently stripped.
    const spoofed = await heartbeat(a.token, { ...validSnapshot(), serverId: b.serverId, receivedAt: '1999-01-01T00:00:00Z' });
    expect(spoofed.statusCode).toBe(400);
    expect(servers.heartbeats.size).toBe(0);
    const res = await heartbeat(a.token, validSnapshot());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'accepted', intervalSeconds: 30 });
    // Agent response contract (agent/src/heartbeat.ts parseAcceptedBody): exactly these keys, ISO-8601 UTC with ms,
    // integer interval within the agent's 5..300 bounds.
    const reply = res.json<{ status: string; receivedAt: string; intervalSeconds: number }>();
    expect(Object.keys(reply).sort()).toEqual(['intervalSeconds', 'receivedAt', 'status']);
    expect(reply.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(reply.receivedAt).toISOString()).toBe(reply.receivedAt);
    expect(Number.isInteger(reply.intervalSeconds) && reply.intervalSeconds >= 5 && reply.intervalSeconds <= 300).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
    expect([...servers.heartbeats.keys()]).toEqual([a.serverId]);
    expect(Object.keys(servers.heartbeats.get(a.serverId)?.snapshot ?? {}).sort()).toEqual(['agentVersion', 'arch', 'hostname', 'loadAverage', 'platform']);
    const detail = await app.inject({ method: 'GET', url: `/api/servers/${a.serverId}`, headers: { cookie: admin.cookie } });
    expect(detail.json()).toMatchObject({ status: 'online', snapshot: { hostname: 'node-1.example', loadAverage: [0.5, 0.4, 0.3] } });
  });

  it('compatibility (ADR-023): a 0.4.x heartbeat with legacy host metrics is accepted, but only the current fields are stored and returned', async () => {
    build();
    const admin = await session('admin');
    const a = await provisioned(admin);
    expect((await heartbeat(a.token, legacySnapshot())).statusCode).toBe(200);
    const stored = servers.heartbeats.get(a.serverId)?.snapshot ?? {};
    expect(stored).toEqual({ agentVersion: '0.4.0', hostname: 'node-1.example', platform: 'linux', arch: 'x64', loadAverage: [0.5, 0.4, 0.3] });
    const detail = await app.inject({ method: 'GET', url: `/api/servers/${a.serverId}`, headers: { cookie: admin.cookie } });
    for (const legacy of ['memory', 'freeBytes', 'totalBytes', 'uptimeSeconds', 'cpuCount']) expect(detail.body).not.toContain(legacy);
  });

  it.each([
    ['missing Authorization', null, {}],
    ['malformed token', 'ncag_short', {}],
    ['unknown well-formed token', 'ncag_' + 'A'.repeat(43), {}],
  ])('%s → 401, nothing recorded', async (_name, token, headers) => {
    build();
    const res = await heartbeat(token, validSnapshot(), headers);
    expect(res.statusCode).toBe(401);
    expect(servers.heartbeats.size).toBe(0);
  });

  it('wrong scheme or extra parts in Authorization → 401', async () => {
    build();
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    for (const header of [`Basic ${token}`, `Bearer ${token} extra`, `bearer ${token}`, token]) {
      const res = await app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: { authorization: header }, payload: validSnapshot() });
      expect(res.statusCode).toBe(401);
    }
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
  });

  it('inactive server → 401 and no update', async () => {
    build();
    const admin = await session('admin');
    const { serverId, token } = await provisioned(admin);
    const server = servers.servers.find((s) => s.id === serverId);
    if (server) server.isActive = false;
    expect((await heartbeat(token)).statusCode).toBe(401);
    expect(servers.heartbeats.size).toBe(0);
  });

  it('browser and machine credentials never cross', async () => {
    build();
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    // Session cookie cannot authorize the machine route (with or without a token).
    expect((await app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: { cookie: admin.cookie }, payload: validSnapshot() })).statusCode).toBe(401);
    expect((await heartbeat(token, validSnapshot(), { cookie: admin.cookie })).statusCode).toBe(401);
    // Browser context on the machine route is refused.
    expect((await heartbeat(token, validSnapshot(), { origin: ORIGIN })).statusCode).toBe(403);
    expect((await heartbeat(token, validSnapshot(), { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(403);
    // Machine token cannot authorize browser routes (and is not accepted next to a cookie either).
    expect((await app.inject({ method: 'GET', url: '/api/servers', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}`, cookie: admin.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/audit', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect(servers.heartbeats.size).toBe(0);
    expectNoToken(token);
  });

  it.each([
    // Current contract (Agent >= 0.5.0).
    ['missing field', 'current', (s: Record<string, unknown>) => { delete s.hostname; }],
    ['missing load average', 'current', (s: Record<string, unknown>) => { delete s.loadAverage; }],
    ['load average length', 'current', (s: Record<string, unknown>) => { s.loadAverage = [1, 2]; }],
    ['negative load', 'current', (s: Record<string, unknown>) => { s.loadAverage = [-1, 0, 0]; }],
    ['load not a number', 'current', (s: Record<string, unknown>) => { s.loadAverage = ['1', 0, 0]; }],
    ['huge load', 'current', (s: Record<string, unknown>) => { s.loadAverage = [1e9, 0, 0]; }],
    ['hostname with spaces', 'current', (s: Record<string, unknown>) => { s.hostname = 'a b'; }],
    ['long hostname', 'current', (s: Record<string, unknown>) => { s.hostname = 'a'.repeat(300); }],
    ['bad version', 'current', (s: Record<string, unknown>) => { s.agentVersion = '1.0; DROP'; }],
    ['unknown field', 'current', (s: Record<string, unknown>) => { s.diskBytes = 1; }],
    // Legacy fields are still validated in their exact old shape while accepted (no free-form JSON).
    ['legacy: wrong type', 'legacy', (s: Record<string, unknown>) => { s.cpuCount = 'four'; }],
    ['legacy: negative uptime', 'legacy', (s: Record<string, unknown>) => { s.uptimeSeconds = -1; }],
    ['legacy: huge cpu count', 'legacy', (s: Record<string, unknown>) => { s.cpuCount = 10_000; }],
    ['legacy: free > total', 'legacy', (s: Record<string, unknown>) => { s.memory = { totalBytes: 1, freeBytes: 2 }; }],
    ['legacy: extra memory key', 'legacy', (s: Record<string, unknown>) => { s.memory = { totalBytes: 2, freeBytes: 1, usedBytes: 1 }; }],
    ['legacy: memory without free', 'legacy', (s: Record<string, unknown>) => { s.memory = { totalBytes: 2 }; }],
  ])('malformed snapshot (%s) → 400, nothing recorded', async (_name, kind, mutate) => {
    build();
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    const payload = (kind === 'legacy' ? legacySnapshot() : validSnapshot()) as unknown as Record<string, unknown>;
    mutate(payload);
    expect((await heartbeat(token, payload)).statusCode).toBe(400);
    expect(servers.heartbeats.size).toBe(0);
  });

  it('oversized body → 413 before reaching the store', async () => {
    build();
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    const res = await heartbeat(token, { ...validSnapshot(), padding: 'x'.repeat(5000) });
    expect(res.statusCode).toBe(413);
    expect(servers.heartbeatCalls).toBe(0);
  });

  it('per-token and per-address limits → 429 with Retry-After, before any DB work', async () => {
    build({ agentTokenMax: 2 });
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    expect([(await heartbeat(token)).statusCode, (await heartbeat(token)).statusCode]).toEqual([200, 200]);
    const limited = await heartbeat(token);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(servers.heartbeatCalls).toBe(2);
    await app.close();
    build({ agentAddressMax: 1 });
    expect((await heartbeat('ncag_' + 'B'.repeat(43))).statusCode).toBe(401);
    expect((await heartbeat('ncag_' + 'C'.repeat(43))).statusCode).toBe(429);
  });

  it('heartbeat concurrency limit → 503 instead of piling up DB work', async () => {
    build({ heartbeatConcurrency: 0 });
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    const res = await heartbeat(token);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('database outage → 503 (fail closed), token never logged', async () => {
    build();
    const admin = await session('admin');
    const { token } = await provisioned(admin);
    servers.failing = true;
    expect((await heartbeat(token)).statusCode).toBe(503);
    expectNoToken(token);
  });
});

describe('snapshot helpers and tokens', () => {
  it('normalizeSnapshot keeps only the current fields (also for stored legacy rows); snapshotProblem checks the legacy memory shape', () => {
    expect(normalizeSnapshot({ ...validSnapshot(), env: { SECRET: 'x' } })).toEqual(validSnapshot());
    expect(normalizeSnapshot(legacySnapshot())).toEqual(validSnapshot({ agentVersion: '0.4.0' }));
    for (const bad of [null, 'x', 42, {}, { ...validSnapshot(), loadAverage: [1, 2] }, { ...validSnapshot(), loadAverage: [Number.NaN, 0, 0] }, { ...validSnapshot(), hostname: 5 }]) {
      expect(normalizeSnapshot(bad)).toBeNull();
    }
    expect(snapshotProblem(validSnapshot())).toBeNull();
    expect(snapshotProblem(legacySnapshot())).toBeNull();
    expect(snapshotProblem(legacySnapshot({ memory: { totalBytes: 1, freeBytes: 2 } }))).toBe('memory_free_exceeds_total');
  });

  it('agent tokens: prefix + 32 random bytes, unique', () => {
    const a = newAgentToken();
    expect(a).toMatch(/^ncag_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a.slice(5), 'base64url')).toHaveLength(32);
    expect(newAgentToken()).not.toBe(a);
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken(`Bearer ${'x'.repeat(300)}`)).toBeUndefined();
  });
});
