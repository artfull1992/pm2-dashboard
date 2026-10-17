// Recovery notifications (ADR-021: "a recovery is sent only when the problem itself was announced") across the
// real admin paths that cancel queued items — replacing the webhook, switching delivery off — and a permanently
// failed problem message. Real PostgreSQL, ONLY the isolated test database (per-run schema); no network.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seal } from '../../src/alerts/secret.js';
import type { EvaluationConfig } from '../../src/alerts/settings.js';
import { createPgSettingsStore } from '../../src/alerts/settings-store.js';
import { createPgAlertsStore } from '../../src/alerts/store.js';
import { ALERTS_DEFAULTS, type DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { validSnapshot } from '../support/fake-server-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const noLog = { error: () => undefined };
const WEBHOOK = (n: number) => `https://hooks.slack.com/services/T0SYNTH0${String(n)}/B0SYNTH06/${'k'.repeat(24)}`;
const KEY = { version: 1, key: Buffer.alloc(32, 7) };
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
  const db: Database = createDatabase(config, noLog, createPool(config, { searchPath: schema }));
  closers.push(() => db.close());
  const raw = await connectTestClient(config);
  await raw.query(`SET search_path TO "${schema}"`);
  closers.push(() => raw.end());
  const sql = (q: string, v: unknown[] = []) => raw.query(q, v);
  const userId = ((await sql("INSERT INTO users (email, password_hash, role) VALUES ('adm@example.test', 'x', 'admin') RETURNING id")).rows[0] as { id: string }).id;
  const settings = createPgSettingsStore(db);
  await settings.initialize(ALERTS_DEFAULTS.defaults);
  const actor = { userId, requestId: randomUUID() };
  const configured = await settings.configureSlack({ expectedGeneration: 0, seal: (g) => seal(WEBHOOK(1), g, KEY), actor });
  if (configured.status !== 'configured') throw new Error('setup');
  const serverId = ((await sql('INSERT INTO servers (name) VALUES ($1) RETURNING id', ['node'])).rows[0] as { id: string }).id;
  await sql("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - interval '10 minutes', $2::jsonb)", [serverId, JSON.stringify(validSnapshot())]);
  const cfg = (generation: number, deliveryEnabled = true): EvaluationConfig => {
    const d = ALERTS_DEFAULTS.defaults;
    return { thresholds: d.thresholds, cooldownSeconds: 0, reminderSeconds: 0, queueMax: d.queueMax, deliveryEnabled, generation, rulesRevision: 1 };
  };
  const alerts = createPgAlertsStore(db);
  const kinds = async () => (await sql('SELECT kind, status, last_error FROM alert_outbox ORDER BY id')).rows as { kind: string; status: string; last_error: string | null }[];
  // Server offline → the problem is queued for generation 1.
  expect(await alerts.evaluateOnce(cfg(1))).toMatchObject({ opened: 1, enqueued: 1 });
  const recover = async (generation: number) => {
    await sql('UPDATE server_heartbeats SET received_at = now() WHERE server_id = $1', [serverId]);
    return alerts.evaluateOnce(cfg(generation));
  };
  return { sql, settings, actor, alerts, kinds, recover };
}

describe('recovery only for an announced problem', () => {
  it('webhook replaced while the problem was queued: the problem is cancelled and its recovery is not sent to the new channel', async () => {
    const t = await setup();
    const replaced = await t.settings.configureSlack({ expectedGeneration: 1, seal: (g) => seal(WEBHOOK(2), g, KEY), actor: t.actor });
    expect(replaced).toMatchObject({ status: 'configured', generation: 2, cancelled: 1 });
    expect(await t.recover(2)).toMatchObject({ resolved: 1, enqueued: 0 });
    expect(await t.kinds()).toEqual([{ kind: 'firing', status: 'cancelled', last_error: 'integration_changed' }]);
  });

  it('delivery switched off while the problem was queued, then on again: no recovery for the never-sent problem', async () => {
    const t = await setup();
    const off = await t.settings.updateSettings({ expectedRevision: 1, patch: { deliveryEnabled: true }, actor: t.actor });
    const rev = off.status === 'updated' ? off.settings.revision : 1;
    await t.settings.updateSettings({ expectedRevision: rev, patch: { deliveryEnabled: false }, actor: t.actor });
    await t.settings.updateSettings({ expectedRevision: rev + 1, patch: { deliveryEnabled: true }, actor: t.actor });
    expect((await t.kinds())[0]).toMatchObject({ kind: 'firing', status: 'cancelled', last_error: 'delivery_disabled' });
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 0 });
    expect(await t.kinds()).toHaveLength(1);
  });

  it('problem message failed permanently (never delivered): no recovery', async () => {
    const t = await setup();
    await t.sql("UPDATE alert_outbox SET status = 'failed', finished_at = now(), last_error = 'channel_not_found'");
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 0 });
    expect(await t.kinds()).toHaveLength(1);
  });

  it.each([
    ['sent', "status = 'sent', finished_at = now()"],
    ['still queued (announced after it, in order)', "status = 'queued'"],
    ['unknown (may have been delivered)', "status = 'unknown', finished_at = now(), last_error = 'timeout'"],
  ])('problem %s → exactly one recovery is queued', async (_n, set) => {
    const t = await setup();
    await t.sql(`UPDATE alert_outbox SET ${set}`);
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 1 });
    expect((await t.kinds()).map((k) => k.kind)).toEqual(['firing', 'resolved']);
  });
});
