import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import type { Dashboard, DashboardStore } from '../src/servers/dashboard-store.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';

// GET /api/dashboard (Task 012, ADR-020): access contract, server-side recent-action policy, strict response,
// safe errors, read-only (no audit). Aggregation SQL itself is covered by backend/test/db/dashboard.test.ts.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Dash-Passw0rd-7';
const SERVER = '11111111-1111-4111-8111-111111111111';

function sample(withActions: boolean): Dashboard & Record<string, unknown> {
  return {
    generatedAt: '2026-10-14T12:00:00.000Z',
    windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
    servers: { total: 3, inactive: 1, active: 2, online: 1, offline: 1, neverConnected: 0 },
    inventory: { current: 1, stale: 0, unavailable: 0, notReported: 1 },
    processes: { live: { total: 2, online: 1, problem: 1, transitional: 0 }, notLive: 1 },
    attentionServers: { items: [{ id: SERVER, name: 'b', status: 'offline', reason: 'offline', lastSeenAt: '2026-10-14T11:00:00.000Z', inventoryCollectedAt: null }], total: 1, limit: 20 },
    attentionProcesses: { items: [{ serverId: SERVER, serverName: 'a', pmId: 1, name: 'api', status: 'errored', restarts: 3, uptimeSeconds: null }], total: 1, limit: 20 },
    serverList: {
      items: [{
        id: SERVER, name: 'a', status: 'online', lastSeenAt: '2026-10-14T11:59:50.000Z',
        // Extra fields a store might leak must never reach the client.
        // Legacy host metrics a store could still hand over must never reach the client (ADR-023).
        metrics: { hostname: 'h', loadAverage: [0.1, 0.2, 0.3], uptimeSeconds: 10, cpuCount: 2, memory: { totalBytes: 0, freeBytes: 0 } } as never,
        inventory: { state: 'current', collectedAt: '2026-10-14T11:59:00.000Z' }, processes: { total: 2, online: 1, problem: 1 },
        agentToken: 'ncag_SHOULD_NOT_LEAK',
      } as never],
      total: 2, limit: 50,
    },
    recentActions: withActions ? {
      items: [{ id: '22222222-2222-4222-8222-222222222222', serverId: SERVER, serverName: 'a', targetKey: 'api', serviceName: 'api', action: 'restart', status: 'queued', reason: null, requestedAt: '2026-10-14T11:00:00.000Z', completedAt: null, requestedByMe: true, overdue: true, requestedBy: 'leak' } as never],
      limit: 10,
    } : null,
    passwordHash: 'scrypt$SHOULD_NOT_LEAK',
  };
}

class FakeDashboard implements DashboardStore {
  calls: (string | null)[] = [];
  scopes: (string | null | undefined)[] = [];
  fail = false;
  dashboard(input: { actionsFor: string | null; scope?: string | null }): Promise<Dashboard> {
    this.calls.push(input.actionsFor);
    this.scopes.push(input.scope);
    if (this.fail) return Promise.reject(Object.assign(new Error('relation "servers" secret SQL text'), { code: '57P01' }));
    return Promise.resolve(sample(input.actionsFor !== null));
  }
}

let app: FastifyInstance;
let auth: FakeAuthStore;
let dash: FakeDashboard;
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  auth = new FakeAuthStore();
  dash = new FakeDashboard();
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createDashboardStore: () => dash,
      extra: { accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }) },
    },
  });
});
afterEach(async () => { await app.close(); });

async function session(role: Role) {
  const u = await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const raw = res.headers['set-cookie'];
  return { id: u.id, cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '' };
}
const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/dashboard', headers: cookie ? { cookie } : {} });

describe('GET /api/dashboard', () => {
  it('scope (ADR-028): operator/viewer aggregates are limited to their own grants; admin is global', async () => {
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const s = await session(role);
      expect((await get(s.cookie)).statusCode).toBe(200);
      expect(dash.scopes.at(-1), role).toBe(role === 'admin' ? null : s.id);
    }
  });

  it('anonymous → 401; the store is never asked', async () => {
    expect((await get()).statusCode).toBe(401);
    expect(dash.calls).toEqual([]);
  });

  it('viewer: 200 without recent actions — decided on the server (the actions query is not even requested)', async () => {
    const v = await session('viewer');
    const res = await get(v.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<Dashboard>().recentActions).toBeNull();
    expect(dash.calls).toEqual([null]);
  });

  it.each(['operator', 'admin'] as const)('%s: recent actions requested for its own user id', async (role) => {
    const s = await session(role);
    const res = await get(s.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<Dashboard>().recentActions?.items[0]).toEqual({
      id: '22222222-2222-4222-8222-222222222222', serverId: SERVER, serverName: 'a', targetKey: 'api', serviceName: 'api', action: 'restart', status: 'queued',
      reason: null, requestedAt: '2026-10-14T11:00:00.000Z', completedAt: null, requestedByMe: true, overdue: true,
    });
    expect(dash.calls).toEqual([s.id]);
  });

  it('strict response: unknown fields (tokens, hashes, extra metrics, requester ids) never reach the client', async () => {
    const a = await session('admin');
    const res = await get(a.cookie);
    for (const leak of ['SHOULD_NOT_LEAK', 'passwordHash', 'agentToken', 'freeBytes', 'requestedBy"', 'leak', 'uptimeSeconds":10', 'cpuCount', 'memory', 'usedPercent']) expect(res.body).not.toContain(leak);
    const body = res.json<Dashboard>();
    expect(Object.keys(body).sort()).toEqual(['attentionProcesses', 'attentionServers', 'generatedAt', 'inventory', 'processes', 'recentActions', 'serverList', 'servers', 'windows']);
    expect(body.serverList.items[0]?.metrics).toEqual({ hostname: 'h', loadAverage: [0.1, 0.2, 0.3] });
  });

  it('database failure → 503 + Retry-After, no SQL or error text in the response or logs', async () => {
    const v = await session('viewer');
    dash.fail = true;
    const res = await get(v.cookie);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.body).not.toMatch(/relation|secret|SQL/);
    expect(logs.text()).not.toMatch(/relation "servers"|secret SQL/);
  });

  it('read-only: no audit rows, no session changes; POST is not a route', async () => {
    const o = await session('operator');
    const auditBefore = auth.audit.length;
    const sessionsBefore = JSON.stringify(auth.sessions);
    for (let i = 0; i < 3; i++) expect((await get(o.cookie)).statusCode).toBe(200);
    expect(auth.audit.length).toBe(auditBefore);
    expect(JSON.stringify(auth.sessions)).toBe(sessionsBefore);
    expect((await app.inject({ method: 'POST', url: '/api/dashboard', headers: { cookie: o.cookie, origin: ORIGIN } })).statusCode).toBe(404);
  });
});
