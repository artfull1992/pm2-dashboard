// Real PostgreSQL tests for role + resource access (ADR-028) — ONLY the isolated test DB, per-run schema.
// Matrix: three roles, two servers, several services; every scoped query path is exercised in SQL (filtered before
// LIMIT/count), grants administration (atomic, revision, validation, audit), command authorisation under locks.
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAccessStore } from '../../src/auth/access-store.js';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { createAccessChecker, type Scope } from '../../src/auth/scope.js';
import { agentTokenDigest, newAgentToken } from '../../src/auth/tokens.js';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { type ControlTarget, type PollReport } from '../../src/servers/control.js';
import { createPgControlStore } from '../../src/servers/control-store.js';
import { createPgDashboardStore } from '../../src/servers/dashboard-store.js';
import { createPgInventoryStore } from '../../src/servers/inventory-store.js';
import { createPgServerStore } from '../../src/servers/store.js';
import { validSnapshot } from '../support/fake-server-store.js';
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

async function setup() {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  const db: Database = createDatabase({ ...config, poolMax: 10 }, noLog, createPool({ ...config, poolMax: 10 }, { searchPath: schema }));
  closers.push(() => db.close());
  const raw = await connectTestClient(config);
  await raw.query(`SET search_path TO "${schema}"`);
  closers.push(() => raw.end());
  const sql = (q: string, v: unknown[] = []) => raw.query(q, v);
  const boot = await bootstrapAdmin(db, { email: 'admin@example.test', passwordHash: 'scrypt$placeholder' });
  if (boot.status !== 'created') throw new Error('bootstrap failed');
  const adminSession = (await sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`, [boot.userId, randomBytes(32)])).rows[0] as { id: string };
  const user = async (email: string, role: string) => ((await sql(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'scrypt$placeholder', $2) RETURNING id`, [email, role])).rows[0] as { id: string }).id;
  const servers = createPgServerStore(db);
  const server = async (name: string) => {
    const created = await servers.create({ name, actorUserId: boot.userId, requestId: randomUUID() });
    if (created === 'name_taken') throw new Error('unexpected');
    const token = newAgentToken();
    const tokenHash = agentTokenDigest(token);
    await servers.issueCredential({ serverId: created.id, tokenHash, actorUserId: boot.userId, requestId: randomUUID() });
    await servers.recordHeartbeat({ tokenHash, snapshot: validSnapshot() });
    return { id: created.id, tokenHash };
  };
  /** Current inventory: (pm_id, name, status) rows of one server, as a fresh successful collection. */
  const inventory = async (serverId: string, apps: [number, string, string][]) => {
    await sql(`INSERT INTO server_inventories (server_id, source, state, reported_at, inventory_captured_at, inventory_collected_at, process_count)
               VALUES ($1, 'pm2', 'ok', now(), now(), now(), $2)
               ON CONFLICT (server_id) DO UPDATE SET process_count = EXCLUDED.process_count, inventory_collected_at = now()`, [serverId, apps.length]);
    await sql('DELETE FROM server_applications WHERE server_id = $1', [serverId]);
    for (const [pmId, name, status] of apps) {
      await sql(`INSERT INTO server_applications (server_id, source, pm_id, name, status, first_seen_at) VALUES ($1, 'pm2', $2, $3, $4, now())`, [serverId, pmId, name, status]);
    }
  };
  const grant = (userId: string, serverId: string, mode: 'all' | 'selected', services: string[] = []) => sql(
    `WITH g AS (INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, $3) RETURNING user_id, server_id)
     INSERT INTO user_service_access (user_id, server_id, service_name) SELECT g.user_id, g.server_id, n FROM g, unnest($4::text[]) n`,
    [userId, serverId, mode, services]);
  return {
    db, sql, adminId: boot.userId, actor: { userId: boot.userId, sessionId: adminSession.id }, user, server, inventory, grant, servers,
    inventoryStore: createPgInventoryStore(db), control: createPgControlStore(db), dashboard: createPgDashboardStore(db),
    alerts: createPgAlertsStore(db), access: createPgAccessStore(db), checker: createAccessChecker(db),
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Two servers, five services; operator/viewer with every kind of grant. */
async function world() {
  const ctx = await setup();
  const a = await ctx.server('alpha');
  const b = await ctx.server('beta');
  await ctx.inventory(a.id, [[0, 'api', 'online'], [1, 'worker', 'errored'], [2, 'db', 'online']]);
  await ctx.inventory(b.id, [[0, 'web', 'online'], [1, 'api', 'stopped']]);
  const none = await ctx.user('none@example.test', 'operator');
  const allA = await ctx.user('all-a@example.test', 'operator');
  const selA = await ctx.user('sel-a@example.test', 'operator');
  const multi = await ctx.user('multi@example.test', 'viewer');
  await ctx.grant(allA, a.id, 'all');
  await ctx.grant(selA, a.id, 'selected', ['api']);
  await ctx.grant(multi, a.id, 'selected', ['worker']);
  await ctx.grant(multi, b.id, 'all');
  return { ctx, a, b, none, allA, selA, multi };
}

const names = (items: { serverName: string; name: string }[]) => items.map((i) => `${i.serverName}/${i.name}`).sort();

describe('schema (migration 1791900000009)', () => {
  it('constraints and cascades: mode, service name, selected services need their server grant, deletes cascade', async () => {
    const { ctx, a, none } = await world();
    const bad = [
      [`INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, 'some')`, [none, a.id]],
      [`INSERT INTO user_service_access (user_id, server_id, service_name) VALUES ($1, $2, 'api')`, [none, a.id]], // no server grant
    ] as const;
    for (const [q, v] of bad) {
      const error = await ctx.sql(q, [...v]).then(() => null, (e: unknown) => e as { code?: string });
      expect(error?.code).toMatch(/^23/); // integrity constraint violation
    }
    await ctx.grant(none, a.id, 'selected', ['api']);
    await expect(ctx.sql(`INSERT INTO user_service_access (user_id, server_id, service_name) VALUES ($1, $2, E'a\\nb')`, [none, a.id])).rejects.toMatchObject({ code: '23514' });
    await ctx.sql('DELETE FROM user_server_access WHERE user_id = $1 AND server_id = $2', [none, a.id]);
    expect((await ctx.sql('SELECT count(*)::int AS n FROM user_service_access WHERE user_id = $1', [none])).rows[0]).toEqual({ n: 0 });
  });
});

describe('scope: servers, applications, search, pagination, counters', () => {
  it('admin sees everything; no grant → nothing; all / selected / several servers', async () => {
    const { ctx, a, b, none, allA, selA, multi } = await world();
    const servers = async (scope: Scope) => (await ctx.servers.list({ limit: 50, afterId: null, scope })).items.map((s) => s.name);
    expect(await servers(null)).toEqual(['alpha', 'beta']);
    expect(await servers(none)).toEqual([]);
    expect(await servers(allA)).toEqual(['alpha']);
    expect(await servers(selA)).toEqual(['alpha']);
    expect(await servers(multi)).toEqual(['alpha', 'beta']);
    expect(await ctx.servers.get(b.id, selA)).toBeNull(); // direct URL of a hidden server
    expect(await ctx.servers.get(a.id, selA)).not.toBeNull();

    const apps = async (scope: Scope, extra: { q?: string; serverId?: string } = {}) =>
      names((await ctx.inventoryStore.listApplications({ limit: 100, cursor: null, serverId: extra.serverId ?? null, status: null, q: extra.q ?? null, scope })).items);
    expect(await apps(null)).toEqual(['alpha/api', 'alpha/db', 'alpha/worker', 'beta/api', 'beta/web']);
    expect(await apps(none)).toEqual([]);
    expect(await apps(allA)).toEqual(['alpha/api', 'alpha/db', 'alpha/worker']);
    expect(await apps(selA)).toEqual(['alpha/api']);
    expect(await apps(multi)).toEqual(['alpha/worker', 'beta/api', 'beta/web']);
    // search and server filter never reach hidden services
    expect(await apps(selA, { q: 'work' })).toEqual([]);
    expect(await apps(selA, { serverId: b.id })).toEqual([]);
    expect(await apps(multi, { q: 'api' })).toEqual(['beta/api']);

    // server detail: process count only of visible services (no hint how many are hidden)
    const detail = await ctx.inventoryStore.serverApplications(a.id, selA);
    expect(detail?.items.map((i) => i.name)).toEqual(['api']);
    expect(detail?.inventory.processCount).toBe(1);
    expect((await ctx.inventoryStore.serverApplications(a.id, null))?.inventory.processCount).toBe(3);
    expect(await ctx.inventoryStore.serverApplications(b.id, selA)).toBeNull();
  });

  it('pagination: pages are cut AFTER the scope filter (no gaps, no leaks); cursors of hidden rows position nothing visible', async () => {
    const ctx = await setup();
    const s = await ctx.server('wide');
    const apps: [number, string, string][] = Array.from({ length: 60 }, (_, i) => [i, `svc-${String(i).padStart(2, '0')}`, 'online']);
    await ctx.inventory(s.id, apps);
    const u = await ctx.user('pager@example.test', 'viewer');
    const allowed = apps.filter(([i]) => i % 3 === 0).map(([, n]) => n);
    await ctx.grant(u, s.id, 'selected', allowed);
    const seen: string[] = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const r = await ctx.inventoryStore.listApplications({ limit: 7, cursor, serverId: null, status: null, scope: u });
      seen.push(...r.items.map((i) => i.name));
      if (!r.nextCursor) break;
      const { decodeCursor } = await import('../../src/servers/inventory.js');
      cursor = decodeCursor(r.nextCursor);
    }
    expect(seen).toEqual(allowed);
  });

  it('service identity: pm_id reuse under another name does not inherit; a restart keeps it; a new service on an "all" server appears; a gone one stays granted as unavailable', async () => {
    const { ctx, a, allA, selA } = await world();
    // PM2 reuses pm_id 0 for another process: not the granted "api"
    await ctx.inventory(a.id, [[0, 'intruder', 'online'], [1, 'worker', 'errored'], [2, 'db', 'online'], [3, 'api', 'online']]);
    const vis = async (scope: Scope) => names((await ctx.inventoryStore.listApplications({ limit: 50, cursor: null, serverId: a.id, status: null, scope })).items);
    expect(await vis(selA)).toEqual(['alpha/api']); // api (new pm_id 3) still visible; intruder (pm_id 0) not
    expect(await vis(allA)).toEqual(['alpha/api', 'alpha/db', 'alpha/intruder', 'alpha/worker']); // "all" covers the new service
    await ctx.inventory(a.id, [[1, 'worker', 'errored']]); // api is gone
    expect(await vis(selA)).toEqual([]); // never a wildcard
    const view = await ctx.access.getAccess(selA);
    expect(view?.servers).toEqual([expect.objectContaining({ serverId: a.id, mode: 'selected', services: [{ name: 'api', available: false }] })]);
  });
});

describe('scope: dashboard and alerts aggregates', () => {
  it('totals, attention lists and per-server counts include only visible servers and services', async () => {
    const { ctx, selA, multi, none } = await world();
    const all = await ctx.dashboard.dashboard({ actionsFor: null, scope: null });
    expect(all.servers.total).toBe(2);
    expect(all.processes.live.total).toBe(5);
    const sel = await ctx.dashboard.dashboard({ actionsFor: selA, scope: selA });
    expect(sel.servers.total).toBe(1);
    expect(sel.processes.live).toMatchObject({ total: 1, online: 1, problem: 0 });
    expect(sel.attentionProcesses.items).toEqual([]); // worker (errored) is hidden
    expect(sel.serverList.items.map((s) => [s.name, s.processes?.total])).toEqual([['alpha', 1]]);
    const m = await ctx.dashboard.dashboard({ actionsFor: null, scope: multi });
    expect(m.processes.live.total).toBe(3);
    expect(m.attentionProcesses.items.map((p) => p.name).sort()).toEqual(['api', 'worker']); // beta/api stopped, alpha/worker errored
    const n = await ctx.dashboard.dashboard({ actionsFor: none, scope: none });
    expect([n.servers.total, n.processes.live.total, n.serverList.items.length, n.attentionServers.total]).toEqual([0, 0, 0, 0]);
  });

  it('incidents: server incidents of visible servers, process incidents of visible services; active count and cursors scoped', async () => {
    const { ctx, a, b, selA, multi } = await world();
    const incident = (serverId: string, serverName: string, rule: string, processName: string | null, at: string) => ctx.sql(
      `INSERT INTO alert_incidents (condition_key, server_id, rule, severity, server_name, process_name, pm_id, notify, opened_at, last_observed_at)
       VALUES ($1, $2, $3, 'critical', $4, $5, NULL, false, $6::timestamptz, $6::timestamptz) RETURNING id`,
      [`${serverId}:${rule}:${processName ?? ''}`, serverId, rule, serverName, processName, at]);
    await incident(a.id, 'alpha', 'server_offline', null, '2026-10-21T10:00:00Z');
    await incident(a.id, 'alpha', 'process_down', 'worker', '2026-10-21T10:01:00Z');
    await incident(a.id, 'alpha', 'process_down', 'api', '2026-10-21T10:02:00Z');
    const hidden = (await incident(b.id, 'beta', 'process_down', 'web', '2026-10-21T10:03:00Z')).rows[0] as { id: string };
    const list = async (scope: Scope, before: string | null = null) =>
      (await ctx.alerts.listIncidents({ state: 'active', limit: 50, before, withDelivery: false, scope })).items.map((i) => `${i.serverName}/${i.rule}/${i.processName ?? '-'}`);
    expect(await list(null)).toHaveLength(4);
    expect(await list(selA)).toEqual(['alpha/process_down/api', 'alpha/server_offline/-']);
    expect(await list(multi)).toEqual(['beta/process_down/web', 'alpha/process_down/worker', 'alpha/server_offline/-']);
    expect((await ctx.alerts.summary(false, selA)).active).toBe(2);
    expect((await ctx.alerts.summary(false, null)).active).toBe(4);
    expect(await list(selA, hidden.id)).toEqual([]); // a hidden anchor positions nothing
  });
});

const target = (name: string, over: Partial<ControlTarget> = {}): ControlTarget =>
  ({ targetKey: `n-${name}`, name, pmId: 1, actions: ['start', 'stop', 'restart'], matchStatus: 'ok', identity: 'a'.repeat(16), ...over });
const v2 = (targets: ControlTarget[]): PollReport => ({ version: 2, mode: 'auto', broker: 'ok', daemon: 'ok', allowlist: null, targets });

describe('scope: control targets, commands, history, dispatch', () => {
  it('targets and command history are filtered; hidden service → not_found (also for a replayed idempotency key after revocation)', async () => {
    const { ctx, a, selA, allA } = await world();
    await ctx.control.poll({ tokenHash: a.tokenHash, report: v2([target('api'), target('worker'), target('db')]), controlEnabled: true });
    expect((await ctx.control.controlView(a.id, selA))?.targets.map((t) => t.name)).toEqual(['api']);
    expect((await ctx.control.controlView(a.id, null))?.broker).toMatchObject({ mode: 'auto', protocol: 2, total: 3 });
    await ctx.control.poll({ tokenHash: a.tokenHash, report: { ...v2([target('api'), target('worker'), target('db')]), total: 640 }, controlEnabled: true });
    expect((await ctx.control.controlView(a.id, null))?.broker?.total).toBe(640); // the cut is stored, never silent
    expect((await ctx.control.controlView(a.id, allA))?.targets.map((t) => t.name)).toEqual(['api', 'db', 'worker']);
    const req = (actor: string, name: string, key = randomUUID()) => ctx.control.createCommand({ serverId: a.id, targetKey: `n-${name}`, action: 'restart', idempotencyKey: key, actorUserId: actor, actorRole: 'operator', requestId: randomUUID() });
    expect(await req(selA, 'worker')).toBe('not_found');
    const key = randomUUID();
    const ok = await req(selA, 'api', key);
    if (typeof ok === 'string') throw new Error(ok);
    expect(ok.command).toMatchObject({ serviceName: 'api', status: 'queued' });
    expect((await ctx.sql('SELECT target_identity FROM control_commands WHERE id = $1', [ok.command.id])).rows[0]).toEqual({ target_identity: 'a'.repeat(16) });
    expect((await ctx.control.listCommands(a.id, 20, null, allA))?.map((c) => c.serviceName)).toEqual(['api']);
    const worker = await req(allA, 'worker');
    if (typeof worker === 'string') throw new Error(worker);
    expect((await ctx.control.listCommands(a.id, 20, null, selA))?.map((c) => c.serviceName)).toEqual(['api']);
    expect(await ctx.control.getCommand(worker.command.id, selA)).toBeNull(); // foreign command id
    expect(await ctx.control.getCommand(worker.command.id, allA)).not.toBeNull();
    // revoke: the same idempotency key no longer returns the command
    await ctx.sql('DELETE FROM user_server_access WHERE user_id = $1', [selA]);
    expect(await req(selA, 'api', key)).toBe('not_found');
    expect(await ctx.control.getCommand(ok.command.id, selA)).toBeNull();
    expect(await ctx.control.listCommands(a.id, 20, null, selA)).toBeNull();
  });

  it('a queued command is never dispatched after its author lost the grant / role; identity change of the target is refused', async () => {
    const { ctx, a, selA, allA } = await world();
    const report = v2([target('api'), target('worker')]);
    await ctx.control.poll({ tokenHash: a.tokenHash, report, controlEnabled: true });
    const create = async (actor: string, name: string) => {
      const r = await ctx.control.createCommand({ serverId: a.id, targetKey: `n-${name}`, action: 'restart', idempotencyKey: randomUUID(), actorUserId: actor, actorRole: 'operator', requestId: randomUUID() });
      if (typeof r === 'string') throw new Error(r);
      return r.command.id;
    };
    const c1 = await create(selA, 'api');
    await ctx.sql('DELETE FROM user_service_access WHERE user_id = $1', [selA]);
    await ctx.sql("INSERT INTO user_service_access (user_id, server_id, service_name) VALUES ($1, $2, 'worker')", [selA, a.id]);
    expect(await ctx.control.poll({ tokenHash: a.tokenHash, report, controlEnabled: true })).toEqual({ commands: [] });
    expect(await ctx.control.getCommand(c1, null)).toMatchObject({ status: 'rejected', reason: 'actor_not_authorized' });
    const c2 = await create(allA, 'worker');
    // the definition behind the name changed between request and dispatch
    expect(await ctx.control.poll({ tokenHash: a.tokenHash, report: v2([target('api'), target('worker', { identity: 'b'.repeat(16) })]), controlEnabled: true })).toEqual({ commands: [] });
    expect(await ctx.control.getCommand(c2, null)).toMatchObject({ status: 'rejected', reason: 'target_changed' });
    const c3 = await create(allA, 'worker');
    const delivered = await ctx.control.poll({ tokenHash: a.tokenHash, report: v2([target('api'), target('worker', { identity: 'b'.repeat(16) })]), controlEnabled: true });
    expect(delivered).toEqual({ commands: [expect.objectContaining({ id: c3, identity: 'b'.repeat(16) })] });
  });

  it('a revocation that commits while a command is being authorised waits for it: no command is created after the revocation', async () => {
    const { ctx, a, selA } = await world();
    await ctx.control.poll({ tokenHash: a.tokenHash, report: v2([target('api')]), controlEnabled: true });
    // The admin's revocation holds the grant row (DELETE, not yet committed) …
    const revoker = await connectTestClient(config);
    closers.push(() => revoker.end());
    const path = (await ctx.sql('SHOW search_path')).rows[0] as { search_path: string };
    await revoker.query(`SET search_path TO "${path.search_path}"`);
    await revoker.query('BEGIN');
    await revoker.query('DELETE FROM user_server_access WHERE user_id = $1', [selA]);
    // … the command authorisation waits for it (FOR SHARE) and sees the committed revocation.
    const pending = ctx.control.createCommand({ serverId: a.id, targetKey: 'n-api', action: 'restart', idempotencyKey: randomUUID(), actorUserId: selA, actorRole: 'operator', requestId: randomUUID() });
    await new Promise((r) => setTimeout(r, 300));
    await revoker.query('COMMIT');
    expect(await pending).toBe('not_found');
    expect((await ctx.sql('SELECT count(*)::int AS n FROM control_commands')).rows[0]).toEqual({ n: 0 });
  });

  it('role change and deactivation apply to the next authorisation; a viewer never creates commands', async () => {
    const { ctx, a, allA, multi } = await world();
    await ctx.control.poll({ tokenHash: a.tokenHash, report: v2([target('api'), target('worker')]), controlEnabled: true });
    const create = (actor: string, role: string) => ctx.control.createCommand({ serverId: a.id, targetKey: 'n-worker', action: 'stop', idempotencyKey: randomUUID(), actorUserId: actor, actorRole: role, requestId: randomUUID() });
    expect(await create(multi, 'viewer')).toBe('not_found');
    await ctx.sql(`UPDATE users SET role = 'viewer' WHERE id = $1`, [allA]);
    expect(await create(allA, 'operator')).toBe('not_found'); // stale role of the request is not trusted
    await ctx.sql(`UPDATE users SET role = 'operator', is_active = false WHERE id = $1`, [allA]);
    expect(await create(allA, 'operator')).toBe('not_found');
  });
});

describe('scope: log routes checker', () => {
  it('server and service visibility in one query, hidden names dropped', async () => {
    const { ctx, a, b, selA, multi } = await world();
    expect(await ctx.checker.serverVisible(selA, b.id)).toBe(false);
    expect(await ctx.checker.serverVisible(selA, a.id)).toBe(true);
    expect([...await ctx.checker.visibleServices(selA, a.id, ['api', 'worker', 'db'])]).toEqual(['api']);
    expect([...await ctx.checker.visibleServices(multi, b.id, ['web', 'api'])].sort()).toEqual(['api', 'web']);
    expect([...await ctx.checker.visibleServices(null, a.id, ['x'])]).toEqual(['x']);
    expect(await ctx.checker.serverVisible(null, randomUUID())).toBe(false);
  });
});

describe('grants administration', () => {
  it('atomic replace with revision, audit in the same transaction, validation, admin is global', async () => {
    const { ctx, a, b, none } = await world();
    const save = (expectedRevision: number, servers: { serverId: string; mode: 'all' | 'selected'; services: string[] }[], userId = none, actor = ctx.actor) =>
      ctx.access.saveAccess({ actor, userId, expectedRevision, servers, requestId: randomUUID() });
    expect(await save(0, [{ serverId: a.id, mode: 'selected', services: [] }])).toMatchObject({ status: 'invalid', reason: 'empty_selection' });
    expect(await save(0, [{ serverId: a.id, mode: 'all', services: ['api'] }])).toMatchObject({ status: 'invalid', reason: 'services_with_all' });
    expect(await save(0, [{ serverId: a.id, mode: 'selected', services: ['web'] }])).toMatchObject({ status: 'invalid', reason: 'unknown_service' }); // web belongs to beta
    expect(await save(0, [{ serverId: randomUUID(), mode: 'all', services: [] }])).toMatchObject({ status: 'invalid', reason: 'unknown_server' });
    expect(await save(0, [{ serverId: a.id, mode: 'all', services: [] }, { serverId: a.id, mode: 'all', services: [] }])).toMatchObject({ status: 'invalid', reason: 'duplicate_server' });
    const ok = await save(0, [{ serverId: a.id, mode: 'selected', services: ['api', 'db'] }, { serverId: b.id, mode: 'all', services: [] }]);
    expect(ok).toMatchObject({ status: 'ok', access: { revision: 1, servers: [{ serverName: 'alpha', mode: 'selected' }, { serverName: 'beta', mode: 'all' }] } });
    expect(await save(0, [])).toEqual({ status: 'revision_conflict' }); // a stale editor never overwrites
    expect((await ctx.sql(`SELECT details FROM audit_log WHERE event = 'access.updated'`)).rows).toEqual([{ details: { targetUserId: none, revision: 1, servers: 2, services: 2 } }]);
    expect(await save(1, [{ serverId: a.id, mode: 'all', services: [] }], ctx.adminId)).toEqual({ status: 'revision_conflict' });
    expect(await save(0, [{ serverId: a.id, mode: 'all', services: [] }], ctx.adminId)).toEqual({ status: 'role_global' });
    expect(await save(1, [], randomUUID())).toEqual({ status: 'not_found' });
    // a non-admin (or a revoked admin session) cannot change grants
    const op = await ctx.user('op2@example.test', 'operator');
    const opSession = (await ctx.sql(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour') RETURNING id`, [op, randomBytes(32)])).rows[0] as { id: string };
    expect(await save(1, [], none, { userId: op, sessionId: opSession.id })).toEqual({ status: 'actor_revoked' });
    // removing everything leaves the user with no resources
    expect(await save(1, [])).toMatchObject({ status: 'ok', access: { revision: 2, servers: [] } });
    expect((await ctx.servers.list({ limit: 10, afterId: null, scope: none })).items).toEqual([]);
  });

  it('editor helpers: server search and the service names of one server', async () => {
    const { ctx, a } = await world();
    expect((await ctx.access.searchServers({ q: 'ALP', limit: 10, afterName: null })).items.map((s) => s.name)).toEqual(['alpha']);
    expect(await ctx.access.serverServices({ serverId: a.id, q: null, limit: 10 })).toEqual({ items: [{ name: 'api', processes: 1 }, { name: 'db', processes: 1 }, { name: 'worker', processes: 1 }], truncated: false });
    expect(await ctx.access.serverServices({ serverId: a.id, q: null, limit: 2 })).toMatchObject({ truncated: true });
    expect(await ctx.access.serverServices({ serverId: randomUUID(), q: null, limit: 2 })).toBeNull();
  });
});

// Keeps the type import used even if a test above is skipped.
export type { Ctx };
