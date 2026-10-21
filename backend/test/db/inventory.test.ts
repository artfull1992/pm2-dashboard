// Real PostgreSQL tests for the read-only PM2 inventory (Task 008, ADR-016) — ONLY the isolated test DB, per-run schema.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { agentTokenDigest, newAgentToken } from '../../src/auth/tokens.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { decodeCursor, type InventoryProcess, type InventoryReport } from '../../src/servers/inventory.js';
import { createPgInventoryStore, type InventoryStore } from '../../src/servers/inventory-store.js';
import { createPgServerStore, type ServerStore } from '../../src/servers/store.js';
import { validSnapshot } from '../support/fake-server-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];
const databases: Database[] = [];

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
});
afterAll(async () => {
  await Promise.all(databases.map((d) => d.close()));
  for (const schema of schemas) await dropRunSchema(admin, schema);
  await admin.end();
});

interface Ctx {
  schema: string; servers: ServerStore; inventory: InventoryStore; actor: { actorUserId: string; requestId: string };
  sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult>;
}

async function setup(): Promise<Ctx> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  const db = createDatabase({ ...config, poolMax: 10 }, { error: () => undefined }, createPool({ ...config, poolMax: 10 }, { searchPath: schema }));
  databases.push(db);
  const boot = await bootstrapAdmin(db, { email: 'admin@example.test', passwordHash: 'scrypt$placeholder' });
  if (boot.status !== 'created') throw new Error('bootstrap failed');
  const sql = async (q: string, v: unknown[] = []) => {
    await admin.query(`SET search_path TO "${schema}"`);
    try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
  };
  return { schema, servers: createPgServerStore(db), inventory: createPgInventoryStore(db), actor: { actorUserId: boot.userId, requestId: '00000000-0000-4000-8000-000000000000' }, sql };
}

async function node(ctx: Ctx, name: string) {
  const created = await ctx.servers.create({ name, ...ctx.actor });
  if (created === 'name_taken') throw new Error('unexpected');
  const token = newAgentToken();
  await ctx.servers.issueCredential({ serverId: created.id, tokenHash: agentTokenDigest(token), ...ctx.actor });
  await ctx.servers.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot() });
  return { serverId: created.id, tokenHash: agentTokenDigest(token) };
}

const proc = (pmId: number, overrides: Partial<InventoryProcess> = {}): InventoryProcess => ({
  pmId, name: `app-${String(pmId)}`, status: 'online', uptimeSeconds: 60, restarts: 1, cpuPercent: 2.5, memoryBytes: 2 ** 40, execMode: 'cluster', ...overrides,
});
const at = (s: number) => new Date(Date.parse('2026-10-13T12:00:00.000Z') + s * 1000).toISOString();
const ok = (processes: InventoryProcess[], t = 0, source = 'pm2'): InventoryReport => ({ version: 1, state: 'ok', reason: null, source, capturedAt: at(t), processes });
const unavailable = (reason: 'daemon_not_running' | 'snapshot_missing', t: number | null): InventoryReport =>
  ({ version: 1, state: 'unavailable', reason, source: t === null ? null : 'pm2', capturedAt: t === null ? null : at(t), processes: [] });
const stale = (t: number): InventoryReport => ({ version: 1, state: 'stale', reason: null, source: 'pm2', capturedAt: at(t), processes: [] });

describe('schema (migration 1791900000003)', () => {
  it('constraints reject invalid rows; the index serves the global ordering', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0)]) });
    const bad: [string, unknown[]][] = [
      [`UPDATE server_applications SET name = 'a' || chr(27) WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_applications SET status = 'hacked' WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_applications SET memory_bytes = -1 WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_applications SET cpu_percent = 10001 WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_applications SET source = 'Bad Source' WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_inventories SET state = 'unavailable', reason = NULL WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_inventories SET process_count = 501 WHERE server_id = $1`, [n.serverId]],
      [`UPDATE server_inventories SET inventory_collected_at = NULL WHERE server_id = $1`, [n.serverId]],
    ];
    for (const [q, v] of bad) await expect(ctx.sql(q, v)).rejects.toMatchObject({ code: '23514' });
    await expect(ctx.sql(`INSERT INTO server_applications (server_id, source, pm_id, name, status, first_seen_at) VALUES (gen_random_uuid(), 'pm2', 1, 'x', 'online', now())`)).rejects.toMatchObject({ code: '23503' });
    const { rows } = await admin.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'server_applications_name_idx'`, [ctx.schema]);
    expect((rows[0] as { indexdef: string }).indexdef).toMatch(/\(name, server_id, pm_id\)/);
  });
});

describe('reconciliation', () => {
  it('a successful snapshot replaces the set: updates, deletes missing, keeps first_seen for the same app', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0), proc(1), proc(2)], 0) });
    const before = await ctx.inventory.serverApplications(n.serverId, null);
    expect(before?.items.map((i) => i.pmId)).toEqual([0, 1, 2]);
    expect(before?.inventory).toMatchObject({ state: 'current', processCount: 3, source: 'pm2', capturedAt: at(0) });
    const firstSeen = before?.items[0]?.firstSeenAt;
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0, { status: 'stopped', cpuPercent: null, memoryBytes: null }), proc(2)], 30) });
    const after = await ctx.inventory.serverApplications(n.serverId, null);
    expect(after?.items.map((i) => [i.pmId, i.status, i.cpuPercent, i.memoryBytes])).toEqual([[0, 'stopped', null, null], [2, 'online', 2.5, 2 ** 40]]);
    expect(after?.items[0]?.firstSeenAt).toBe(firstSeen);
    expect(after?.inventory.processCount).toBe(2);
  });

  it('pm_id reused with another name is a new application (first_seen resets)', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0, { name: 'old' })], 0) });
    const first = (await ctx.inventory.serverApplications(n.serverId, null))?.items[0]?.firstSeenAt;
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0, { name: 'new' })], 30) });
    const item = (await ctx.inventory.serverApplications(n.serverId, null))?.items[0];
    expect(item?.name).toBe('new');
    expect(item && first && Date.parse(item.firstSeenAt) > Date.parse(first)).toBe(true);
  });

  it('an empty successful inventory means zero processes; unavailable does NOT mean zero', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0), proc(1)], 0) });
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: unavailable('daemon_not_running', 30) });
    const down = await ctx.inventory.serverApplications(n.serverId, null);
    expect(down?.inventory).toMatchObject({ state: 'unavailable', reason: 'daemon_not_running', processCount: 2, capturedAt: at(0) });
    expect(down?.items.map((i) => [i.pmId, i.inventoryState])).toEqual([[0, 'unavailable'], [1, 'unavailable']]);
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([], 60) });
    const empty = await ctx.inventory.serverApplications(n.serverId, null);
    expect(empty?.inventory).toMatchObject({ state: 'current', processCount: 0 });
    expect(empty?.items).toEqual([]);
  });

  it('stale keeps the last processes as stale; a missing snapshot file keeps the data too', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0)], 0) });
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: stale(0) });
    expect((await ctx.inventory.serverApplications(n.serverId, null))?.inventory).toMatchObject({ state: 'stale', processCount: 1 });
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: unavailable('snapshot_missing', null) });
    const r = await ctx.inventory.serverApplications(n.serverId, null);
    expect(r?.inventory).toMatchObject({ state: 'unavailable', reason: 'snapshot_missing', source: 'pm2' });
    expect(r?.items).toHaveLength(1);
  });

  it('a source change replaces the previous source’s processes (no orphans)', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0), proc(1)], 0, 'pm2') });
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0)], 30, 'pm2-deploy') });
    const { rows } = await ctx.sql('SELECT source, pm_id FROM server_applications WHERE server_id = $1', [n.serverId]);
    expect(rows).toEqual([{ source: 'pm2-deploy', pm_id: 0 }]);
  });
});

describe('ordering and freshness', () => {
  it('an older snapshot never overwrites a newer one; the same snapshot does not bump freshness', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    expect(await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0, { name: 'newer' })], 60) })).toMatchObject({ status: 'accepted' });
    expect(await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0, { name: 'older' })], 0) })).toMatchObject({ status: 'ignored' });
    expect(await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: unavailable('daemon_not_running', 30) })).toMatchObject({ status: 'ignored' });
    const first = await ctx.inventory.serverApplications(n.serverId, null);
    expect(first?.items[0]?.name).toBe('newer');
    expect(first?.inventory.state).toBe('current');
    const collected = first?.inventory.collectedAt;
    await new Promise((r) => setTimeout(r, 20));
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0, { name: 'newer' })], 60) });
    const again = await ctx.inventory.serverApplications(n.serverId, null);
    expect(again?.inventory.collectedAt).toBe(collected);
    expect(Date.parse(again?.inventory.reportedAt ?? '')).toBeGreaterThan(Date.parse(collected ?? ''));
  });

  it('data older than the freshness window (server clock) is stale even if the last report said ok', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0)], 0) });
    await ctx.sql(`UPDATE server_inventories SET inventory_collected_at = now() - interval '181 seconds' WHERE server_id = $1`, [n.serverId]);
    expect((await ctx.inventory.serverApplications(n.serverId, null))?.inventory.state).toBe('stale');
    await ctx.sql(`UPDATE server_heartbeats SET received_at = now() - interval '10 minutes' WHERE server_id = $1`, [n.serverId]);
    const list = await ctx.inventory.listApplications({ limit: 10, cursor: null, serverId: n.serverId, status: null, scope: null });
    expect(list.items[0]).toMatchObject({ inventoryState: 'stale', serverStatus: 'offline' });
  });

  it('concurrent reports: the newest capture wins regardless of commit order', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    const reports = Array.from({ length: 12 }, (_, i) => ok([proc(0, { restarts: i })], i * 10));
    await Promise.all(reports.reverse().map((report) => ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report })));
    const r = await ctx.inventory.serverApplications(n.serverId, null);
    expect(r?.items[0]?.restarts).toBe(11);
    expect(r?.inventory.capturedAt).toBe(at(110));
  });

  it('revoked credential / inactive server → unauthorized, nothing written', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.servers.revokeCredential({ serverId: n.serverId, ...ctx.actor });
    expect(await ctx.inventory.recordInventory({ tokenHash: n.tokenHash, report: ok([proc(0)]) })).toBe('unauthorized');
    const m = await node(ctx, 'm');
    await ctx.sql('UPDATE servers SET is_active = false WHERE id = $1', [m.serverId]);
    expect(await ctx.inventory.recordInventory({ tokenHash: m.tokenHash, report: ok([proc(0)]) })).toBe('unauthorized');
    const { rows } = await ctx.sql('SELECT count(*)::int AS n FROM server_inventories');
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe('browser queries', () => {
  it('keyset pagination over all servers, filters by server and status; never reported → not_reported', async () => {
    const ctx = await setup();
    const a = await node(ctx, 'alpha');
    const b = await node(ctx, 'beta');
    const c = await node(ctx, 'gamma');
    await ctx.inventory.recordInventory({ tokenHash: a.tokenHash, report: ok([proc(0, { name: 'api' }), proc(1, { name: 'worker', status: 'errored' }), proc(2, { name: 'cron' })]) });
    await ctx.inventory.recordInventory({ tokenHash: b.tokenHash, report: ok([proc(0, { name: 'api' }), proc(5, { name: 'zeta' })]) });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<InventoryStore['listApplications']>> = await ctx.inventory.listApplications({ limit: 2, cursor: cursor ? decodeCursor(cursor) : null, serverId: null, status: null, scope: null });
      seen.push(...page.items.map((i) => `${i.name}@${i.serverName}`));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(expect.arrayContaining(['api@alpha', 'api@beta', 'cron@alpha', 'worker@alpha', 'zeta@beta']));
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
    expect((await ctx.inventory.listApplications({ limit: 50, cursor: null, serverId: b.serverId, status: null, scope: null })).items.map((i) => i.name)).toEqual(['api', 'zeta']);
    expect((await ctx.inventory.listApplications({ limit: 50, cursor: null, serverId: null, status: 'errored', scope: null })).items.map((i) => i.name)).toEqual(['worker']);
    expect((await ctx.inventory.serverApplications(c.serverId, null))?.inventory).toEqual({
      state: 'not_reported', reason: null, source: null, capturedAt: null, collectedAt: null, reportedAt: null, processCount: null,
    });
    expect(await ctx.inventory.serverApplications('11111111-1111-4111-8111-111111111111', null)).toBeNull();
  });
});
