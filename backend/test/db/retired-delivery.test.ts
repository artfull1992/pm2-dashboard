// Rollback compatibility release (ADR-023): notifications of the retired server_memory rule are never delivered —
// ONLY the isolated test DB, per-run schema. No Slack request is made: claim() only selects outbox rows.
//
// Scenario behind this file: migration 1791900000008 deliberately leaves a notification that is being delivered right
// now ("sending" with a live lease) alone. If the worker is interrupted and the API is rolled back to this release, the
// lease expires here — the release must cancel that row, not deliver it again.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as alertsStoreModule from '../../src/alerts/store.js';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
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

interface Ctx { db: Database; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult>; retired: string; cpu: string }
async function setup(): Promise<Ctx> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  closers.push(() => client.end());
  await migrateUp(client, { schema });
  await client.query(`SET search_path TO "${schema}"`);
  const db = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  closers.push(() => db.close());
  const sql = (q: string, v: unknown[] = []) => client.query(q, v);
  const sid = ((await sql("INSERT INTO servers (name) VALUES ('node') RETURNING id")).rows[0] as { id: string }).id;
  const incident = async (rule: string, status: string, resolution: string | null) => ((await sql(
    `INSERT INTO alert_incidents (condition_key, server_id, rule, severity, status, resolution, server_name, detail, notify, opened_at, last_observed_at, resolved_at)
     VALUES ($1, $2, $3, 'warning', $4, $5, 'node', '{}', true, now() - interval '2 hours', now() - interval '1 hour', $6) RETURNING id`,
    [`${rule}:${sid}`, sid, rule, status, resolution, status === 'resolved' ? new Date(Date.now() - 3_600_000) : null])).rows[0] as { id: string }).id;
  // As migration 1791900000008 leaves it: the server_memory incident closed as "retired".
  return { db, sql, retired: await incident('server_memory', 'resolved', 'retired'), cpu: await incident('process_cpu', 'firing', null) };
}

/** An outbox row; `lease` in seconds relative to now (negative = expired) for "sending". */
async function outbox(ctx: Ctx, incidentId: string, kind: string, status: string, lease: number | null = null, attempts = 0): Promise<string> {
  const finished = ['sent', 'failed', 'unknown', 'dropped', 'cancelled'].includes(status);
  return ((await ctx.sql(
    `INSERT INTO alert_outbox (incident_id, kind, status, generation, attempts, lease_until, finished_at)
     VALUES ($1, $2, $3, 1, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(secs => $5::int) END, CASE WHEN $6 THEN now() - interval '90 minutes' END)
     RETURNING id::text`, [incidentId, kind, status, attempts, lease, finished])).rows[0] as { id: string }).id;
}
const row = async (ctx: Ctx, id: string) => (await ctx.sql(
  'SELECT status, last_error, attempts, lease_until, finished_at FROM alert_outbox WHERE id = $1::bigint', [id])).rows[0] as { status: string; last_error: string | null; attempts: number; lease_until: Date | null; finished_at: Date | null };
const claimedRules = async (ctx: Ctx) => (await createPgAlertsStore(ctx.db).claim(10, 1)).map((c) => `${c.incident.rule}:${c.kind}`);

describe('rollback release: the retired server_memory rule is never delivered (no evaluateOnce anywhere: engine may be off)', () => {
  it('queued firing → cancelled (rule_retired), claim returns nothing', async () => {
    const ctx = await setup();
    const id = await outbox(ctx, ctx.retired, 'firing', 'queued');
    expect(await claimedRules(ctx)).toEqual([]);
    expect(await row(ctx, id)).toMatchObject({ status: 'cancelled', last_error: 'rule_retired', lease_until: null });
    expect((await row(ctx, id)).finished_at).not.toBeNull();
  });

  it('queued reminder and resolved of the retired rule are not handed out either', async () => {
    const ctx = await setup();
    const reminder = await outbox(ctx, ctx.retired, 'reminder', 'queued');
    const resolved = await outbox(ctx, ctx.retired, 'resolved', 'queued');
    expect(await claimedRules(ctx)).toEqual([]);
    for (const id of [reminder, resolved]) expect(await row(ctx, id)).toMatchObject({ status: 'cancelled', last_error: 'rule_retired' });
  });

  it('"sending" with an EXPIRED lease (interrupted worker, rollback) → cancelled, not redelivered — the reviewed scenario', async () => {
    const ctx = await setup();
    const id = await outbox(ctx, ctx.retired, 'firing', 'sending', -300, 1);
    expect(await claimedRules(ctx)).toEqual([]);
    expect(await row(ctx, id)).toMatchObject({ status: 'cancelled', last_error: 'rule_retired', attempts: 1 });
  });

  it('a LIVE lease is neither taken over nor marked as undelivered; when its delivery comes back for a retry, the next claim cancels it', async () => {
    const ctx = await setup();
    const id = await outbox(ctx, ctx.retired, 'firing', 'sending', 300, 1);
    const before = await row(ctx, id);
    expect(await claimedRules(ctx)).toEqual([]);
    expect(await row(ctx, id)).toEqual(before); // untouched: still owned by the running delivery
    const store = createPgAlertsStore(ctx.db);
    expect(await store.finish({ id, attempts: 1 }, { status: 'queued', code: 'http_500', delaySeconds: 0 })).toBe(true);
    expect(await store.claim(10, 1)).toEqual([]);
    expect(await row(ctx, id)).toMatchObject({ status: 'cancelled', last_error: 'rule_retired' });
  });

  it('cleanup + claim are idempotent; sent history, the incident and other rules are unchanged; active process rules are delivered', async () => {
    const ctx = await setup();
    const sent = await outbox(ctx, ctx.retired, 'firing', 'sent');
    const queued = await outbox(ctx, ctx.retired, 'reminder', 'queued');
    const cpu = await outbox(ctx, ctx.cpu, 'firing', 'queued');
    const sentBefore = await row(ctx, sent);
    const incidentBefore = (await ctx.sql('SELECT status, resolution, resolved_at FROM alert_incidents WHERE id = $1', [ctx.retired])).rows[0] as unknown;
    expect(await claimedRules(ctx)).toEqual(['process_cpu:firing']);
    const cancelledAt = (await row(ctx, queued)).finished_at;
    expect(await claimedRules(ctx)).toEqual([]); // the cpu item is leased now; nothing else to hand out
    expect(await claimedRules(ctx)).toEqual([]);
    expect(await row(ctx, queued)).toMatchObject({ status: 'cancelled', last_error: 'rule_retired', finished_at: cancelledAt });
    expect(await row(ctx, sent)).toEqual(sentBefore);
    expect((await ctx.sql('SELECT status, resolution, resolved_at FROM alert_incidents WHERE id = $1', [ctx.retired])).rows[0]).toEqual(incidentBefore);
    expect(await row(ctx, cpu)).toMatchObject({ status: 'sending', attempts: 1 });
    expect((await ctx.sql("SELECT count(*)::int AS n FROM alert_outbox WHERE kind = 'resolved'")).rows[0]).toEqual({ n: 0 }); // no recovery created
  });

  it('the claim SELECT itself excludes the retired rule: a row that becomes claimable after the cleanup is still not picked', async () => {
    const ctx = await setup();
    const claimSql = (alertsStoreModule as Record<string, unknown>).CLAIM_SQL;
    expect(typeof claimSql).toBe('string'); // the statement claim() runs, exported so it can be checked on its own
    const id = await outbox(ctx, ctx.retired, 'firing', 'queued');
    const cpu = await outbox(ctx, ctx.cpu, 'reminder', 'queued');
    // Run the claim statement WITHOUT the preceding cleanup: the retired row is claimable as far as status goes.
    const picked = (await ctx.db.query(String(claimSql), [10, 60, 1, ['server_memory']])).rows.map((r) => (r as { outbox_id: string }).outbox_id);
    expect(picked).toEqual([cpu]);
    expect(await row(ctx, id)).toMatchObject({ status: 'queued', attempts: 0 }); // not leased, not delivered
  });
});
