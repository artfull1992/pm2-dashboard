// Real PostgreSQL: taking the server_memory rule out of service (ADR-023) — ONLY the isolated test DB, per-run schema.
// Covers the forward migration on data created before it, the runtime retirement inside the evaluation (anything an
// older API created after the migration), the delivery guard, idempotence, and that no fake recovery is ever queued.
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvaluationConfig } from '../../src/alerts/settings.js';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import { ALERTS_DEFAULTS, type DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { legacySnapshot } from '../support/fake-server-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'migrations');
const RETIRE = '1791900000008_retire-server-memory.sql';
const noLog = { error: () => undefined };
let config: DbConfig;
let admin: pg.Client;
const schemas: string[] = [];
const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
beforeAll(async () => { config = testDbConfig(readTestDbEnv()); admin = await connectTestClient(config); });
afterAll(async () => {
  for (const c of closers) await c();
  for (const s of schemas) await dropRunSchema(admin, s);
  await admin.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function cfg(over: Partial<EvaluationConfig> = {}): EvaluationConfig {
  const d = ALERTS_DEFAULTS.defaults;
  return { thresholds: d.thresholds, cooldownSeconds: d.cooldownSeconds, reminderSeconds: 0, queueMax: d.queueMax, deliveryEnabled: true, generation: 1, rulesRevision: 1, ...over };
}

interface Ctx { db: Database; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult>; client: pg.Client; schema: string }
/** `upTo`: apply only the migrations BEFORE the retirement one (to create pre-migration data), else all of them. */
async function setup(upTo: 'before-retire' | 'all'): Promise<Ctx> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  closers.push(() => client.end());
  let dir = MIGRATIONS;
  if (upTo === 'before-retire') {
    dir = mkdtempSync(join(tmpdir(), 'nc-migr-before-'));
    dirs.push(dir);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n < RETIRE)) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  }
  await migrateUp(client, { schema, dir });
  await client.query(`SET search_path TO "${schema}"`);
  const db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  closers.push(() => db.close());
  return { db, schema, client, sql: (q, v = []) => client.query(q, v) };
}

/** Pre-ADR-023 state: a firing server_memory incident with queued/expired/leased outbox rows and its condition row. */
async function legacyState(ctx: Ctx) {
  const sid = ((await ctx.sql("INSERT INTO servers (name) VALUES ('legacy') RETURNING id")).rows[0] as { id: string }).id;
  await ctx.sql('INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now(), $2::jsonb)', [sid, JSON.stringify(legacySnapshot())]);
  const incident = async (rule: string, status: 'firing' | 'resolved') => ((await ctx.sql(
    `INSERT INTO alert_incidents (condition_key, server_id, rule, severity, status, resolution, server_name, detail, notify, opened_at, last_observed_at, resolved_at)
     VALUES ($1, $2, $3, 'warning', $4, $5, 'legacy', '{"value": 95, "threshold": 90}', true, now() - interval '1 hour', now(), $6) RETURNING id`,
    [`${rule}:${sid}:${status}`, sid, rule, status, status === 'resolved' ? 'recovered' : null, status === 'resolved' ? new Date() : null])).rows[0] as { id: string }).id;
  const memory = await incident('server_memory', 'firing');
  const memoryHistory = await incident('server_memory', 'resolved');
  const cpu = await incident('process_cpu', 'firing');
  const outbox = async (inc: string, kind: string, status: string, lease: string | null) => ((await ctx.sql(
    `INSERT INTO alert_outbox (incident_id, kind, status, generation, lease_until, attempts) VALUES ($1, $2, $3, 1, ${lease === null ? 'NULL' : `now() + interval '${lease}'`}, $4) RETURNING id::text`,
    [inc, kind, status, status === 'sending' ? 1 : 0])).rows[0] as { id: string }).id;
  const ids = {
    queued: await outbox(memory, 'firing', 'queued', null),
    reminder: await outbox(memory, 'reminder', 'queued', null),
    expired: await outbox(memory, 'reminder', 'sending', '-5 minutes'),
    leased: await outbox(memory, 'reminder', 'sending', '5 minutes'), // a delivery is in flight right now
    cpuQueued: await outbox(cpu, 'firing', 'queued', null),
  };
  await ctx.sql(`INSERT INTO alert_conditions (condition_key, server_id, rule, state, streak, incident_id) VALUES ($1, $2, 'server_memory', 'firing', 0, $3)`, [`server_memory:${sid}`, sid, memory]);
  return { sid, memory, memoryHistory, cpu, ids };
}

const outboxRow = async (ctx: Ctx, id: string) => (await ctx.sql('SELECT status, last_error FROM alert_outbox WHERE id = $1::bigint', [id])).rows[0] as { status: string; last_error: string | null };

async function expectRetired(ctx: Ctx, s: Awaited<ReturnType<typeof legacyState>>) {
  expect((await ctx.sql('SELECT status, resolution, resolved_at IS NOT NULL AS closed FROM alert_incidents WHERE id = $1', [s.memory])).rows[0])
    .toEqual({ status: 'resolved', resolution: 'retired', closed: true });
  // History stays readable and unchanged; other rules are untouched.
  expect((await ctx.sql('SELECT resolution FROM alert_incidents WHERE id = $1', [s.memoryHistory])).rows[0]).toEqual({ resolution: 'recovered' });
  expect((await ctx.sql('SELECT status FROM alert_incidents WHERE id = $1', [s.cpu])).rows[0]).toEqual({ status: 'firing' });
  for (const id of [s.ids.queued, s.ids.reminder, s.ids.expired]) expect(await outboxRow(ctx, id)).toEqual({ status: 'cancelled', last_error: 'rule_retired' });
  expect(await outboxRow(ctx, s.ids.leased)).toEqual({ status: 'sending', last_error: null }); // finishes on its own
  expect(await outboxRow(ctx, s.ids.cpuQueued)).toEqual({ status: 'queued', last_error: null });
  // No fake recovery: never a "resolved" notification for the retired incident.
  expect((await ctx.sql("SELECT count(*)::int AS n FROM alert_outbox WHERE incident_id = $1 AND kind = 'resolved'", [s.memory])).rows[0]).toEqual({ n: 0 });
  expect((await ctx.sql("SELECT count(*)::int AS n FROM alert_conditions WHERE rule = 'server_memory'")).rows[0]).toEqual({ n: 0 });
}

describe('server_memory retirement (ADR-023)', () => {
  it('the forward migration closes open incidents as "retired", cancels their pending notifications and keeps history', async () => {
    const ctx = await setup('before-retire');
    const s = await legacyState(ctx);
    await migrateUp(ctx.client, { schema: ctx.schema, dir: MIGRATIONS });
    await expectRetired(ctx, s);
    // The widened CHECK still rejects unknown resolutions.
    await expect(ctx.sql("UPDATE alert_incidents SET resolution = 'whatever' WHERE id = $1", [s.memoryHistory])).rejects.toMatchObject({ code: '23514' });
  });

  it('the evaluation retires what an older API created after the migration; repeated runs change nothing more', async () => {
    const ctx = await setup('all');
    const s = await legacyState(ctx);
    const store = createPgAlertsStore(ctx.db);
    const first = await store.evaluateOnce(cfg());
    expect(first).toMatchObject({ skipped: false, retired: 1 });
    await expectRetired(ctx, s);
    const before = (await ctx.sql('SELECT id, status, last_error, finished_at FROM alert_outbox ORDER BY id')).rows;
    const again = await store.evaluateOnce(cfg());
    expect(again).toMatchObject({ retired: 0 });
    expect((await ctx.sql('SELECT id, status, last_error, finished_at FROM alert_outbox ORDER BY id')).rows).toEqual(before);
    // The rule is not evaluated any more: no new server_memory incident although the stored snapshot is a 0.4.x one.
    expect((await ctx.sql("SELECT count(*)::int AS n FROM alert_incidents WHERE rule = 'server_memory' AND status = 'firing'")).rows[0]).toEqual({ n: 0 });
  });

  it('delivery never claims a retired rule\'s notification — even with the engine off (no evaluation) — and cancels it', async () => {
    const ctx = await setup('all');
    const s = await legacyState(ctx);
    const store = createPgAlertsStore(ctx.db);
    const claimed = await store.claim(10, 1);
    expect(claimed.map((c) => c.incident.rule)).toEqual(['process_cpu']);
    for (const id of [s.ids.queued, s.ids.reminder, s.ids.expired]) expect(await outboxRow(ctx, id)).toEqual({ status: 'cancelled', last_error: 'rule_retired' });
    // An in-flight delivery that comes back to the queue (retry) is cancelled by the next claim, not sent.
    expect(await store.finish({ id: s.ids.leased, attempts: 1 }, { status: 'queued', code: 'http_500', delaySeconds: 0 })).toBe(true);
    expect(await store.claim(10, 1)).toEqual([]);
    expect(await outboxRow(ctx, s.ids.leased)).toEqual({ status: 'cancelled', last_error: 'rule_retired' });
  });
});
