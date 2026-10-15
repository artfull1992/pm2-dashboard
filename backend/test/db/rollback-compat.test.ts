// Rollback compatibility after ADR-023 (monitoring simplification) — ONLY the isolated test DB, per-run schema.
//
// State sequence reproduced in the database exactly as the releases leave it:
//   1. an Agent 0.4.x full heartbeat stored by the pre-ADR-023 API (legacy row: memory, uptimeSeconds, cpuCount);
//   2. the ADR-023 API stores every heartbeat — also from 0.4.x Agents — as a MINIMAL snapshot;
//   3. Agent 0.5.0 sends minimal heartbeats;
//   4. rollback to THIS release (compatibility release of the pre-ADR-023 code);
//   5. everything below runs without any new heartbeat (offline/deactivated nodes never send one).
// The minimal shape below is exactly what the ADR-023 API writes (backend/src/servers/snapshot.ts normalizeSnapshot).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { createRateLimiter } from '../../src/auth/rate-limit.js';
import { ALERTS_DEFAULTS, type DbConfig } from '../../src/config.js';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import type { EvaluationConfig } from '../../src/alerts/settings.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { captureLogs } from '../helpers.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Rollback-Passw0rd-1';
const noLog = { error: () => undefined };
const minimal = (agentVersion: string, load: [number, number, number] = [0.5, 0.4, 0.3]) => ({ agentVersion, hostname: 'node.example', platform: 'linux', arch: 'x64', loadAverage: load });
const legacyFull = { agentVersion: '0.4.0', hostname: 'old.example', platform: 'linux', arch: 'x64', uptimeSeconds: 3600, cpuCount: 2, loadAverage: [1, 1, 1], memory: { totalBytes: 1000, freeBytes: 10 } };

let config: DbConfig;
let admin: pg.Client;
let db: Database;
let raw: pg.Client;
let app: FastifyInstance;
let schema: string;
const sql = (q: string, v: unknown[] = []) => raw.query(q, v);
const ids: Record<string, string> = {};

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
  schema = newRunSchemaName();
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  raw = await connectTestClient(config);
  await raw.query(`SET search_path TO "${schema}"`);
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 2_000, createDatabase: () => db, logStream: captureLogs().stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      extra: { accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }) },
    },
  });
  const hash = await hashPassword(PASSWORD);
  for (const role of ['admin', 'viewer'] as const) await sql('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)', [`${role}@example.test`, hash, role]);

  const server = async (key: string, opts: { snapshot?: object; seenAgo?: number; active?: boolean }) => {
    const id = ((await sql('INSERT INTO servers (name, is_active) VALUES ($1, $2) RETURNING id', [key, opts.active ?? true])).rows[0] as { id: string }).id;
    if (opts.snapshot) await sql('INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - make_interval(secs => $2), $3::jsonb)', [id, opts.seenAgo ?? 5, JSON.stringify(opts.snapshot)]);
    ids[key] = id;
    return id;
  };
  await server('legacy-online', { snapshot: legacyFull });                       // 1. stored before ADR-023
  await server('old-agent-online', { snapshot: minimal('0.4.0') });             // 2. 0.4.x heartbeat stored by the ADR-023 API
  const fresh = await server('new-agent-online', { snapshot: minimal('0.5.0') });  // 3. Agent 0.5.0
  await server('minimal-offline', { snapshot: minimal('0.5.0'), seenAgo: 3600 }); // no new heartbeat will ever come
  await server('minimal-deactivated', { snapshot: minimal('0.5.0'), active: false });
  await server('never-connected', {});
  // A live PM2 inventory on the 0.5.0 node: process rules must keep working after the rollback.
  await sql(`INSERT INTO server_inventories (server_id, source, state, reason, reported_at, report_captured_at, inventory_captured_at, inventory_collected_at, process_count)
             VALUES ($1, 'pm2', 'ok', NULL, now(), now(), now(), now(), 1)`, [fresh]);
  await sql("INSERT INTO server_applications (server_id, source, pm_id, name, status, restarts, uptime_seconds, cpu_percent, first_seen_at) VALUES ($1, 'pm2', 0, 'api', 'errored', 0, NULL, NULL, now())", [fresh]);
  // History: a server_memory incident closed by migration 1791900000008 as "retired", with its sent problem message.
  ids.retired = ((await sql(`INSERT INTO alert_incidents (condition_key, server_id, rule, severity, status, resolution, server_name, detail, notify, opened_at, last_observed_at, resolved_at)
    VALUES ($1, $2, 'server_memory', 'warning', 'resolved', 'retired', 'legacy-online', '{"value": 95, "threshold": 90}', true, now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour') RETURNING id`,
  [`server_memory:${ids['legacy-online'] ?? ''}`, ids['legacy-online']])).rows[0] as { id: string }).id;
  await sql("INSERT INTO alert_outbox (incident_id, kind, status, generation, finished_at) VALUES ($1, 'firing', 'sent', 1, now() - interval '2 hours')", [ids.retired]);
});
afterAll(async () => {
  await app.close();
  await raw.end();
  await dropRunSchema(admin, schema);
  await admin.end();
});

const login = async (role: 'admin' | 'viewer') => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
  const c = res.headers['set-cookie'];
  return { cookie: (Array.isArray(c) ? c[0] : c)?.split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
};
const get = async (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

describe('rollback target reads ADR-023 data without any new heartbeat', () => {
  it('server detail: minimal snapshots (online, offline, deactivated) and the legacy row answer 200; absent host metrics stay absent', async () => {
    const { cookie } = await login('viewer');
    for (const key of ['old-agent-online', 'new-agent-online', 'minimal-offline', 'minimal-deactivated']) {
      const res = await get(`/api/servers/${ids[key] ?? ''}`, cookie);
      expect({ key, status: res.statusCode }).toEqual({ key, status: 200 });
      const snap = res.json<{ snapshot: Record<string, unknown> }>().snapshot;
      expect(snap.loadAverage).toEqual([0.5, 0.4, 0.3]);
      // Never invented: no zero memory, no zero uptime, no fake CPU count.
      for (const k of ['memory', 'uptimeSeconds', 'cpuCount']) expect(snap[k] ?? null).toBeNull();
    }
    const legacy = (await get(`/api/servers/${ids['legacy-online'] ?? ''}`, cookie)).json<{ snapshot: Record<string, unknown> }>().snapshot;
    expect(legacy).toMatchObject({ uptimeSeconds: 3600, cpuCount: 2, memory: { totalBytes: 1000, freeBytes: 10 } });
    expect((await get(`/api/servers/${ids['never-connected'] ?? ''}`, cookie)).json<{ snapshot: unknown }>().snapshot).toBeNull();
  });

  it('dashboard answers 200: minimal rows have load and unknown (null) memory/uptime/CPU count — not zero', async () => {
    const { cookie } = await login('viewer');
    const res = await get('/api/dashboard', cookie);
    expect(res.statusCode).toBe(200);
    const items = res.json<{ serverList: { items: { name: string; metrics: Record<string, unknown> | null }[] } }>().serverList.items;
    const by = Object.fromEntries(items.map((i) => [i.name, i.metrics]));
    expect(by['new-agent-online']).toMatchObject({ loadAverage: [0.5, 0.4, 0.3], uptimeSeconds: null, cpuCount: null, memory: null });
    expect(by['old-agent-online']).toMatchObject({ memory: null });
    expect(by['minimal-offline']).toBeNull(); // offline: no metrics at all
    expect(by['legacy-online']).toMatchObject({ uptimeSeconds: 3600, cpuCount: 2, memory: { totalBytes: 1000, usedBytes: 990, usedPercent: 99 } });
  });

  it('alerts evaluation does not throw; server_memory never opens (even for a legacy 99 % row); no recovery for the retired incident', async () => {
    const store = createPgAlertsStore(db);
    const d = ALERTS_DEFAULTS.defaults;
    const cfg: EvaluationConfig = { thresholds: d.thresholds, cooldownSeconds: d.cooldownSeconds, reminderSeconds: 0, queueMax: d.queueMax, deliveryEnabled: true, generation: 1, rulesRevision: 1 };
    for (let i = 0; i < 4; i++) {
      await expect(store.evaluateOnce(cfg)).resolves.toMatchObject({ skipped: false });
      await sql("UPDATE server_heartbeats SET received_at = received_at + interval '1 second' WHERE received_at > now() - interval '1 minute'");
      await sql("UPDATE server_inventories SET reported_at = reported_at + interval '1 second', inventory_collected_at = inventory_collected_at + interval '1 second'");
    }
    expect((await sql("SELECT count(*)::int AS n FROM alert_incidents WHERE rule = 'server_memory' AND status = 'firing'")).rows[0]).toEqual({ n: 0 });
    expect((await sql("SELECT count(*)::int AS n FROM alert_conditions WHERE rule = 'server_memory'")).rows[0]).toEqual({ n: 0 });
    expect((await sql("SELECT count(*)::int AS n FROM alert_outbox WHERE incident_id = $1 AND kind <> 'firing'", [ids.retired])).rows[0]).toEqual({ n: 0 });
    expect((await sql("SELECT status, resolution FROM alert_incidents WHERE id = $1", [ids.retired])).rows[0]).toEqual({ status: 'resolved', resolution: 'retired' });
    // Process and availability rules still work: the errored process and the offline server are reported.
    const open = (await sql("SELECT rule FROM alert_incidents WHERE status = 'firing' ORDER BY rule")).rows.map((r) => (r as { rule: string }).rule);
    expect(open).toEqual(expect.arrayContaining(['process_down', 'server_offline']));
  });

  it('incident history lists the retired incident (200), with its resolution as stored', async () => {
    const { cookie } = await login('viewer');
    const res = await get('/api/alerts?state=resolved', cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { id: string; rule: string; resolution: string }[] }>().items.find((i) => i.id === ids.retired)).toMatchObject({ rule: 'server_memory', resolution: 'retired' });
  });

  it('authorization is unchanged: anonymous reads are 401', async () => {
    for (const url of [`/api/servers/${ids['new-agent-online'] ?? ''}`, '/api/dashboard', '/api/alerts?state=resolved']) expect((await get(url)).statusCode).toBe(401);
  });
});

describe('heartbeat on the rollback target: both Agent generations are accepted, nothing else', () => {
  let token = '';
  let serverId = '';
  beforeAll(async () => {
    const a = await login('admin');
    const h = { cookie: a.cookie, origin: ORIGIN, 'x-csrf-token': a.csrf };
    serverId = (await app.inject({ method: 'POST', url: '/api/servers', headers: h, payload: { name: `hb-${randomUUID().slice(0, 6)}` } })).json<{ id: string }>().id;
    token = (await app.inject({ method: 'POST', url: `/api/servers/${serverId}/agent-credentials`, headers: h })).json<{ token: string }>().token;
  });
  const beat = (payload: unknown, auth = token) => app.inject({ method: 'POST', url: '/api/agent/heartbeat', headers: { authorization: `Bearer ${auth}` }, payload: payload as object });
  const stored = async () => (await sql('SELECT snapshot FROM server_heartbeats WHERE server_id = $1', [serverId])).rows[0] as { snapshot: Record<string, unknown> } | undefined;

  it('Agent 0.5.0 (minimal) and Agent 0.4.x (full) heartbeats are both accepted and stored as sent', async () => {
    expect((await beat(minimal('0.5.0'))).statusCode).toBe(200);
    expect(Object.keys((await stored())?.snapshot ?? {}).sort()).toEqual(['agentVersion', 'arch', 'hostname', 'loadAverage', 'platform']);
    expect((await beat(legacyFull)).statusCode).toBe(200);
    expect((await stored())?.snapshot).toMatchObject({ uptimeSeconds: 3600, memory: { totalBytes: 1000, freeBytes: 10 } });
  });

  it.each([
    ['unknown field', { ...minimal('0.5.0'), diskBytes: 1 }],
    ['missing load average', { ...minimal('0.5.0'), loadAverage: undefined }],
    ['negative load', minimal('0.5.0', [-1, 0, 0])],
    ['legacy memory free > total', { ...legacyFull, memory: { totalBytes: 1, freeBytes: 2 } }],
    ['legacy memory with an extra key', { ...legacyFull, memory: { totalBytes: 2, freeBytes: 1, x: 1 } }],
    ['legacy wrong type', { ...legacyFull, cpuCount: 'two' }],
  ])('rejects %s (400)', async (_n, payload) => {
    expect((await beat(payload)).statusCode).toBe(400);
  });

  it('a heartbeat without a valid credential is 401', async () => {
    expect((await beat(minimal('0.5.0'), `ncag_${'x'.repeat(43)}`)).statusCode).toBe(401);
  });
});
