// Real PostgreSQL tests for alerts persistence (Task 013, ADR-021) — ONLY the isolated test DB, per-run schema.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import type { EvaluationConfig } from '../../src/alerts/settings.js';
import { ALERTS_DEFAULTS, type DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
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

/** One evaluation snapshot (ADR-022): delivery on for integration generation 1 unless overridden. */
function alertsConfig(over: Partial<EvaluationConfig> & { cooldownMinutes?: number } = {}): EvaluationConfig {
  const d = ALERTS_DEFAULTS.defaults;
  const { cooldownMinutes, ...rest } = over;
  return {
    thresholds: d.thresholds, cooldownSeconds: cooldownMinutes === undefined ? d.cooldownSeconds : cooldownMinutes * 60, reminderSeconds: 0,
    queueMax: d.queueMax, deliveryEnabled: true, generation: 1, rulesRevision: 1, ...rest,
  };
}

interface Ctx { db: Database; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult>; schema: string }
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
  return { db, schema, sql: (q, v = []) => raw.query(q, v) };
}
async function server(ctx: Ctx, name: string, seenAgo: number) {
  const id = ((await ctx.sql('INSERT INTO servers (name) VALUES ($1) RETURNING id', [name])).rows[0] as { id: string }).id;
  await ctx.sql('INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - make_interval(secs => $2), $3::jsonb)', [id, seenAgo, JSON.stringify(validSnapshot())]);
  return id;
}
const heartbeat = (ctx: Ctx, id: string) => ctx.sql('UPDATE server_heartbeats SET received_at = now() WHERE server_id = $1', [id]);
const count = async (ctx: Ctx, q: string, v: unknown[] = []) => Number(((await ctx.sql(q, v)).rows[0] as { n: string }).n);

describe('alerts persistence (real SQL)', () => {
  it('offline server → one incident + one queued firing item, atomically; re-evaluation and a "restarted" engine add nothing', async () => {
    const ctx = await setup();
    await server(ctx, 'down', 600);
    const cfg = alertsConfig();
    const first = await createPgAlertsStore(ctx.db).evaluateOnce(cfg);
    expect(first).toMatchObject({ skipped: false, opened: 1, enqueued: 1 });
    await createPgAlertsStore(ctx.db).evaluateOnce(cfg);
    // A new store instance = an API restart: state comes from the database, no second initial alert.
    await createPgAlertsStore(ctx.db).evaluateOnce(cfg);
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_incidents')).toBe(1);
    expect(await count(ctx, "SELECT count(*) AS n FROM alert_outbox WHERE kind = 'firing'")).toBe(1);
    expect((await ctx.sql('SELECT rule, severity, status, notify, detail ? \'lastSeenAt\' AS has_seen FROM alert_incidents')).rows).toEqual([{ rule: 'server_offline', severity: 'critical', status: 'firing', notify: true, has_seen: true }]);
  });

  it('recovery resolves and queues exactly one recovery; never_connected and inactive servers never alert', async () => {
    const ctx = await setup();
    const id = await server(ctx, 'flappy', 600);
    await ctx.sql("INSERT INTO servers (name) VALUES ('never')");
    const inactive = await server(ctx, 'inactive', 600);
    await ctx.sql('UPDATE servers SET is_active = false WHERE id = $1', [inactive]);
    const store = createPgAlertsStore(ctx.db);
    const cfg = alertsConfig();
    await store.evaluateOnce(cfg);
    await heartbeat(ctx, id);
    expect(await store.evaluateOnce(cfg)).toMatchObject({ resolved: 1, enqueued: 1 });
    await store.evaluateOnce(cfg);
    expect((await ctx.sql('SELECT server_name, status, resolution FROM alert_incidents')).rows).toEqual([{ server_name: 'flappy', status: 'resolved', resolution: 'recovered' }]);
    expect((await ctx.sql('SELECT kind FROM alert_outbox ORDER BY id')).rows).toEqual([{ kind: 'firing' }, { kind: 'resolved' }]);
  });

  it('cooldown: re-opening right after a resolution is recorded but not notified (no flapping spam)', async () => {
    const ctx = await setup();
    const id = await server(ctx, 'flap', 600);
    const store = createPgAlertsStore(ctx.db);
    const cfg = alertsConfig({ cooldownMinutes: 15 });
    await store.evaluateOnce(cfg);
    await heartbeat(ctx, id);
    await store.evaluateOnce(cfg);
    await ctx.sql("UPDATE server_heartbeats SET received_at = now() - interval '10 minutes' WHERE server_id = $1", [id]);
    expect(await store.evaluateOnce(cfg)).toMatchObject({ opened: 1, enqueued: 0 });
    expect((await ctx.sql('SELECT notify FROM alert_incidents WHERE status = \'firing\'')).rows).toEqual([{ notify: false }]);
    await heartbeat(ctx, id);
    expect(await store.evaluateOnce(cfg)).toMatchObject({ resolved: 1, enqueued: 0 }); // its recovery is not sent either
  });

  it('delivery disabled → incidents without outbox; a full queue records "dropped" instead of growing', async () => {
    const ctx = await setup();
    for (let i = 0; i < 12; i++) await server(ctx, `s${String(i)}`, 600);
    await createPgAlertsStore(ctx.db).evaluateOnce(alertsConfig({ deliveryEnabled: false }));
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_incidents')).toBe(12);
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_outbox')).toBe(0);
    const ctx2 = await setup();
    for (let i = 0; i < 12; i++) await server(ctx2, `s${String(i)}`, 600);
    const r = await createPgAlertsStore(ctx2.db).evaluateOnce(alertsConfig({ queueMax: 10 }));
    expect(r).toMatchObject({ opened: 12, enqueued: 10, dropped: 2 });
    expect(await count(ctx2, "SELECT count(*) AS n FROM alert_outbox WHERE status = 'dropped' AND last_error = 'queue_full'")).toBe(2);
  }, 60_000); // two schemas and 24 servers over the test tunnel

  it('concurrent evaluations never duplicate: one runs, the others skip (advisory lock)', async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) await server(ctx, `c${String(i)}`, 600);
    const cfg = alertsConfig();
    const results = await Promise.all(Array.from({ length: 6 }, () => createPgAlertsStore(ctx.db).evaluateOnce(cfg)));
    expect(results.reduce((n, r) => n + r.opened, 0)).toBe(5);
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_incidents')).toBe(5);
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_outbox')).toBe(5);
  });

  it('a failure inside the evaluation rolls back incidents, outbox and condition state together', async () => {
    const ctx = await setup();
    await server(ctx, 'rb', 600);
    await ctx.sql(`CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END; $$`);
    await ctx.sql('CREATE TRIGGER fail_outbox BEFORE INSERT ON alert_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox()');
    await expect(createPgAlertsStore(ctx.db).evaluateOnce(alertsConfig())).rejects.toBeTruthy();
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_incidents')).toBe(0);
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_conditions')).toBe(0);
    await ctx.sql('DROP TRIGGER fail_outbox ON alert_outbox');
    expect(await createPgAlertsStore(ctx.db).evaluateOnce(alertsConfig())).toMatchObject({ opened: 1, enqueued: 1 }); // retried next cycle
  });

  it('claims: concurrent workers get disjoint items; an expired lease is reclaimed; a stale owner cannot overwrite the result', async () => {
    const ctx = await setup();
    for (let i = 0; i < 6; i++) await server(ctx, `q${String(i)}`, 600);
    await createPgAlertsStore(ctx.db).evaluateOnce(alertsConfig());
    const [a, b] = await Promise.all([createPgAlertsStore(ctx.db).claim(4, 1), createPgAlertsStore(ctx.db).claim(4, 1)]);
    const ids = [...a, ...b].map((x) => x.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(a[0]?.incident).toMatchObject({ rule: 'server_offline', serverName: expect.stringMatching(/^q/) as unknown });
    const first = a[0];
    if (!first) throw new Error('nothing claimed');
    await ctx.sql("UPDATE alert_outbox SET lease_until = now() - interval '1 second' WHERE id = $1", [first.id]);
    const reclaimed = await createPgAlertsStore(ctx.db).claim(10, 1);
    expect(reclaimed.map((x) => [x.id, x.attempts])).toEqual([[first.id, 2]]);
    const store = createPgAlertsStore(ctx.db);
    expect(await store.finish(first, { status: 'sent' })).toBe(false); // the old claim (attempts 1) no longer owns it
    expect(await store.finish({ id: first.id, attempts: 2 }, { status: 'sent' })).toBe(true);
    expect(await store.finish({ id: first.id, attempts: 2 }, { status: 'failed', code: 'late' })).toBe(false);
    const other = b[0] ?? a[1];
    if (!other) throw new Error('nothing claimed');
    expect(await store.finish(other, { status: 'queued', code: 'rate_limited', delaySeconds: 3600 })).toBe(true);
    expect(await store.claim(10, 1)).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: other.id })])); // not before its time
    expect((await store.summary(true)).queue).toMatchObject({ sent: 1, sending: 4, queued: 1 });
  });

  it('retention removes only old finished outbox rows and old resolved incidents of this feature', async () => {
    const ctx = await setup();
    const id = await server(ctx, 'old', 600);
    const store = createPgAlertsStore(ctx.db);
    await store.evaluateOnce(alertsConfig());
    await heartbeat(ctx, id);
    await store.evaluateOnce(alertsConfig());
    await ctx.sql("UPDATE alert_outbox SET status = 'sent', finished_at = now() - interval '40 days'");
    await ctx.sql("UPDATE alert_incidents SET resolved_at = now() - interval '100 days', opened_at = now() - interval '101 days', last_observed_at = now() - interval '100 days'");
    const serversBefore = await count(ctx, 'SELECT count(*) AS n FROM servers');
    await store.evaluateOnce(alertsConfig());
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_outbox')).toBe(0);
    expect(await count(ctx, 'SELECT count(*) AS n FROM alert_incidents')).toBe(0);
    expect(await count(ctx, 'SELECT count(*) AS n FROM servers')).toBe(serversBefore);
    expect(await count(ctx, 'SELECT count(*) AS n FROM server_heartbeats')).toBe(1);
  });

  it('list API: active/resolved pages with keyset cursor; delivery state only when asked; no secrets stored', async () => {
    const ctx = await setup();
    for (let i = 0; i < 3; i++) await server(ctx, `l${String(i)}`, 600);
    const store = createPgAlertsStore(ctx.db);
    await store.evaluateOnce(alertsConfig());
    const page1 = await store.listIncidents({ state: 'active', limit: 2, before: null, withDelivery: false });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.notification).toBeNull();
    const page2 = await store.listIncidents({ state: 'active', limit: 2, before: page1.nextBefore, withDelivery: true });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.notification).toMatchObject({ notify: true, state: 'queued' });
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(3);
    const dump = JSON.stringify((await ctx.sql('SELECT * FROM alert_incidents')).rows) + JSON.stringify((await ctx.sql('SELECT * FROM alert_outbox')).rows) + JSON.stringify((await ctx.sql('SELECT * FROM alert_conditions')).rows);
    expect(dump).not.toContain('hooks.slack.com');
    expect(await createPgAlertsStore(ctx.db).listIncidents({ state: 'resolved', limit: 5, before: randomUUID(), withDelivery: false })).toEqual({ items: [], nextBefore: null });
  });
});
