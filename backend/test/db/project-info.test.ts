// Project information of applications (ADR-036) on the real stack: Fastify app + PostgreSQL stores in an isolated
// per-run schema of the TEST database. Identity (server + PM2 name), scope, revision/concurrency, audit in the same
// transaction (and its rollback), inventory reports that never touch the information, and the table constraints.
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
import { captureLogs } from '../helpers.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Project-Info-Db-Passw0rd';
const MARK = 'SYNTHETIC_PROJECT_INFO_DB_DESCRIPTION_5c2';
const noLog = { error: () => undefined };
let config: DbConfig;
let admin: pg.Client;
let schema: string;
let db: Database;
let app: FastifyInstance;
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
  db = createDatabase({ ...config, poolMax: 10 }, noLog, createPool({ ...config, poolMax: 10 }, { searchPath: schema }));
  logs = captureLogs();
  const unlimited = () => createRateLimiter({ max: 10_000, windowMs: 60_000 });
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 2_000, createDatabase: () => db, logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 }, userAdminLimiter: unlimited(),
      extra: { accountLimiter: unlimited(), addressLimiter: unlimited(), agentTokenLimiter: unlimited(), agentAddressLimiter: unlimited() },
    },
  });
  await app.ready();
  const hash = await hashPassword(PASSWORD);
  for (const [email, role] of [['admin@example.test', 'admin'], ['op-all@example.test', 'operator'], ['op-sel@example.test', 'operator'], ['viewer-sel@example.test', 'viewer'], ['nobody@example.test', 'viewer']]) {
    await sql('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)', [email, hash, role]);
  }
});

afterAll(async () => {
  await app.close();
  await db.close();
  await dropRunSchema(admin, schema);
  await admin.end();
  // Values are data: never in the operational log.
  expect(logs.text()).not.toContain(MARK);
});

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  const raw = res.headers['set-cookie'];
  return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
}
type Session = Awaited<ReturnType<typeof login>>;
const userId = async (email: string) => ((await sql('SELECT id FROM users WHERE email = $1', [email])).rows[0] as { id: string }).id;
const headersOf = (s: Session) => ({ cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf });

let clock = Date.now() - 3_600_000;
async function server(boss: Session, name = `srv-${randomUUID().slice(0, 8)}`) {
  const id = (await app.inject({ method: 'POST', url: '/api/servers', headers: headersOf(boss), payload: { name } })).json<{ id: string }>().id;
  const token = (await app.inject({ method: 'POST', url: `/api/servers/${id}/agent-credentials`, headers: headersOf(boss) })).json<{ token: string }>().token;
  return { id, token };
}
/** One Agent inventory report (the real machine route): `[pmId, name]` pairs, always newer than the previous one. */
async function inventory(token: string, processes: [number, string][]) {
  clock += 60_000;
  const res = await app.inject({
    method: 'POST', url: '/api/agent/inventory', headers: { authorization: `Bearer ${token}` },
    payload: {
      version: 1, state: 'ok', reason: null, source: 'pm2', capturedAt: new Date(clock).toISOString(),
      processes: processes.map(([pmId, name]) => ({ pmId, name, status: 'online', uptimeSeconds: 5, restarts: 0, cpuPercent: 1, memoryBytes: 1024, execMode: 'fork' })),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json<{ status: string }>().status).toBe('accepted');
}
const grant = async (email: string, serverId: string, mode: 'all' | 'selected', services: string[] = []) => {
  const u = await userId(email);
  await sql('INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, $3)', [u, serverId, mode]);
  for (const n of services) await sql('INSERT INTO user_service_access (user_id, server_id, service_name) VALUES ($1, $2, $3)', [u, serverId, n]);
};
const read = (s: Session, serverId: string, service: string) =>
  app.inject({ method: 'GET', url: `/api/servers/${serverId}/project-info?${new URLSearchParams({ service }).toString()}`, headers: { cookie: s.cookie } });
const save = (s: Session, serverId: string, service: string, expectedRevision: number, fields: Partial<Record<'githubUrl' | 'projectUrl' | 'description', string | null>> = {}) =>
  app.inject({
    method: 'PUT', url: `/api/servers/${serverId}/project-info`, headers: headersOf(s),
    payload: { serviceName: service, expectedRevision, githubUrl: null, projectUrl: null, description: null, ...fields },
  });
const rows = async (serverId: string) => (await sql('SELECT service_name, github_url, project_url, description, revision::int AS revision FROM application_project_info WHERE server_id = $1 ORDER BY service_name', [serverId])).rows as Record<string, unknown>[];
const audits = async (serverId: string) => (await sql(
  "SELECT outcome, actor_user_id, details FROM audit_log WHERE event = 'application.project_info_changed' AND details->>'serverId' = $1 ORDER BY id", [serverId])).rows as
  { outcome: string; actor_user_id: string; details: Record<string, unknown> }[];

describe('read, create, change, clear', () => {
  it('empty state: revision 0, nulls — and reading writes nothing', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    const res = await read(boss, n.id, 'api');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ serverId: n.id, serviceName: 'api', revision: 0, githubUrl: null, projectUrl: null, description: null, updatedAt: null });
    expect(await rows(n.id)).toEqual([]);
  });

  it('first save → revision 1; change → 2; clearing every field keeps the row with nulls → 3; one audit row per change without values', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    const first = await save(boss, n.id, 'api', 0, { githubUrl: 'https://github.com/acme/api.git', projectUrl: 'https://api.example.com/docs', description: `${MARK}\r\nдругий рядок` });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ revision: 1, githubUrl: 'https://github.com/acme/api.git', projectUrl: 'https://api.example.com/docs', description: `${MARK}\nдругий рядок` });
    expect((await read(boss, n.id, 'api')).json()).toEqual(first.json());

    const second = await save(boss, n.id, 'api', 1, { githubUrl: 'https://github.com/acme/api.git', projectUrl: 'https://app.example.com', description: `${MARK}\nдругий рядок` });
    expect(second.json()).toMatchObject({ revision: 2, projectUrl: 'https://app.example.com' });
    const cleared = await save(boss, n.id, 'api', 2, { githubUrl: '', projectUrl: null, description: '   ' });
    expect(cleared.json()).toMatchObject({ revision: 3, githubUrl: null, projectUrl: null, description: null });
    expect(await rows(n.id)).toEqual([{ service_name: 'api', github_url: null, project_url: null, description: null, revision: 3 }]);

    const adminId = await userId('admin@example.test');
    const trail = await audits(n.id);
    expect(trail.map((a) => [a.outcome, a.actor_user_id, a.details])).toEqual([
      ['success', adminId, { serverId: n.id, serviceName: 'api', revision: 1, changed: 'github,url,description' }],
      ['success', adminId, { serverId: n.id, serviceName: 'api', revision: 2, changed: 'url' }],
      ['success', adminId, { serverId: n.id, serviceName: 'api', revision: 3, changed: 'github,url,description' }],
    ]);
    expect(JSON.stringify(trail)).not.toContain(MARK);
    expect(JSON.stringify(trail)).not.toContain('example.com');
  });

  it('a save without changes keeps the revision and writes no audit row', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await save(boss, n.id, 'api', 0, { description: 'same' });
    const again = await save(boss, n.id, 'api', 1, { description: 'same' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ revision: 1 });
    expect(await audits(n.id)).toHaveLength(1);
  });

  it('the audit log shows the event with the server name resolved at read time', async () => {
    const boss = await login('admin@example.test');
    const name = `audit-${randomUUID().slice(0, 6)}`;
    const n = await server(boss, name);
    await inventory(n.token, [[0, 'api']]);
    await save(boss, n.id, 'api', 0, { description: 'x' });
    const page = (await app.inject({ method: 'GET', url: '/api/audit?limit=50', headers: { cookie: boss.cookie } })).json<{ items: { event: string; details: Record<string, unknown>; context: { serverName: string | null } | null }[] }>();
    const item = page.items.find((i) => i.event === 'application.project_info_changed' && i.details.serverId === n.id);
    expect(item?.details).toEqual({ serverId: n.id, serviceName: 'api', revision: 1, changed: 'description' });
    expect(item?.context?.serverName).toBe(name);
  });
});

describe('optimistic concurrency', () => {
  it('a stale expectedRevision → 409 and the newer data stays', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await save(boss, n.id, 'api', 0, { description: 'newer' });
    expect((await save(boss, n.id, 'api', 0, { description: 'older' })).statusCode).toBe(409);
    expect((await save(boss, n.id, 'api', 5, { description: 'future' })).statusCode).toBe(409);
    expect(await rows(n.id)).toMatchObject([{ description: 'newer', revision: 1 }]);
    expect(await audits(n.id)).toHaveLength(1);
  });

  it('concurrent FIRST saves: exactly one wins, the other gets 409; one row, one audit row', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => save(boss, n.id, 'api', 0, { description: `writer ${String(i)}` })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    const winner = results.find((r) => r.statusCode === 200)?.json<{ description: string }>().description;
    expect(await rows(n.id)).toEqual([{ service_name: 'api', github_url: null, project_url: null, description: winner, revision: 1 }]);
    expect(await audits(n.id)).toHaveLength(1);
  });

  it('concurrent changes of the same revision: exactly one wins', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await save(boss, n.id, 'api', 0, { description: 'base' });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => save(boss, n.id, 'api', 1, { description: `change ${String(i)}` })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect(await rows(n.id)).toMatchObject([{ revision: 2 }]);
    expect(await audits(n.id)).toHaveLength(2);
  });
});

describe('audit in the same transaction', () => {
  it('when the audit insert fails the change is rolled back (503, nothing stored), and it works again afterwards', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await save(boss, n.id, 'api', 0, { description: 'kept' });
    await sql("ALTER TABLE audit_log ADD CONSTRAINT test_block_project_info CHECK (event <> 'application.project_info_changed') NOT VALID");
    try {
      const failedUpdate = await save(boss, n.id, 'api', 1, { description: 'lost' });
      expect(failedUpdate.statusCode).toBe(503);
      expect(failedUpdate.body).not.toContain('test_block_project_info');
      const failedInsert = await save(boss, n.id, 'worker-none', 0, { description: 'lost' });
      expect(failedInsert.statusCode).toBe(404); // not in the inventory: refused before any write
    } finally {
      await sql('ALTER TABLE audit_log DROP CONSTRAINT test_block_project_info');
    }
    expect(await rows(n.id)).toMatchObject([{ description: 'kept', revision: 1 }]);
    expect((await save(boss, n.id, 'api', 1, { description: 'after' })).json()).toMatchObject({ revision: 2, description: 'after' });
  });

  it('a failing first save leaves no row', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await sql("ALTER TABLE audit_log ADD CONSTRAINT test_block_project_info CHECK (event <> 'application.project_info_changed') NOT VALID");
    try {
      expect((await save(boss, n.id, 'api', 0, { description: 'lost' })).statusCode).toBe(503);
    } finally {
      await sql('ALTER TABLE audit_log DROP CONSTRAINT test_block_project_info');
    }
    expect(await rows(n.id)).toEqual([]);
    expect((await read(boss, n.id, 'api')).json()).toMatchObject({ revision: 0 });
  });
});

describe('access', () => {
  it('only admin saves: operator (even with full access) and viewer → 403, nothing stored', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await grant('op-all@example.test', n.id, 'all');
    await grant('viewer-sel@example.test', n.id, 'selected', ['api']);
    for (const email of ['op-all@example.test', 'viewer-sel@example.test']) {
      expect((await save(await login(email), n.id, 'api', 0, { description: 'x' })).statusCode, email).toBe(403);
    }
    expect(await rows(n.id)).toEqual([]);
  });

  it('reading follows the resource scope; anything invisible or unknown is 404 without telling which', async () => {
    const boss = await login('admin@example.test');
    const a = await server(boss);
    const b = await server(boss);
    await inventory(a.token, [[0, 'api'], [1, 'worker']]);
    await inventory(b.token, [[0, 'api']]);
    await save(boss, a.id, 'api', 0, { description: 'A api' });
    await save(boss, a.id, 'worker', 0, { description: 'A worker' });
    await grant('op-all@example.test', a.id, 'all');
    await grant('op-sel@example.test', a.id, 'selected', ['api']);
    await grant('viewer-sel@example.test', a.id, 'selected', ['api']);
    const status = async (email: string, serverId: string, service: string) => (await read(await login(email), serverId, service)).statusCode;
    expect(await status('op-all@example.test', a.id, 'worker')).toBe(200);
    expect(await status('op-sel@example.test', a.id, 'api')).toBe(200);
    expect(await status('viewer-sel@example.test', a.id, 'api')).toBe(200);
    expect((await read(await login('viewer-sel@example.test'), a.id, 'api')).json()).toMatchObject({ description: 'A api' });
    // Not granted service, other server, a server that does not exist, no grants at all: all the same 404.
    expect(await status('op-sel@example.test', a.id, 'worker')).toBe(404);
    expect(await status('viewer-sel@example.test', b.id, 'api')).toBe(404);
    expect(await status('viewer-sel@example.test', randomUUID(), 'api')).toBe(404);
    expect(await status('nobody@example.test', a.id, 'api')).toBe(404);
  });

  it('a name that was never reported: read 404 and save 404 — no rows for invented services', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    expect((await read(boss, n.id, 'invented')).statusCode).toBe(404);
    expect((await save(boss, n.id, 'invented', 0, { description: 'x' })).statusCode).toBe(404);
    expect((await save(boss, randomUUID(), 'api', 0, { description: 'x' })).statusCode).toBe(404);
    expect(await rows(n.id)).toEqual([]);
  });
});

describe('identity: server + PM2 name', () => {
  it('the same name on two servers has independent information', async () => {
    const boss = await login('admin@example.test');
    const a = await server(boss);
    const b = await server(boss);
    await inventory(a.token, [[0, 'api']]);
    await inventory(b.token, [[0, 'api']]);
    await save(boss, a.id, 'api', 0, { description: 'on A' });
    expect((await read(boss, b.id, 'api')).json()).toMatchObject({ revision: 0, description: null });
    await save(boss, b.id, 'api', 0, { description: 'on B' });
    expect((await read(boss, a.id, 'api')).json()).toMatchObject({ revision: 1, description: 'on A' });
  });

  it('inventory reports never touch it: a new pm_id keeps it, a gone name keeps it (read only), the name coming back inherits it', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api'], [1, 'worker']]);
    await save(boss, n.id, 'api', 0, { githubUrl: 'https://github.com/acme/api', description: 'kept' });
    await inventory(n.token, [[7, 'api'], [1, 'worker']]); // restart under a new pm_id
    expect((await read(boss, n.id, 'api')).json()).toMatchObject({ revision: 1, description: 'kept', githubUrl: 'https://github.com/acme/api' });
    await inventory(n.token, [[1, 'worker']]); // deleted from PM2
    expect((await read(boss, n.id, 'api')).json()).toMatchObject({ revision: 1, description: 'kept' });
    expect((await save(boss, n.id, 'api', 1, { description: 'while gone' })).statusCode).toBe(404);
    await inventory(n.token, [[12, 'api'], [1, 'worker']]); // the same name again
    expect((await read(boss, n.id, 'api')).json()).toMatchObject({ revision: 1, description: 'kept' });
    // A new process with ANOTHER name gets nothing of the old one.
    await inventory(n.token, [[0, 'api-v2'], [1, 'worker']]);
    expect((await read(boss, n.id, 'api-v2')).json()).toMatchObject({ revision: 0, description: null });
    expect(await rows(n.id)).toMatchObject([{ service_name: 'api', description: 'kept', revision: 1 }]);
  });

  it('two PM2 processes with the same name on one server share one record (no uniqueness per pm_id)', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'web'], [1, 'web']]);
    await save(boss, n.id, 'web', 0, { description: 'shared' });
    expect(await rows(n.id)).toMatchObject([{ service_name: 'web', description: 'shared' }]);
  });

  it('names with spaces, slashes, ?, #, % and unicode work end to end', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    const names = ['my app', 'api/v1', 'a?b#c', '100%', 'сервіс'];
    await inventory(n.token, names.map((name, i) => [i, name]));
    for (const name of names) {
      expect((await save(boss, n.id, name, 0, { description: name })).statusCode, name).toBe(200);
      expect((await read(boss, n.id, name)).json(), name).toMatchObject({ serviceName: name, description: name });
    }
  });

  it('deleting a server removes its information (cascade)', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    await inventory(n.token, [[0, 'api']]);
    await save(boss, n.id, 'api', 0, { description: 'x' });
    await sql('DELETE FROM servers WHERE id = $1', [n.id]);
    expect(await rows(n.id)).toEqual([]);
  });
});

describe('table constraints (migration 1791900000010)', () => {
  it('refuses values the API would never write', async () => {
    const boss = await login('admin@example.test');
    const n = await server(boss);
    const insert = (over: Record<string, unknown>) => {
      const v = { service_name: 'api', github_url: null, project_url: null, description: null, revision: 1, ...over };
      return sql('INSERT INTO application_project_info (server_id, service_name, github_url, project_url, description, revision) VALUES ($1, $2, $3, $4, $5, $6)',
        [n.id, v.service_name, v.github_url, v.project_url, v.description, v.revision]);
    };
    const bad: Record<string, unknown>[] = [
      { revision: 0 }, { service_name: '' }, { service_name: 'a\u0001' }, { service_name: 'x'.repeat(129) },
      { github_url: 'http://github.com/o/r' }, { github_url: 'https://gitlab.com/o/r' }, { github_url: 'https://github.com/o/r?x' },
      { project_url: 'javascript:alert(1)' }, { project_url: 'https://exa mple.com' }, { project_url: 'https://a.example\\b' }, { project_url: `https://a.example/${'a'.repeat(2048)}` },
      { description: '' }, { description: 'bell\u0007' }, { description: 'x'.repeat(2001) },
    ];
    for (const over of bad) await expect(insert(over), JSON.stringify(over).slice(0, 60)).rejects.toThrow();
    await expect(insert({ github_url: 'https://github.com/o/r.git', project_url: 'http://127.0.0.1:3000/x?y#z', description: 'рядок\n\tдругий' })).resolves.toBeTruthy();
    await expect(insert({})).rejects.toThrow(/application_project_info_pkey/);
  });

  it('additive: the earlier tables are unchanged and the new one references only servers and users', async () => {
    const refs = (await sql(`SELECT confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = 'application_project_info'::regclass AND contype = 'f' ORDER BY 1`)).rows.map((r: { target: string }) => r.target);
    expect(refs.map((r) => r.replace(/^.*\./, '').replace(/"/g, ''))).toEqual(['servers', 'users']);
    const pointing = (await sql(`SELECT conrelid::regclass::text AS source FROM pg_constraint WHERE confrelid = 'application_project_info'::regclass`)).rows;
    expect(pointing).toEqual([]);
  });
});
