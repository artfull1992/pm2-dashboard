// Recovery notifications (ADR-021: "a recovery is sent only when the problem itself was announced") across the
// real admin paths that cancel queued items — replacing the webhook, switching delivery off — and a permanently
// failed problem message. Real PostgreSQL, ONLY the isolated test database (per-run schema); no network.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seal } from '../../src/alerts/secret.js';
import type { EvaluationConfig } from '../../src/alerts/settings.js';
import { createPgSettingsStore } from '../../src/alerts/settings-store.js';
import { AlertsEngine } from '../../src/alerts/engine.js';
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

async function setup(serverCount = 1) {
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
  const serverIds: string[] = [];
  for (let n = 0; n < serverCount; n++) {
    const id = ((await sql('INSERT INTO servers (name) VALUES ($1) RETURNING id', [`node-${String(n)}`])).rows[0] as { id: string }).id;
    await sql("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - interval '10 minutes', $2::jsonb)", [id, JSON.stringify(validSnapshot())]);
    serverIds.push(id);
  }
  const cfg = (generation: number, deliveryEnabled = true, reminderSeconds = 0): EvaluationConfig => {
    const d = ALERTS_DEFAULTS.defaults;
    return { thresholds: d.thresholds, cooldownSeconds: 0, reminderSeconds, queueMax: d.queueMax, deliveryEnabled, generation, rulesRevision: 1 };
  };
  const alerts = createPgAlertsStore(db);
  const kinds = async () => (await sql('SELECT kind, status, last_error FROM alert_outbox ORDER BY id')).rows as { kind: string; status: string; last_error: string | null }[];
  // Server(s) offline → the problem(s) queued for generation 1.
  expect(await alerts.evaluateOnce(cfg(1))).toMatchObject({ opened: serverCount, enqueued: serverCount });
  const recover = async (generation: number, servers: string[] = serverIds.slice(0, 1)) => {
    await sql('UPDATE server_heartbeats SET received_at = now() WHERE server_id = ANY($1::uuid[])', [servers]);
    return alerts.evaluateOnce(cfg(generation));
  };
  /** Outbox row of one kind for a server (its single incident). */
  const row = async (kind: string, server = serverIds[0]) => (await sql(
    `SELECT o.id::text AS id, o.status, o.last_error, o.attempts FROM alert_outbox o JOIN alert_incidents i ON i.id = o.incident_id
      WHERE o.kind = $1 AND i.server_id = $2`, [kind, server])).rows[0] as { id: string; status: string; last_error: string | null; attempts: number } | undefined;
  const claimed = async (generation = 1) => (await alerts.claim(5, generation)).map((c) => `${c.kind}:${String(serverIds.indexOf(c.incident.serverId))}`);
  return { sql, settings, actor, alerts, kinds, recover, row, claimed, serverIds, cfg };
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

// Review 2026-10-19 (P2): the recovery may never overtake its problem message — a dependency enforced by claim
// (through the real claim/finish path), whatever the backoff, lease or concurrency.
describe('delivery order of one incident: the recovery waits for its problem message', () => {
  it('problem deferred by backoff: the recovery is not claimable; after the problem is sent it is', async () => {
    const t = await setup();
    await t.sql("UPDATE alert_outbox SET next_attempt_at = now() + interval '10 minutes'");
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 1 });
    expect(await t.claimed()).toEqual([]);
    await t.sql("UPDATE alert_outbox SET next_attempt_at = now() WHERE kind = 'firing'");
    const [firing] = await t.alerts.claim(5, 1);
    expect(firing?.kind).toBe('firing');
    expect(await t.claimed()).toEqual([]); // problem in flight
    if (firing) expect(await t.alerts.finish(firing, { status: 'sent' })).toBe(true);
    expect(await t.claimed()).toEqual(['resolved:0']);
    expect(await t.claimed()).toEqual([]); // claimed once
  });

  it('problem in flight, then its lease expires: only the problem is claimed again, never the recovery first', async () => {
    const t = await setup();
    expect(await t.claimed()).toEqual(['firing:0']);
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 1 });
    expect(await t.claimed()).toEqual([]);
    await t.sql("UPDATE alert_outbox SET lease_until = now() - interval '1 second' WHERE kind = 'firing'");
    expect(await t.claimed()).toEqual(['firing:0']);
  });

  it('problem retried after a transient error and then sent: one recovery, after it', async () => {
    const t = await setup();
    const [firing] = await t.alerts.claim(5, 1);
    if (!firing) throw new Error('no item');
    expect(await t.recover(1)).toMatchObject({ enqueued: 1 });
    expect(await t.alerts.finish(firing, { status: 'queued', code: 'http_500', delaySeconds: 0 })).toBe(true);
    expect(await t.claimed()).toEqual(['firing:0']);
    await t.sql("UPDATE alert_outbox SET status = 'sent', finished_at = now(), lease_until = NULL WHERE kind = 'firing'");
    expect(await t.claimed()).toEqual(['resolved:0']);
  });

  it.each([
    ['failed permanently', { status: 'failed' as const, code: 'channel_not_found' }],
    ['ended unknown (may have been delivered)', { status: 'unknown' as const, code: 'timeout' }],
  ])('problem %s while the recovery waited', async (_name, outcome) => {
    const t = await setup();
    const [firing] = await t.alerts.claim(5, 1);
    if (!firing) throw new Error('no item');
    expect(await t.recover(1)).toMatchObject({ enqueued: 1 });
    await t.alerts.finish(firing, outcome);
    if (outcome.status === 'unknown') {
      expect(await t.claimed()).toEqual(['resolved:0']);
    } else {
      // Never announced → the recovery is cancelled (terminal), not left waiting forever and not sent.
      expect(await t.claimed()).toEqual([]);
      expect(await t.row('resolved')).toMatchObject({ status: 'cancelled', last_error: 'problem_not_announced' });
    }
  });

  it('problem cancelled while the recovery waited (e.g. an admin path or a retired rule): the recovery is cancelled', async () => {
    const t = await setup();
    await t.sql("UPDATE alert_outbox SET next_attempt_at = now() + interval '10 minutes'");
    expect(await t.recover(1)).toMatchObject({ enqueued: 1 });
    await t.sql("UPDATE alert_outbox SET status = 'cancelled', finished_at = now(), last_error = 'rule_retired' WHERE kind = 'firing'");
    expect(await t.claimed()).toEqual([]);
    expect(await t.row('resolved')).toMatchObject({ status: 'cancelled', last_error: 'problem_not_announced' });
  });

  it('concurrent claims never hand out a recovery before its problem; an independent incident is not blocked', async () => {
    const t = await setup(2);
    // Incident 0: problem deferred, recovery queued. Incident 1: problem already sent, recovery queued.
    await t.sql(`UPDATE alert_outbox o SET next_attempt_at = now() + interval '10 minutes' FROM alert_incidents i WHERE i.id = o.incident_id AND i.server_id = $1`, [t.serverIds[0]]);
    await t.sql(`UPDATE alert_outbox o SET status = 'sent', finished_at = now() FROM alert_incidents i WHERE i.id = o.incident_id AND i.server_id = $1`, [t.serverIds[1]]);
    expect(await t.recover(1, t.serverIds)).toMatchObject({ resolved: 2, enqueued: 2 });
    const [a, b] = await Promise.all([t.claimed(), t.claimed()]);
    expect([...a, ...b]).toEqual(['resolved:1']);
    await t.sql("UPDATE alert_outbox SET next_attempt_at = now() WHERE status = 'queued'");
    const [c, d] = await Promise.all([t.claimed(), t.claimed()]);
    expect([...c, ...d]).toEqual(['firing:0']);
    // Repeated evaluations and claims: no duplicates.
    expect(await t.recover(1, t.serverIds)).toMatchObject({ resolved: 0, enqueued: 0 });
    expect((await t.kinds()).length).toBe(4);
  });
});

// Review 2026-10-19 (P2): the right to a recovery belongs to the generation the problem was announced in.
describe('generation scope: a recovery only follows a problem announced to the same channel', () => {
  it.each([
    ['sent', "status = 'sent', finished_at = now()"],
    ['unknown', "status = 'unknown', finished_at = now(), last_error = 'timeout'"],
  ])('problem %s in generation 1, webhook replaced → no recovery for generation 2; history kept', async (_n, set) => {
    const t = await setup();
    await t.sql(`UPDATE alert_outbox SET ${set}`);
    const replaced = await t.settings.configureSlack({ expectedGeneration: 1, seal: (g) => seal(WEBHOOK(2), g, KEY), actor: t.actor });
    expect(replaced).toMatchObject({ status: 'configured', generation: 2, cancelled: 0 });
    expect(await t.recover(2)).toMatchObject({ resolved: 1, enqueued: 0 });
    expect(await t.claimed(2)).toEqual([]);
    expect(await t.row('firing')).toMatchObject({ status: _n });
    expect(await t.recover(2)).toMatchObject({ resolved: 0, enqueued: 0 });
  });

  it('integration removed and configured again: no recovery for the problem announced to the old channel', async () => {
    const t = await setup();
    await t.sql("UPDATE alert_outbox SET status = 'sent', finished_at = now()");
    expect(await t.settings.removeSlack({ expectedGeneration: 1, actor: t.actor })).toMatchObject({ status: 'removed', generation: 2 });
    expect(await t.settings.configureSlack({ expectedGeneration: 2, seal: (g) => seal(WEBHOOK(3), g, KEY), actor: t.actor })).toMatchObject({ generation: 3 });
    expect(await t.recover(3)).toMatchObject({ resolved: 1, enqueued: 0 });
    expect(await t.claimed(3)).toEqual([]);
  });

  it('problem in flight when the webhook is replaced: cancelled, and no recovery to the new channel', async () => {
    const t = await setup();
    expect(await t.claimed()).toEqual(['firing:0']);
    expect(await t.settings.configureSlack({ expectedGeneration: 1, seal: (g) => seal(WEBHOOK(2), g, KEY), actor: t.actor })).toMatchObject({ cancelled: 1 });
    expect(await t.recover(2)).toMatchObject({ resolved: 1, enqueued: 0 });
    expect(await t.claimed(2)).toEqual([]);
  });

  it('problem and recovery in the same (new) generation work as usual', async () => {
    const t = await setup();
    await t.sql("UPDATE alert_outbox SET status = 'sent', finished_at = now()");
    await t.settings.configureSlack({ expectedGeneration: 1, seal: (g) => seal(WEBHOOK(2), g, KEY), actor: t.actor });
    // The first incident recovers silently; a new outage in generation 2 is announced and recovered in generation 2.
    expect(await t.recover(2)).toMatchObject({ enqueued: 0 });
    await t.sql("UPDATE server_heartbeats SET received_at = now() - interval '10 minutes'");
    expect(await t.alerts.evaluateOnce(t.cfg(2))).toMatchObject({ opened: 1, enqueued: 1 });
    expect(await t.claimed(2)).toEqual(['firing:0']);
    await t.sql("UPDATE alert_outbox SET status = 'sent', finished_at = now(), lease_until = NULL WHERE generation = 2");
    expect(await t.recover(2)).toMatchObject({ resolved: 1, enqueued: 1 });
    expect(await t.claimed(2)).toEqual(['resolved:0']);
  });
});

// Review 2026-10-19 (second, P2): a reminder ("still ongoing") of an incident that has been resolved never starts a new
// delivery attempt — not after a retryable result, not after an expired lease — and never holds the recovery back by its
// retries. The attempt already in flight is not recalled (its HTTP request may be out); only future attempts stop.
describe('reminder of a resolved incident: no further attempts', () => {
  /** Problem sent, then a due reminder of the same generation queued (server still offline). */
  async function withReminder(servers = 1) {
    const t = await setup(servers);
    await t.sql("UPDATE alert_outbox SET status = 'sent', finished_at = now(), created_at = now() - interval '2 hours'");
    expect(await t.alerts.evaluateOnce(t.cfg(1, true, 60))).toMatchObject({ enqueued: servers });
    return t;
  }
  const claimOne = async (t: Awaited<ReturnType<typeof withReminder>>, kind: string) => {
    const items = await t.alerts.claim(5, 1);
    const found = items.find((i) => i.kind === kind);
    if (!found) throw new Error(`no ${kind} claimed`);
    return found;
  };

  it.each([0, 600])('in flight during the resolve, then a retryable result (delay %i s): cancelled, the recovery is free at once', async (delaySeconds) => {
    const t = await withReminder();
    const reminder = await claimOne(t, 'reminder');
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 1 });
    expect(await t.claimed()).toEqual([]); // the current attempt is still in flight: the recovery waits for it only
    expect(await t.alerts.finish(reminder, { status: 'queued', code: 'http_500', delaySeconds })).toBe(true);
    expect(await t.row('reminder')).toMatchObject({ status: 'cancelled', last_error: 'superseded' });
    expect(await t.claimed()).toEqual(['resolved:0']);
    expect(await t.claimed()).toEqual([]);
  });

  it('in flight during the resolve, lease expired: not reclaimed; cancelled; a late finish does not revive it', async () => {
    const t = await withReminder();
    const reminder = await claimOne(t, 'reminder');
    expect(await t.recover(1)).toMatchObject({ enqueued: 1 });
    await t.sql("UPDATE alert_outbox SET lease_until = now() - interval '1 second' WHERE kind = 'reminder'");
    expect(await t.claimed()).toEqual(['resolved:0']);
    expect(await t.row('reminder')).toMatchObject({ status: 'cancelled', last_error: 'superseded' });
    for (const outcome of [{ status: 'queued' as const, code: 'http_500', delaySeconds: 0 }, { status: 'sent' as const }]) {
      expect(await t.alerts.finish(reminder, outcome)).toBe(false); // ownership: the claim no longer owns it
    }
    expect(await t.row('reminder')).toMatchObject({ status: 'cancelled' });
    expect(await t.claimed()).toEqual([]);
  });

  it.each([
    ['sent', { status: 'sent' as const }],
    ['unknown (last attempt)', { status: 'unknown' as const, code: 'timeout' }],
    ['failed', { status: 'failed' as const, code: 'channel_not_found' }],
  ])('in flight during the resolve, final result %s: recorded as is (the attempt happened), the recovery follows', async (_n, outcome) => {
    const t = await withReminder();
    const reminder = await claimOne(t, 'reminder');
    expect(await t.recover(1)).toMatchObject({ enqueued: 1 });
    expect(await t.alerts.finish(reminder, outcome)).toBe(true);
    expect(await t.row('reminder')).toMatchObject({ status: outcome.status });
    expect(await t.claimed()).toEqual(['resolved:0']);
  });

  it('controlled order: retry recorded BEFORE the resolve → the resolve cancels the queued reminder; reclaim never happens', async () => {
    const t = await withReminder();
    const reminder = await claimOne(t, 'reminder');
    expect(await t.alerts.finish(reminder, { status: 'queued', code: 'http_500', delaySeconds: 0 })).toBe(true);
    expect(await t.row('reminder')).toMatchObject({ status: 'queued' });
    expect(await t.recover(1)).toMatchObject({ enqueued: 1 });
    expect(await t.row('reminder')).toMatchObject({ status: 'cancelled', last_error: 'superseded' });
    expect(await t.claimed()).toEqual(['resolved:0']);
  });

  it('controlled order: a queued reminder whose incident was resolved behind the cleanup (e.g. by an older release) is cancelled by claim', async () => {
    const t = await withReminder();
    await t.sql("UPDATE alert_incidents SET status = 'resolved', resolution = 'recovered', resolved_at = now()");
    expect(await t.claimed()).toEqual([]);
    expect(await t.row('reminder')).toMatchObject({ status: 'cancelled', last_error: 'superseded' });
  });

  it('a reminder of an ACTIVE incident is delivered and retried as usual; another incident is never blocked', async () => {
    const t = await withReminder(2);
    const first = await t.alerts.claim(5, 1);
    expect(first.map((i) => i.kind).sort()).toEqual(['reminder', 'reminder']);
    // Incident 0 recovers while its reminder is in flight; incident 1 stays active.
    expect(await t.recover(1)).toMatchObject({ resolved: 1, enqueued: 1 });
    for (const i of first) expect(await t.alerts.finish(i, { status: 'queued', code: 'http_500', delaySeconds: 0 })).toBe(true);
    expect(await t.row('reminder', t.serverIds[0])).toMatchObject({ status: 'cancelled', last_error: 'superseded' });
    expect(await t.row('reminder', t.serverIds[1])).toMatchObject({ status: 'queued', last_error: 'http_500' });
    expect((await t.claimed()).sort()).toEqual(['reminder:1', 'resolved:0']);
  });

  it('worker: a reminder answered 500 while the incident resolves → no second reminder request; the recovery is sent next', async () => {
    const t = await withReminder();
    const texts: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const text = (JSON.parse(init?.body as string) as { text: string }).text;
      texts.push(text.split('\n')[0] ?? '');
      if (text.includes('Досі триває')) { await t.recover(1); return new Response('', { status: 500 }); }
      return new Response('ok');
    }) as unknown as typeof fetch;
    const webhook = WEBHOOK(1);
    const rt = { load: async () => ({ settings: { ...(await t.settings.getSettings()), deliveryEnabled: true, maxAttempts: 6 }, integration: { generation: 1, state: 'configured' as const, error: null, webhook } }) };
    const engine = new AlertsEngine(t.alerts, rt, null, { info: () => undefined, warn: () => undefined, error: () => undefined }, { fetchImpl, sleep: () => Promise.resolve() });
    await engine.deliverNow();
    await engine.deliverNow();
    await engine.deliverNow();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/Досі триває/);
    expect(texts[1]).toMatch(/Відновлено/);
    expect(await t.row('reminder')).toMatchObject({ status: 'cancelled', last_error: 'superseded' });
    expect(await t.row('resolved')).toMatchObject({ status: 'sent' });
  });
});
