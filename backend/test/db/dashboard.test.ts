// Real PostgreSQL tests for the dashboard aggregate (Task 012, ADR-020) — ONLY the isolated test DB, per-run schema.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { createPgDashboardStore, DASHBOARD_LIMITS, type DashboardStore } from '../../src/servers/dashboard-store.js';
import type { ServerSnapshot } from '../../src/servers/snapshot.js';
import { legacySnapshot, validSnapshot } from '../support/fake-server-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const noLog = { error: () => undefined };
let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];
const closers: (() => Promise<void>)[] = [];

beforeAll(async () => { config = testDbConfig(readTestDbEnv()); admin = await connectTestClient(config); });
afterAll(async () => {
  for (const c of closers) await c();
  for (const s of schemas) await dropRunSchema(admin, s);
  await admin.end();
});

interface Ctx { db: Database; store: DashboardStore; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult> }
async function setup(): Promise<Ctx> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  const db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  closers.push(() => db.close());
  const raw = await connectTestClient(config);
  await raw.query(`SET search_path TO "${schema}"`);
  closers.push(() => raw.end());
  return { db, store: createPgDashboardStore(db), sql: (q, v = []) => raw.query(q, v) };
}

/** A server; `seen`: seconds since the last heartbeat (null = never); `inv`: inventory state + collection age. */
async function server(ctx: Ctx, name: string, o: {
  active?: boolean; seen?: number | null; snapshot?: object;
  inv?: { state: 'ok' | 'stale' | 'unavailable'; collectedAgo: number | null } | null; procs?: string[];
} = {}) {
  const { rows } = await ctx.sql('INSERT INTO servers (name, is_active) VALUES ($1, $2) RETURNING id', [name, o.active ?? true]);
  const id = (rows[0] as { id: string }).id;
  if (o.seen !== null && o.seen !== undefined) {
    await ctx.sql("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - make_interval(secs => $2), $3::jsonb)",
      [id, o.seen, JSON.stringify(o.snapshot ?? validSnapshot())]);
  }
  if (o.inv) {
    const collected = o.inv.collectedAgo;
    await ctx.sql(
      `INSERT INTO server_inventories (server_id, source, state, reason, reported_at, report_captured_at, inventory_captured_at, inventory_collected_at, process_count)
       VALUES ($1, 'pm2', $2, $3, now(), now(), CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(secs => $4::int) END,
               CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(secs => $4::int) END, CASE WHEN $4::int IS NULL THEN NULL ELSE $5::int END)`,
      [id, o.inv.state, o.inv.state === 'unavailable' ? 'snapshot_missing' : null, collected, (o.procs ?? []).length]);
    for (const [i, status] of (o.procs ?? []).entries()) {
      await ctx.sql(
        "INSERT INTO server_applications (server_id, source, pm_id, name, status, restarts, uptime_seconds, first_seen_at) VALUES ($1, 'pm2', $2, $3, $4, $5, 60, now())",
        [id, i, `${name}-app-${String(i)}`, status, i]);
    }
  }
  return id;
}
const current = (procs: string[] = []) => ({ seen: 5, inv: { state: 'ok' as const, collectedAgo: 10 }, procs });

describe('dashboard aggregate (real SQL)', () => {
  it('empty system: exact zeros, empty lists, no invented state', async () => {
    const ctx = await setup();
    const d = await ctx.store.dashboard({ actionsFor: null, scope: null });
    expect(d.servers).toEqual({ total: 0, inactive: 0, active: 0, online: 0, offline: 0, neverConnected: 0 });
    expect(d.inventory).toEqual({ current: 0, stale: 0, unavailable: 0, notReported: 0 });
    expect(d.processes).toEqual({ live: { total: 0, online: 0, problem: 0, transitional: 0 }, notLive: 0 });
    for (const l of [d.attentionServers, d.attentionProcesses, d.serverList]) expect(l).toMatchObject({ items: [], total: 0 });
    expect(d.recentActions).toBeNull();
    expect(Math.abs(Date.parse(d.generatedAt) - Date.now())).toBeLessThan(60_000);
  });

  it('statuses, inventory states, live vs not-live processes, inactive excluded, no JOIN multiplication', async () => {
    const ctx = await setup();
    await server(ctx, 'a-live', current(['online', 'online', 'errored', 'stopped', 'launching', 'unknown', 'waiting restart', 'one-launch-status']));
    // Offline server whose inventory is still "fresh" (collected 60 s ago): its online process is NOT live.
    await server(ctx, 'b-offline', { seen: 600, inv: { state: 'ok', collectedAgo: 60 }, procs: ['online', 'errored'] });
    await server(ctx, 'c-never', { seen: null });
    await server(ctx, 'd-inactive', { active: false, ...current(['online', 'errored']) });
    await server(ctx, 'e-stale', { seen: 5, inv: { state: 'ok', collectedAgo: 600 }, procs: ['online'] });
    await server(ctx, 'f-unavailable', { seen: 5, inv: { state: 'unavailable', collectedAgo: null } });
    await server(ctx, 'g-not-reported', { seen: 5, snapshot: legacySnapshot({ memory: { totalBytes: 0, freeBytes: 0 } }) as unknown as ServerSnapshot });
    await server(ctx, 'h-exporter-stale', { seen: 5, inv: { state: 'stale', collectedAgo: 10 }, procs: ['errored'] });
    const d = await ctx.store.dashboard({ actionsFor: null, scope: null });
    expect(d.servers).toEqual({ total: 8, inactive: 1, active: 7, online: 5, offline: 1, neverConnected: 1 });
    // b-offline's inventory row is still within 180 s → counted "current" as inventory, but its processes are not live.
    expect(d.inventory).toEqual({ current: 2, stale: 2, unavailable: 1, notReported: 2 });
    expect(d.processes).toEqual({ live: { total: 8, online: 2, problem: 4, transitional: 2 }, notLive: 4 });
    expect(d.attentionServers.items.map((s) => [s.name, s.reason])).toEqual([
      ['b-offline', 'offline'], ['c-never', 'never_connected'], ['f-unavailable', 'inventory_unavailable'],
      ['e-stale', 'inventory_stale'], ['h-exporter-stale', 'inventory_stale'], ['g-not-reported', 'inventory_not_reported'],
    ]);
    expect(d.attentionServers.total).toBe(6);
    // Only live problem processes, priority errored → waiting restart → unknown → stopped.
    expect(d.attentionProcesses.items.map((p) => [p.serverName, p.status])).toEqual([
      ['a-live', 'errored'], ['a-live', 'waiting restart'], ['a-live', 'unknown'], ['a-live', 'stopped'],
    ]);
    const list = Object.fromEntries(d.serverList.items.map((s) => [s.name, s]));
    expect(Object.keys(list)).toEqual(['a-live', 'b-offline', 'c-never', 'e-stale', 'f-unavailable', 'g-not-reported', 'h-exporter-stale']);
    expect(list['a-live']).toMatchObject({ status: 'online', processes: { total: 8, online: 2, problem: 4 } });
    expect(list['a-live']?.metrics).toEqual({ hostname: 'node-1.example', loadAverage: [0.5, 0.4, 0.3] }); // only load + identification
    expect(list['b-offline']).toMatchObject({ status: 'offline', metrics: null, processes: null });
    expect(list['b-offline']?.lastSeenAt).not.toBeNull();
    expect(list['c-never']).toMatchObject({ status: 'never_connected', metrics: null, lastSeenAt: null, inventory: { state: 'not_reported' } });
    // A row written by a 0.4.x Agent (legacy memory/uptime/cpuCount in JSONB) is read through the current contract.
    expect(list['g-not-reported']?.metrics).toEqual({ hostname: 'node-1.example', loadAverage: [0.5, 0.4, 0.3] });
    expect(list['e-stale']).toMatchObject({ inventory: { state: 'stale' }, processes: null });
  });

  it('freshness boundaries share one reference time (89 s online, 95 s offline; 175 s current, 185 s stale)', async () => {
    const ctx = await setup();
    await server(ctx, 'edge-online', { seen: 85, inv: { state: 'ok', collectedAgo: 175 }, procs: ['online'] });
    await server(ctx, 'edge-offline', { seen: 95, inv: { state: 'ok', collectedAgo: 185 }, procs: ['online'] });
    const d = await ctx.store.dashboard({ actionsFor: null, scope: null });
    expect(d.servers).toMatchObject({ online: 1, offline: 1 });
    expect(d.inventory).toMatchObject({ current: 1, stale: 1 });
    expect(d.processes.live.total).toBe(1);
  });

  it('more rows than the list limits: exact totals, bounded lists, deterministic order', async () => {
    const ctx = await setup();
    for (let i = 0; i < 60; i++) await server(ctx, `n-${String(i).padStart(2, '0')}`, { seen: 600 });
    await server(ctx, 'z-live', current(Array.from({ length: 30 }, () => 'errored')));
    const d = await ctx.store.dashboard({ actionsFor: null, scope: null });
    expect(d.servers).toMatchObject({ active: 61, offline: 60, online: 1 });
    expect(d.attentionServers).toMatchObject({ total: 60, limit: DASHBOARD_LIMITS.attentionServers });
    expect(d.attentionServers.items).toHaveLength(DASHBOARD_LIMITS.attentionServers);
    expect(d.attentionServers.items[0]?.name).toBe('n-00');
    expect(d.serverList).toMatchObject({ total: 61, limit: DASHBOARD_LIMITS.serverList });
    expect(d.serverList.items).toHaveLength(DASHBOARD_LIMITS.serverList);
    expect(d.attentionProcesses).toMatchObject({ total: 30 });
    expect(d.attentionProcesses.items).toHaveLength(DASHBOARD_LIMITS.attentionProcesses);
    const again = await ctx.store.dashboard({ actionsFor: null, scope: null }); // deterministic order (status, server, name, pm_id)
    expect(again.attentionProcesses.items).toEqual(d.attentionProcesses.items);
    expect(again.serverList.items.map((x) => x.name)).toEqual(d.serverList.items.map((x) => x.name));
    expect(d.processes.live).toMatchObject({ total: 30, problem: 30 });
  });

  it('recent actions: only when asked, bounded, requestedByMe, overdue pending is flagged — and GET writes nothing', async () => {
    const ctx = await setup();
    const sid = await server(ctx, 'cmd', current(['online']));
    const users = await Promise.all(['a', 'b'].map(async (n) => ((await ctx.sql("INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'operator') RETURNING id", [`${n}@example.test`])).rows[0] as { id: string }).id));
    const me = users[0] ?? '';
    const other = users[1] ?? '';
    for (let i = 0; i < 12; i++) {
      await ctx.sql(
        `INSERT INTO control_commands (server_id, target_key, action, status, reason, requested_by, idempotency_key, requested_at, deadline_at, completed_at)
         VALUES ($1, 'api', 'restart', 'succeeded', NULL, $2, $3, now() - make_interval(secs => $4), now() - make_interval(secs => $4) + interval '2 minutes', now())`,
        [sid, i % 2 ? me : other, randomUUID(), 1000 + i]);
    }
    await ctx.sql(
      `INSERT INTO control_commands (server_id, target_key, action, status, requested_by, idempotency_key, requested_at, deadline_at)
       VALUES ($1, 'web', 'stop', 'queued', $2, $3, now() - interval '10 minutes', now() - interval '8 minutes')`, [sid, me, randomUUID()]);
    const before: unknown = (await ctx.sql('SELECT md5(string_agg(c::text, \',\' ORDER BY id)) AS h FROM control_commands c')).rows[0];
    const sessionsBefore: unknown = (await ctx.sql('SELECT count(*) FROM sessions')).rows[0];
    expect((await ctx.store.dashboard({ actionsFor: null, scope: null })).recentActions).toBeNull();
    const d = await ctx.store.dashboard({ actionsFor: me, scope: null });
    expect(d.recentActions?.items).toHaveLength(DASHBOARD_LIMITS.recentActions);
    expect(d.recentActions?.items[0]).toMatchObject({ targetKey: 'web', action: 'stop', status: 'queued', overdue: true, requestedByMe: true, serverName: 'cmd', completedAt: null });
    expect(d.recentActions?.items.slice(1).every((a) => !a.overdue && a.status === 'succeeded')).toBe(true);
    expect(new Set(d.recentActions?.items.map((a) => a.requestedByMe))).toEqual(new Set([true, false]));
    expect(JSON.stringify(d.recentActions)).not.toMatch(new RegExp(`${me}|${other}|@example`));
    // Read-only: the overdue command is NOT expired by the GET, nothing else changes.
    expect((await ctx.sql('SELECT md5(string_agg(c::text, \',\' ORDER BY id)) AS h FROM control_commands c')).rows[0]).toEqual(before);
    expect((await ctx.sql('SELECT count(*) FROM sessions')).rows[0]).toEqual(sessionsBefore);
  });

  it('the read transaction is READ ONLY (a write inside it would fail) and returns a consistent snapshot', async () => {
    const ctx = await setup();
    await server(ctx, 'x', current(['online']));
    const [d1, d2] = await Promise.all([ctx.store.dashboard({ actionsFor: null, scope: null }), ctx.store.dashboard({ actionsFor: null, scope: null })]);
    expect(d1.servers).toEqual(d2.servers);
    await expect(ctx.db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await tx.query("INSERT INTO servers (name) VALUES ('nope')");
    })).rejects.toMatchObject({ code: '25006' });
  });
});
