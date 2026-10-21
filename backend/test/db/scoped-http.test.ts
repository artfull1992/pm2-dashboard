// Review Codex e621e31 (ADR-028) on the real stack: Fastify app + PostgreSQL stores (auth, servers, control, access)
// in an isolated per-run schema of the TEST database. Checks the actual HTTP answers:
//  P2  — /api/servers/:id/control never reveals how many services exist beyond the reader's grants (broker.total);
//  P1a — an open log long-poll re-reads session/active flag/role/grant from PostgreSQL before handing out text.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { createRateLimiter } from '../../src/auth/rate-limit.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { LogHub } from '../../src/servers/logs.js';
import { captureLogs } from '../helpers.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Scoped-Http-Passw0rd';
const MARKER = 'SYNTHETIC_SCOPED_HTTP_LOG_MARKER_7d1';
const noLog = { error: () => undefined };
let config: DbConfig;
let admin: pg.Client;
let schema: string;
let db: Database;
let app: FastifyInstance;
let hub: LogHub;
let logs: ReturnType<typeof captureLogs>;
const sql = async (q: string, v: unknown[] = []) => {
  await admin.query(`SET search_path TO "${schema}"`);
  try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
};

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
  schema = newRunSchemaName();
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  hub = new LogHub();
  logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 2_000, createDatabase: () => db, logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 }, logHub: hub,
      extra: {
        accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
        agentTokenLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), agentAddressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }),
      },
    },
  });
  await app.ready();
  const hash = await hashPassword(PASSWORD);
  for (const [email, role] of [['admin@example.test', 'admin'], ['op-all@example.test', 'operator'], ['op-sel@example.test', 'operator'], ['viewer-sel@example.test', 'viewer'], ['nobody@example.test', 'operator'], ['reader@example.test', 'operator']]) {
    await sql('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)', [email, hash, role]);
  }
});

afterAll(async () => {
  await app.close();
  await db.close();
  await dropRunSchema(admin, schema);
  await admin.end();
  expect(logs.text()).not.toContain(MARKER);
});

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof login>>;
const userId = async (email: string) => ((await sql('SELECT id FROM users WHERE email = $1', [email])).rows[0] as { id: string }).id;
async function server(as: Session, name: string) {
  const headers = { cookie: as.cookie, origin: ORIGIN, 'x-csrf-token': as.csrf };
  const id = (await app.inject({ method: 'POST', url: '/api/servers', headers, payload: { name } })).json<{ id: string }>().id;
  const token = (await app.inject({ method: 'POST', url: `/api/servers/${id}/agent-credentials`, headers })).json<{ token: string }>().token;
  return { id, token };
}
const grant = async (email: string, serverId: string, mode: 'all' | 'selected', services: string[] = []) => {
  const u = await userId(email);
  await sql('INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, $3)', [u, serverId, mode]);
  for (const n of services) await sql('INSERT INTO user_service_access (user_id, server_id, service_name) VALUES ($1, $2, $3)', [u, serverId, n]);
};
const target = (i: number) => ({ targetKey: `n-${String(i).padStart(24, '0')}`, name: `svc-${String(i).padStart(3, '0')}`, pmId: i, actions: ['restart'], matchStatus: 'ok', identity: 'a'.repeat(16) });
const controlPoll = (token: string, targets: object[], total: number) => app.inject({
  method: 'POST', url: '/api/agent/control/poll', headers: { authorization: `Bearer ${token}` },
  payload: { version: 2, mode: 'auto', broker: 'ok', daemon: 'ok', allowlist: 'ok', targets, total },
});
const control = async (s: Session, id: string) => app.inject({ method: 'GET', url: `/api/servers/${id}/control`, headers: { cookie: s.cookie } });

describe('P2 — scoped counters: broker.total over HTTP', () => {
  it('two services, one granted: admin and "all" see the total; selected/viewer/no grant never see it', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss, `counts-${randomUUID().slice(0, 6)}`);
    expect((await controlPoll(n.token, [target(0), target(1)], 2)).statusCode).toBe(200);
    await grant('op-all@example.test', n.id, 'all');
    await grant('op-sel@example.test', n.id, 'selected', ['svc-000']);
    await grant('viewer-sel@example.test', n.id, 'selected', ['svc-000']);
    const seen = async (email: string) => {
      const res = email === 'admin@example.test' ? await control(boss, n.id) : await control(await login(email), n.id);
      return res.statusCode === 200 ? { total: res.json<{ broker: { total: number | null } }>().broker.total, targets: res.json<{ targets: unknown[] }>().targets.length } : res.statusCode;
    };
    expect(await seen('admin@example.test')).toEqual({ total: 2, targets: 2 });
    expect(await seen('op-all@example.test')).toEqual({ total: 2, targets: 2 });
    expect(await seen('op-sel@example.test')).toEqual({ total: null, targets: 1 });
    expect(await seen('viewer-sel@example.test')).toEqual({ total: null, targets: 1 });
    expect(await seen('nobody@example.test')).toBe(404);
  });

  it('> 500 processes: the cut is reported to admin / "all" only; a selected reader gets no hint', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss, `big-${randomUUID().slice(0, 6)}`);
    expect((await controlPoll(n.token, Array.from({ length: 500 }, (_, i) => target(i)), 640)).statusCode).toBe(200);
    await grant('op-all@example.test', n.id, 'all');
    await grant('op-sel@example.test', n.id, 'selected', ['svc-001', 'svc-777']);
    expect((await control(boss, n.id)).json()).toMatchObject({ broker: { total: 640 } });
    expect((await control(await login('op-all@example.test'), n.id)).json()).toMatchObject({ broker: { total: 640 } });
    const sel = (await control(await login('op-sel@example.test'), n.id)).json<{ broker: { total: number | null }; targets: { name: string }[] }>();
    expect(sel.broker.total).toBeNull();
    expect(sel.targets.map((t) => t.name)).toEqual(['svc-001']);
  });
});

describe('P1a — open log long-poll against PostgreSQL auth and grants', () => {
  const logTarget = { targetKey: 'api', name: 'api', pmId: 1, matchStatus: 'ok', identity: 'b'.repeat(16) };
  const logReport = { version: 2, mode: 'allowlist', broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: [logTarget], total: 1 };
  const result = (requestId: string) => ({
    version: 1, requestId, outcome: 'ok', reason: null, readAt: new Date().toISOString(),
    stdout: { state: 'ok', text: `line ${MARKER}`, lines: 1, truncated: false, sizeBytes: 10, modifiedAt: new Date().toISOString() },
    stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null },
  });

  async function open(change: (readerId: string, serverId: string) => Promise<unknown>) {
    const boss = await login('admin@example.test');
    const n = await server(boss, `logs-${randomUUID().slice(0, 6)}`);
    const reader = await userId('reader@example.test');
    await sql("UPDATE users SET role = 'operator', is_active = true WHERE id = $1", [reader]);
    await sql('DELETE FROM user_server_access WHERE user_id = $1', [reader]);
    await grant('reader@example.test', n.id, 'selected', ['api']);
    const s = await login('reader@example.test');
    let close: () => void = () => undefined;
    const reg = hub.agentPoll(n.id, logReport as never, (cb) => { close = cb; });
    close();
    await reg;
    const created = await app.inject({ method: 'POST', url: `/api/servers/${n.id}/log-requests`, headers: { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf }, payload: { targetKey: 'api' } });
    expect(created.statusCode, created.body).toBe(202);
    const requestId = created.json<{ requestId: string }>().requestId;
    const took = await app.inject({ method: 'POST', url: '/api/agent/logs/poll', headers: { authorization: `Bearer ${n.token}` }, payload: logReport });
    expect(took.json<{ requests: unknown[] }>().requests).toHaveLength(1);
    const held = app.inject({ method: 'GET', url: `/api/log-requests/${requestId}`, headers: { cookie: s.cookie } });
    await new Promise((r) => setTimeout(r, 50));
    await change(reader, n.id);
    expect((await app.inject({ method: 'POST', url: '/api/agent/logs/result', headers: { authorization: `Bearer ${n.token}` }, payload: result(requestId) })).statusCode).toBe(200);
    return held;
  }

  it.each([
    ['operator → viewer (SQL, sessions kept)', (u: string) => sql("UPDATE users SET role = 'viewer' WHERE id = $1", [u]), 403],
    ['deactivated', (u: string) => sql('UPDATE users SET is_active = false WHERE id = $1', [u]), 401],
    ['session revoked', (u: string) => sql('UPDATE sessions SET revoked_at = now() WHERE user_id = $1', [u]), 401],
    ['grant revoked', (u: string, id: string) => sql('DELETE FROM user_server_access WHERE user_id = $1 AND server_id = $2', [u, id]), 404],
    ['unchanged', () => Promise.resolve(), 200],
  ] as const)('%s while waiting → %i', async (_name, change, status) => {
    const res = await open(change);
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(res.body).toContain(MARKER);
    else expect(res.body).not.toContain(MARKER);
  });
});
