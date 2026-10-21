// Real PostgreSQL tests for allowlisted PM2 control (Task 009, ADR-017) — ONLY the isolated test DB, per-run schema.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { agentTokenDigest, newAgentToken } from '../../src/auth/tokens.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import type { ControlTarget, PollReport, ResultReport } from '../../src/servers/control.js';
import { type ControlStore, createPgControlStore } from '../../src/servers/control-store.js';
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
  servers: ServerStore; control: ControlStore; adminId: string; operatorId: string;
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
  const op = await sql(`INSERT INTO users (email, password_hash, role) VALUES ('op@example.test', 'scrypt$placeholder', 'operator') RETURNING id`);
  return { servers: createPgServerStore(db), control: createPgControlStore(db), adminId: boot.userId, operatorId: (op.rows[0] as { id: string }).id, sql };
}

async function node(ctx: Ctx, name: string, heartbeat = true) {
  const created = await ctx.servers.create({ name, actorUserId: ctx.adminId, requestId: randomUUID() });
  if (created === 'name_taken') throw new Error('unexpected');
  const token = newAgentToken();
  await ctx.servers.issueCredential({ serverId: created.id, tokenHash: agentTokenDigest(token), actorUserId: ctx.adminId, requestId: randomUUID() });
  const tokenHash = agentTokenDigest(token);
  if (heartbeat) await ctx.servers.recordHeartbeat({ tokenHash, snapshot: validSnapshot() });
  // ADR-028: the operator who requests commands in these tests is granted the whole server.
  await ctx.sql(`INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, 'all')`, [ctx.operatorId, created.id]);
  return { serverId: created.id, tokenHash };
}

const target = (key = 'api', overrides: Partial<ControlTarget> = {}): ControlTarget => ({ targetKey: key, name: key, pmId: 1, actions: ['start', 'stop', 'restart'], matchStatus: 'ok', ...overrides });
const report = (targets: ControlTarget[] = [target()]): PollReport => ({ version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets });
const create = (ctx: Ctx, serverId: string, over: Partial<{ targetKey: string; action: 'start' | 'stop' | 'restart'; idempotencyKey: string; actorUserId: string }> = {}) =>
  ctx.control.createCommand({
    serverId, targetKey: 'api', action: 'restart', idempotencyKey: randomUUID(), actorUserId: ctx.operatorId, requestId: randomUUID(), ...over,
    actorRole: (over.actorUserId ?? ctx.operatorId) === ctx.adminId ? 'admin' : 'operator',
  });
const result = (commandId: string, over: Partial<ResultReport> = {}): ResultReport =>
  ({ version: 1, commandId, attempt: 1, outcome: 'succeeded', reason: null, before: { status: 'online' }, after: { status: 'online' }, ...over });
const events = async (ctx: Ctx, commandId: string) =>
  (await ctx.sql(`SELECT event FROM audit_log WHERE details->>'commandId' = $1 ORDER BY id`, [commandId])).rows.map((r: { event: string }) => r.event);
const commandId = (r: Awaited<ReturnType<ControlStore['createCommand']>>) => { if (typeof r === 'string') throw new Error(r); return r.command.id; };

describe('schema (migration 1791900000004)', () => {
  it('constraints reject invalid commands and targets', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    const bad: string[] = [
      `INSERT INTO control_commands (server_id, target_key, action, requested_by, idempotency_key, requested_at, deadline_at) VALUES ($1, 'api', 'delete', $2, gen_random_uuid(), now(), now() + interval '1 minute')`,
      `INSERT INTO control_commands (server_id, target_key, action, requested_by, idempotency_key, requested_at, deadline_at) VALUES ($1, 'API *', 'stop', $2, gen_random_uuid(), now(), now() + interval '1 minute')`,
      `INSERT INTO control_commands (server_id, target_key, action, requested_by, idempotency_key, requested_at, deadline_at, status) VALUES ($1, 'api', 'stop', $2, gen_random_uuid(), now(), now() + interval '1 minute', 'succeeded')`,
      `INSERT INTO control_commands (server_id, target_key, action, requested_by, idempotency_key, requested_at, deadline_at) VALUES ($1, 'api', 'stop', $2, gen_random_uuid(), now(), now())`,
      `INSERT INTO control_commands (server_id, target_key, action, requested_by, idempotency_key, requested_at, deadline_at, status, attempts) VALUES ($1, 'api', 'stop', $2, gen_random_uuid(), now(), now() + interval '1 minute', 'dispatched', 1)`,
    ];
    for (const q of bad) await expect(ctx.sql(q, [n.serverId, ctx.operatorId])).rejects.toMatchObject({ code: '23514' });
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: false });
    await expect(ctx.sql(`UPDATE server_control_targets SET actions = ARRAY['delete'] WHERE server_id = $1`, [n.serverId])).rejects.toMatchObject({ code: '23514' });
    await expect(ctx.sql(`UPDATE server_control_targets SET pm_id = NULL WHERE server_id = $1`, [n.serverId])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('command creation', () => {
  it('requires an online server and a freshly reported, matching target with the action allowed', async () => {
    const ctx = await setup();
    const offline = await node(ctx, 'off', false);
    expect(await create(ctx, offline.serverId)).toBe('server_offline');
    const n = await node(ctx, 'n');
    expect(await create(ctx, n.serverId)).toBe('target_unavailable'); // never reported
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api', { actions: ['restart'] }), target('db', { matchStatus: 'fingerprint_mismatch', pmId: null })]), controlEnabled: false });
    expect(await create(ctx, n.serverId, { action: 'stop' })).toBe('action_not_allowed');
    expect(await create(ctx, n.serverId, { targetKey: 'db' })).toBe('target_unavailable');
    expect(await create(ctx, n.serverId, { targetKey: 'nope' })).toBe('target_unavailable');
    await ctx.sql(`UPDATE server_control_status SET reported_at = now() - interval '61 seconds'`);
    expect(await create(ctx, n.serverId)).toBe('target_unavailable'); // stale report
    expect(await create(ctx, '11111111-1111-4111-8111-111111111111')).toBe('not_found');
  });

  it('idempotency: same key + same request → same command; same key + other request → conflict; one active per target', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: false });
    const key = randomUUID();
    const first = await create(ctx, n.serverId, { idempotencyKey: key });
    const replay = await create(ctx, n.serverId, { idempotencyKey: key });
    expect(typeof first !== 'string' && first.created).toBe(true);
    expect(typeof replay !== 'string' && !replay.created && replay.command.id === commandId(first)).toBe(true);
    expect(await create(ctx, n.serverId, { idempotencyKey: key, action: 'stop' })).toBe('idempotency_conflict');
    expect(await create(ctx, n.serverId)).toBe('command_in_progress'); // different key, same target, one still active
    expect(typeof (await create(ctx, n.serverId, { targetKey: 'worker' }))).not.toBe('string');
    // Another user may use the same key value: keys are scoped to the actor.
    expect(typeof (await create(ctx, n.serverId, { idempotencyKey: key, actorUserId: ctx.adminId, targetKey: 'worker' }))).toBe('string');
    expect(await events(ctx, commandId(first))).toEqual(['process.command_requested']);
  });

  it('concurrent requests: one command per key, one active per target', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: false });
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 6 }, () => create(ctx, n.serverId, { idempotencyKey: key })));
    expect(new Set(same.map((r) => (typeof r === 'string' ? r : r.command.id))).size).toBe(1);
    expect(same.filter((r) => typeof r !== 'string' && r.created)).toHaveLength(1);
    const others = await Promise.all(Array.from({ length: 4 }, () => create(ctx, n.serverId)));
    expect(others.every((r) => r === 'command_in_progress')).toBe(true);
    const { rows } = await ctx.sql('SELECT count(*)::int AS n FROM control_commands');
    expect(rows[0]).toEqual({ n: 1 });
  });

  it('if the audit row cannot be written, no command exists (same transaction)', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: false });
    await ctx.sql(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`);
    await ctx.sql(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.event = 'process.command_requested') EXECUTE FUNCTION fail_audit()`);
    await expect(create(ctx, n.serverId)).rejects.toThrow();
    const { rows } = await ctx.sql('SELECT count(*)::int AS n FROM control_commands');
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe('delivery lifecycle', () => {
  it('claim → dispatched (lease, one executor) → result recorded with audit; duplicates and conflicts', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true });
    const a = commandId(await create(ctx, n.serverId));
    const b = commandId(await create(ctx, n.serverId, { targetKey: 'worker' }));
    expect(await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: false })).toEqual({ commands: [] }); // disabled: nothing
    const p1 = await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true });
    expect(p1).toMatchObject({ commands: [{ id: a, attempt: 1, targetKey: 'api', action: 'restart' }] });
    // One executor per server: b is not handed out while a holds a valid lease.
    expect(await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true })).toEqual({ commands: [] });
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(a) })).toBe('recorded');
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(a) })).toBe('duplicate');
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(a, { outcome: 'failed', reason: 'pm2_error' }) })).toBe('conflict');
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(b) })).toBe('conflict'); // b never dispatched
    expect(await ctx.control.getCommand(a, null)).toMatchObject({ status: 'succeeded', attempts: 1, before: { status: 'online' }, after: { status: 'online' } });
    expect(await events(ctx, a)).toEqual(['process.command_requested', 'process.command_dispatched', 'process.command_succeeded']);
    expect(await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true })).toMatchObject({ commands: [{ id: b }] });
  });

  it('server binding: another server cannot fetch or confirm the command; revoked credential → unauthorized', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    const m = await node(ctx, 'm');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true });
    const a = commandId(await create(ctx, n.serverId));
    expect(await ctx.control.poll({ tokenHash: m.tokenHash, report: report(), controlEnabled: true })).toEqual({ commands: [] });
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true });
    expect(await ctx.control.recordResult({ tokenHash: m.tokenHash, result: result(a) })).toBe('not_found');
    await ctx.servers.revokeCredential({ serverId: n.serverId, actorUserId: ctx.adminId, requestId: randomUUID() });
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(a) })).toBe('unauthorized');
    expect(await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true })).toBe('unauthorized');
  });

  it('at claim time the requester must still be active with processes:control, and the target still ok', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker'), target('db')]), controlEnabled: true });
    const a = commandId(await create(ctx, n.serverId));
    await ctx.sql(`UPDATE users SET role = 'viewer' WHERE id = $1`, [ctx.operatorId]);
    expect(await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker'), target('db')]), controlEnabled: true })).toEqual({ commands: [] });
    expect(await ctx.control.getCommand(a, null)).toMatchObject({ status: 'rejected', reason: 'actor_not_authorized' });
    await ctx.sql(`UPDATE users SET role = 'operator' WHERE id = $1`, [ctx.operatorId]);
    const b = commandId(await create(ctx, n.serverId, { targetKey: 'worker' }));
    await ctx.sql(`UPDATE users SET is_active = false WHERE id = $1`, [ctx.operatorId]);
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker'), target('db')]), controlEnabled: true });
    expect(await ctx.control.getCommand(b, null)).toMatchObject({ status: 'rejected', reason: 'actor_not_authorized' });
    await ctx.sql(`UPDATE users SET is_active = true WHERE id = $1`, [ctx.operatorId]);
    const c = commandId(await create(ctx, n.serverId, { targetKey: 'db' }));
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker'), target('db', { matchStatus: 'fingerprint_mismatch', pmId: null })]), controlEnabled: true });
    expect(await ctx.control.getCommand(c, null)).toMatchObject({ status: 'rejected', reason: 'target_unavailable' });
    expect(await events(ctx, c)).toEqual(['process.command_requested', 'process.command_rejected']);
  });

  it('deadlines: queued → expired; lost delivery → redelivered with the same id (≤ 3); no result → unknown; a late confirmed result reconciles', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true });
    const q = commandId(await create(ctx, n.serverId, { targetKey: 'worker' }));
    await ctx.sql(`UPDATE control_commands SET requested_at = now() - interval '10 minutes', deadline_at = now() - interval '1 second' WHERE id = $1`, [q]);
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true });
    expect(await ctx.control.getCommand(q, null)).toMatchObject({ status: 'expired', reason: 'not_dispatched', attempts: 0 });

    const a = commandId(await create(ctx, n.serverId));
    const tick = () => ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api'), target('worker')]), controlEnabled: true });
    expect((await tick())).toMatchObject({ commands: [{ id: a, attempt: 1 }] });
    for (const attempt of [2, 3]) {
      await ctx.sql(`UPDATE control_commands SET lease_until = now() - interval '1 second' WHERE id = $1`, [a]);
      expect(await tick()).toMatchObject({ commands: [{ id: a, attempt }] }); // same command id → broker dedup
    }
    await ctx.sql(`UPDATE control_commands SET lease_until = now() - interval '1 second' WHERE id = $1`, [a]);
    expect(await tick()).toEqual({ commands: [] }); // no 4th delivery
    await ctx.sql(`UPDATE control_commands SET requested_at = now() - interval '10 minutes', deadline_at = now() - interval '121 seconds' WHERE id = $1`, [a]);
    await tick();
    expect(await ctx.control.getCommand(a, null)).toMatchObject({ status: 'unknown', reason: 'no_result' });
    // The broker journal later yields the real result: it replaces unknown/no_result.
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(a, { attempt: 2 }) })).toBe('recorded');
    expect(await ctx.control.getCommand(a, null)).toMatchObject({ status: 'succeeded' });
    expect(await events(ctx, a)).toEqual(['process.command_requested', 'process.command_dispatched', 'process.command_dispatched', 'process.command_dispatched', 'process.command_unknown', 'process.command_succeeded']);
  });

  it('a redelivery whose re-check fails is not delivered (it may have run) and ends as unknown, never rejected', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true });
    const a = commandId(await create(ctx, n.serverId));
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true });
    await ctx.sql(`UPDATE control_commands SET lease_until = now() - interval '1 second' WHERE id = $1`, [a]);
    await ctx.sql(`UPDATE users SET role = 'viewer' WHERE id = $1`, [ctx.operatorId]);
    expect(await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true })).toEqual({ commands: [] });
    expect(await ctx.control.getCommand(a, null)).toMatchObject({ status: 'dispatched' });
  });

  it('concurrent polls of one server hand out a command once', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'n');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true });
    const a = commandId(await create(ctx, n.serverId));
    const polls = await Promise.all(Array.from({ length: 8 }, () => ctx.control.poll({ tokenHash: n.tokenHash, report: report(), controlEnabled: true })));
    const delivered = polls.flatMap((p) => (p === 'unauthorized' ? [] : p.commands));
    expect(delivered.map((c) => c.id)).toEqual([a]);
  });
});
