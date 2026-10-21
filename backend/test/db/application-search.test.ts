// Name search over all applications and the command history of one control target — real PostgreSQL, ONLY the
// isolated test database (per-run schema). Synthetic servers and processes.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { agentTokenDigest, newAgentToken } from '../../src/auth/tokens.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { createPgControlStore } from '../../src/servers/control-store.js';
import { cursorContext, decodeCursor, type InventoryProcess } from '../../src/servers/inventory.js';
import { createPgInventoryStore, type InventoryStore } from '../../src/servers/inventory-store.js';
import { createPgServerStore } from '../../src/servers/store.js';
import { validSnapshot } from '../support/fake-server-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];
const databases: Database[] = [];
beforeAll(async () => { config = testDbConfig(readTestDbEnv()); admin = await connectTestClient(config); });
afterAll(async () => {
  for (const db of databases) await db.close();
  for (const schema of schemas) await dropRunSchema(admin, schema);
  await admin.end();
});

async function setup() {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  const db = createDatabase({ ...config, poolMax: 10 }, { error: () => undefined }, createPool({ ...config, poolMax: 10 }, { searchPath: schema }));
  databases.push(db);
  const boot = await bootstrapAdmin(db, { email: 'admin@example.test', passwordHash: 'scrypt$placeholder' });
  if (boot.status !== 'created') throw new Error('bootstrap failed');
  const actor = { actorUserId: boot.userId, requestId: '00000000-0000-4000-8000-000000000000' };
  const sql = async (q: string, v: unknown[] = []) => {
    await admin.query(`SET search_path TO "${schema}"`);
    try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
  };
  const servers = createPgServerStore(db);
  const inventory = createPgInventoryStore(db);
  const node = async (name: string, processes: InventoryProcess[]) => {
    const created = await servers.create({ name, ...actor });
    if (created === 'name_taken') throw new Error('unexpected');
    const token = newAgentToken();
    await servers.issueCredential({ serverId: created.id, tokenHash: agentTokenDigest(token), ...actor });
    await servers.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot() });
    await inventory.recordInventory({ tokenHash: agentTokenDigest(token), report: { version: 1, state: 'ok', reason: null, source: 'pm2', capturedAt: new Date().toISOString(), processes } });
    return created.id;
  };
  return { schema, sql, inventory, control: createPgControlStore(db), node, userId: boot.userId };
}

const proc = (pmId: number, name: string, status: InventoryProcess['status'] = 'online'): InventoryProcess =>
  ({ pmId, name, status, uptimeSeconds: 60, restarts: 0, cpuPercent: 1, memoryBytes: 1024, execMode: 'fork' });

/** Every page of a list, following the cursors exactly as the API would (context included). */
async function allPages(inventory: InventoryStore, filter: { serverId: string | null; status: 'online' | 'stopped' | null; q: string | null }, limit = 50) {
  const context = cursorContext(filter);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<InventoryStore['listApplications']>> = await inventory.listApplications({ limit, cursor: cursor ? decodeCursor(cursor) : null, ...filter, context, scope: null });
    seen.push(...page.items.map((i) => `${i.name}|${i.serverId}|${String(i.pmId)}`));
    cursor = page.nextCursor;
    if (cursor) expect(decodeCursor(cursor)?.context).toBe(context);
    pages += 1;
  } while (cursor && pages < 100);
  return seen;
}

describe('application name search (real DB, 520+ applications)', () => {
  it('finds matches beyond the first page, combines with server/status, paginates without gaps or duplicates', async () => {
    const ctx = await setup();
    const many = (prefix: string, n: number, offset = 0) => Array.from({ length: n }, (_, i) => proc(offset + i, `${prefix}-${String(i).padStart(3, '0')}`, i % 7 === 0 ? 'stopped' : 'online'));
    const a = await ctx.node('alpha', [...many('svc', 250), proc(900, 'zz-billing-api'), proc(901, 'Сервіс-Оплати'), proc(902, 'promo_50%_off'), proc(903, 'back\\slash')]);
    const b = await ctx.node('beta', [...many('svc', 260), proc(900, 'zz-billing-api', 'stopped'), proc(901, 'worker')]);
    const total = (await ctx.sql('SELECT count(*)::int AS n FROM server_applications')).rows[0] as { n: number };
    expect(total.n).toBeGreaterThanOrEqual(515);

    // The match sorts after ~510 other rows: it is NOT on the first page of the unfiltered list…
    const firstPage = await ctx.inventory.listApplications({ limit: 50, cursor: null, serverId: null, status: null, scope: null });
    expect(firstPage.items.some((i) => i.name === 'zz-billing-api')).toBe(false);
    // …but the search finds it on both servers, case-insensitively.
    expect(await allPages(ctx.inventory, { serverId: null, status: null, q: 'BILLING' })).toEqual([`zz-billing-api|${a}|900`, `zz-billing-api|${b}|900`].sort());
    expect(await allPages(ctx.inventory, { serverId: b, status: 'stopped', q: 'billing' })).toEqual([`zz-billing-api|${b}|900`]);
    expect(await allPages(ctx.inventory, { serverId: a, status: 'stopped', q: 'billing' })).toEqual([]);

    // Unicode (database ctype en_US.UTF-8) and literal %, _ and backslash — no LIKE wildcards.
    expect(await allPages(ctx.inventory, { serverId: null, status: null, q: 'сервіс' })).toEqual([`Сервіс-Оплати|${a}|901`]);
    expect(await allPages(ctx.inventory, { serverId: null, status: null, q: '50%' })).toEqual([`promo_50%_off|${a}|902`]);
    expect(await allPages(ctx.inventory, { serverId: null, status: null, q: '%' })).toEqual([`promo_50%_off|${a}|902`]);
    expect(await allPages(ctx.inventory, { serverId: null, status: null, q: '_' })).toEqual([`promo_50%_off|${a}|902`]);
    expect(await allPages(ctx.inventory, { serverId: null, status: null, q: '\\' })).toEqual([`back\\slash|${a}|903`]);
    // Injection-looking input is a plain substring: no error, no rows, no side effects.
    for (const q of ["'; DROP TABLE server_applications; --", "' OR '1'='1", '$1', '\\x00']) {
      expect(await allPages(ctx.inventory, { serverId: null, status: null, q })).toEqual([]);
    }
    expect(((await ctx.sql('SELECT count(*)::int AS n FROM server_applications')).rows[0] as { n: number }).n).toBe(total.n);

    // Keyset pages of a broad search: every match exactly once, in the list order.
    const svc = await allPages(ctx.inventory, { serverId: null, status: null, q: 'SVC-' }, 37);
    expect(svc).toHaveLength(510);
    expect(new Set(svc).size).toBe(510);
    const direct = (await ctx.sql(`SELECT name || '|' || server_id || '|' || pm_id AS k FROM server_applications WHERE name LIKE 'svc-%' ORDER BY name, server_id, pm_id`)).rows.map((r) => (r as { k: string }).k);
    expect(svc).toEqual(direct);
    const online = await allPages(ctx.inventory, { serverId: a, status: 'online', q: 'svc' }, 40);
    expect(online).toHaveLength(250 - Math.ceil(250 / 7));
  });

  it('query plan: one bounded scan with the filters before the LIMIT (no extra index needed at this size)', async () => {
    const ctx = await setup();
    await ctx.node('alpha', Array.from({ length: 500 }, (_, i) => proc(i, `app-${String(i).padStart(3, '0')}`)));
    await ctx.sql('ANALYZE server_applications');
    const plan = (await ctx.sql(`EXPLAIN (FORMAT JSON)
      SELECT a.name FROM server_applications a WHERE strpos(lower(a.name), lower('app-49')) > 0 ORDER BY a.name, a.server_id, a.pm_id LIMIT 51`)).rows[0] as { 'QUERY PLAN': { Plan: { 'Node Type': string; 'Plan Rows': number } }[] };
    const top = plan['QUERY PLAN'][0]?.Plan;
    expect(top?.['Node Type']).toBe('Limit');
    expect(JSON.stringify(plan)).toContain('strpos');
  });
});

describe('command history of one control target (real DB)', () => {
  it('filters by server + target key in SQL before the limit; the same key on another server is never mixed in', async () => {
    const ctx = await setup();
    const a = await ctx.node('alpha', [proc(1, 'api')]);
    const b = await ctx.node('beta', [proc(1, 'api')]);
    // One statement per group (few round trips): `count` commands, the i-th requested `first + i` minutes ago.
    const insert = (serverId: string, keyExpr: string, first: number, count: number) => ctx.sql(
      `INSERT INTO control_commands (server_id, target_key, action, status, reason, requested_by, idempotency_key, requested_at, deadline_at, completed_at)
       SELECT $1, ${keyExpr}, 'restart', 'succeeded', NULL, $2, gen_random_uuid(),
              now() - make_interval(mins => $3 + i), now() - make_interval(mins => $3 + i) + interval '2 minutes', now() - make_interval(mins => $3 + i) + interval '1 minute'
         FROM generate_series(0, $4 - 1) AS i`,
      [serverId, ctx.userId, first, count]);
    // 30 newer commands of OTHER targets on alpha, then 3 older ones of api-prod: a "last 10 of the server" list would miss them.
    await insert(a, "'other-' || (i % 3)", 1, 30);
    await insert(a, "'api-prod'", 100, 3);
    await insert(b, "'api-prod'", 1, 5); // same key, other server
    const history = await ctx.control.listCommands(a, 10, 'api-prod', null);
    expect(history?.map((c) => c.targetKey)).toEqual(['api-prod', 'api-prod', 'api-prod']);
    expect(history?.every((c) => c.serverId === a)).toBe(true);
    const times = history?.map((c) => Date.parse(c.requestedAt)) ?? [];
    expect([...times].sort((x, y) => y - x)).toEqual(times); // newest first
    expect((await ctx.control.listCommands(a, 10, null, null))?.some((c) => c.targetKey === 'api-prod')).toBe(false); // unfiltered: newest 10 only
    expect(await ctx.control.listCommands(a, 10, 'never-used', null)).toEqual([]);
    expect((await ctx.control.listCommands(b, 2, 'api-prod', null))?.length).toBe(2);
    expect(await ctx.control.listCommands('11111111-1111-4111-8111-111111111111', 10, 'api-prod', null)).toBeNull();
  });
});
