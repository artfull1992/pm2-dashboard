// Real PostgreSQL tests for admin-managed alert settings and the encrypted Slack integration (Task 013.1, ADR-022)
// — ONLY the isolated test DB, per-run schema.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, seal } from '../../src/alerts/secret.js';
import { type AlertSettings, evaluationConfig } from '../../src/alerts/settings.js';
import { createPgSettingsStore } from '../../src/alerts/settings-store.js';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import { ALERTS_DEFAULTS, type DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { validSnapshot } from '../support/fake-server-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const noLog = { error: () => undefined };
const WEBHOOK = `https://hooks.slack.com/services/T0SYNTH06/B0SYNTH06/${'k'.repeat(24)}`;
const KEY = { version: 1, key: Buffer.alloc(32, 3) };
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

interface Ctx { db: Database; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult>; actor: { userId: string; requestId: string } }
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
  const sql = (q: string, v: unknown[] = []) => raw.query(q, v);
  const userId = ((await sql("INSERT INTO users (email, password_hash, role) VALUES ('adm@example.test', 'x', 'admin') RETURNING id")).rows[0] as { id: string }).id;
  return { db, sql, actor: { userId, requestId: randomUUID() } };
}
const count = async (ctx: Ctx, q: string) => Number(((await ctx.sql(q)).rows[0] as { n: string }).n);

describe('settings persistence (real SQL)', () => {
  it('migration creates the integration singleton; initialize() inserts defaults once and never overwrites saved settings', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    expect((await store.getIntegration())).toMatchObject({ generation: 0, sealed: null });
    expect(await store.initialize(ALERTS_DEFAULTS.defaults)).toBe(true);
    const first = await store.getSettings();
    expect(first).toMatchObject({ revision: 1, rulesRevision: 1, engineEnabled: false, deliveryEnabled: false, thresholds: { cpuOpenPercent: 90 } });
    await store.updateSettings({ expectedRevision: 1, patch: { engineEnabled: true, thresholds: { cpuOpenPercent: 300, cpuClosePercent: 200 } }, actor: ctx.actor });
    expect(await store.initialize({ ...ALERTS_DEFAULTS.defaults, engineEnabled: false })).toBe(false);
    expect(await store.getSettings()).toMatchObject({ revision: 2, rulesRevision: 2, engineEnabled: true, thresholds: { cpuOpenPercent: 300 } });
    await expect(ctx.sql('UPDATE alert_settings SET cpu_close_percent = 400')).rejects.toMatchObject({ code: '23514' }); // recovery ≥ opening refused by the DB too
  });

  it('concurrent updates from the same revision: exactly one wins, the other is a conflict', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    await store.initialize(ALERTS_DEFAULTS.defaults);
    const results = await Promise.all([
      store.updateSettings({ expectedRevision: 1, patch: { intervalSeconds: 60 }, actor: ctx.actor }),
      store.updateSettings({ expectedRevision: 1, patch: { intervalSeconds: 120 }, actor: ctx.actor }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'updated']);
    expect((await store.getSettings()).revision).toBe(2);
    expect(await count(ctx, "SELECT count(*) AS n FROM audit_log WHERE event = 'settings.alerts_changed'")).toBe(1);
  });

  it('a failing audit insert rolls the settings change back (one transaction)', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    await store.initialize(ALERTS_DEFAULTS.defaults);
    await ctx.sql(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event LIKE 'settings.%' OR NEW.event LIKE 'integration.%' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END; $$`);
    await ctx.sql('CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()');
    await expect(store.updateSettings({ expectedRevision: 1, patch: { engineEnabled: true }, actor: ctx.actor })).rejects.toBeTruthy();
    await expect(store.configureSlack({ expectedGeneration: 0, seal: (g) => seal(WEBHOOK, g, KEY), actor: ctx.actor })).rejects.toBeTruthy();
    expect(await store.getSettings()).toMatchObject({ revision: 1, engineEnabled: false });
    expect((await store.getIntegration())).toMatchObject({ generation: 0, sealed: null });
    await ctx.sql('DROP TRIGGER fail_audit ON audit_log');
  });

  it('the webhook is stored only as AES-GCM ciphertext bound to its generation; tampering is detected; no plaintext anywhere', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    await store.initialize(ALERTS_DEFAULTS.defaults);
    expect(await store.configureSlack({ expectedGeneration: 0, seal: (g) => seal(WEBHOOK, g, KEY), actor: ctx.actor })).toMatchObject({ status: 'configured', generation: 1 });
    const i = await store.getIntegration();
    if (!i.sealed) throw new Error('no secret');
    expect(open(i.sealed, i.generation, KEY)).toEqual({ ok: true, value: WEBHOOK });
    expect(open({ ...i.sealed, tag: Buffer.alloc(16) }, i.generation, KEY)).toEqual({ ok: false, error: 'decrypt_failed' });
    expect(open(i.sealed, i.generation, { version: 1, key: Buffer.alloc(32, 4) })).toEqual({ ok: false, error: 'decrypt_failed' });
    expect(open(i.sealed, i.generation, { version: 2, key: KEY.key })).toEqual({ ok: false, error: 'key_version_mismatch' });
    expect(open(i.sealed, i.generation, null)).toEqual({ ok: false, error: 'key_missing' });
    const dump = JSON.stringify((await ctx.sql("SELECT encode(ciphertext, 'escape') AS c FROM alert_slack_integration")).rows)
      + JSON.stringify((await ctx.sql('SELECT details FROM audit_log')).rows) + JSON.stringify((await ctx.sql('SELECT * FROM alert_settings')).rows);
    expect(dump).not.toContain('hooks.slack.com');
    expect(dump).not.toContain('k'.repeat(24));
  });

  it('replacing the webhook cancels the old queue and the worker never claims another generation; removal disables delivery', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    const alerts = createPgAlertsStore(ctx.db);
    await store.initialize(ALERTS_DEFAULTS.defaults);
    await store.configureSlack({ expectedGeneration: 0, seal: (g) => seal(WEBHOOK, g, KEY), actor: ctx.actor });
    await store.updateSettings({ expectedRevision: 1, patch: { deliveryEnabled: true, engineEnabled: true }, actor: ctx.actor });
    const sid = ((await ctx.sql("INSERT INTO servers (name) VALUES ('gone') RETURNING id")).rows[0] as { id: string }).id;
    await ctx.sql("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - interval '10 minutes', $2::jsonb)", [sid, JSON.stringify(validSnapshot())]);
    const s1: AlertSettings = await store.getSettings();
    expect(await alerts.evaluateOnce(evaluationConfig(s1, { usable: true, generation: 1 }))).toMatchObject({ opened: 1, enqueued: 1 });
    expect((await ctx.sql('SELECT generation::int AS g, status FROM alert_outbox')).rows).toEqual([{ g: 1, status: 'queued' }]);
    expect(await alerts.claim(10, 2)).toEqual([]); // another generation never gets it
    const replaced = await store.configureSlack({ expectedGeneration: 1, seal: (g) => seal(WEBHOOK.replace('kkkk', 'mmmm'), g, KEY), actor: ctx.actor });
    expect(replaced).toMatchObject({ status: 'configured', generation: 2, cancelled: 1 });
    expect((await ctx.sql('SELECT status, last_error FROM alert_outbox')).rows).toEqual([{ status: 'cancelled', last_error: 'integration_changed' }]);
    expect(await alerts.claim(10, 1)).toEqual([]);
    expect(await alerts.claim(10, 2)).toEqual([]);
    const removed = await store.removeSlack({ expectedGeneration: 2, actor: ctx.actor });
    expect(removed).toMatchObject({ status: 'removed', generation: 3 });
    expect(await store.getSettings()).toMatchObject({ deliveryEnabled: false });
    expect((await ctx.sql("SELECT event FROM audit_log WHERE event LIKE 'integration.%' OR event LIKE 'settings.delivery%' ORDER BY id")).rows.map((r) => (r as { event: string }).event))
      .toEqual(['integration.slack_configured', 'settings.delivery_enabled', 'integration.slack_configured', 'settings.delivery_disabled', 'integration.slack_removed']);
    expect(await store.removeSlack({ expectedGeneration: 2, actor: ctx.actor })).toEqual({ status: 'conflict' });
  });

  it('a rules change resets pending streaks: observations under the old thresholds are not counted under the new ones', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    const alerts = createPgAlertsStore(ctx.db);
    await store.initialize(ALERTS_DEFAULTS.defaults);
    const sid = ((await ctx.sql("INSERT INTO servers (name) VALUES ('hot') RETURNING id")).rows[0] as { id: string }).id;
    const hot = JSON.stringify(validSnapshot({ memory: { totalBytes: 1000, freeBytes: 20 } }));
    await ctx.sql('INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now(), $2::jsonb)', [sid, hot]);
    const beat = (s: number) => ctx.sql("UPDATE server_heartbeats SET received_at = now() + make_interval(secs => $2) WHERE server_id = $1", [sid, s]);
    const run = async () => alerts.evaluateOnce(evaluationConfig(await store.getSettings(), { usable: false, generation: null }));
    await run(); // memory sample 1 (pending, streak 1)
    await beat(1);
    await run(); // sample 2 (streak 2)
    await store.updateSettings({ expectedRevision: 1, patch: { thresholds: { memoryOpenPercent: 95, memoryClosePercent: 85 } }, actor: ctx.actor });
    await beat(2);
    expect(await run()).toMatchObject({ opened: 0 }); // without the reset this would be streak 3 → open
    await beat(3);
    expect(await run()).toMatchObject({ opened: 0 });
    await beat(4);
    expect(await run()).toMatchObject({ opened: 1 }); // 3 samples under the new rules
  });

  it('a test result is stored only for the current generation', async () => {
    const ctx = await setup();
    const store = createPgSettingsStore(ctx.db);
    await store.initialize(ALERTS_DEFAULTS.defaults);
    await store.configureSlack({ expectedGeneration: 0, seal: (g) => seal(WEBHOOK, g, KEY), actor: ctx.actor });
    expect((await store.recordTestResult({ generation: 1, testId: randomUUID(), outcome: 'success', code: null, actor: ctx.actor })).stored).toBe(true);
    await store.configureSlack({ expectedGeneration: 1, seal: (g) => seal(WEBHOOK, g, KEY), actor: ctx.actor });
    expect((await store.getIntegration()).lastTest).toBeNull(); // replacing resets the test state
    expect((await store.recordTestResult({ generation: 1, testId: randomUUID(), outcome: 'success', code: null, actor: ctx.actor })).stored).toBe(false);
    expect((await store.getIntegration()).lastTest).toBeNull();
    expect((await ctx.sql("SELECT details->>'stale' AS stale FROM audit_log WHERE event = 'integration.slack_test_result' ORDER BY id")).rows).toEqual([{ stale: null }, { stale: 'true' }]);
  });
});
