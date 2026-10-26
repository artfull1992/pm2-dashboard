// Real PostgreSQL tests for the readable audit context (ADR-033) — ONLY the isolated test DB, per-run schema.
// GET /api/audit's store resolves, per page and in ONE query: the actor's e-mail, the server name, the target user's
// e-mail and the control command (requester, its stored service name) — with LEFT JOINs on primary keys, so no row
// is dropped or duplicated, a damaged id in details yields null (no SQL error), a command is linked only when its id,
// server and target match. New command / log audit rows carry the verified service name.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { type AuditEvent, createPgAuthStore, insertAudit } from '../../src/auth/store.js';
import { agentTokenDigest, newAgentToken } from '../../src/auth/tokens.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import type { ControlTarget, PollReport, ResultReport } from '../../src/servers/control.js';
import { createPgControlStore } from '../../src/servers/control-store.js';
import { createPgServerStore } from '../../src/servers/store.js';
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

const LONG_EMAIL = 'operator.with.a.rather.long.address.for.layout@example.test';

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
  const sql = async (q: string, v: unknown[] = []) => {
    await admin.query(`SET search_path TO "${schema}"`);
    try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
  };
  const op = await sql(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'scrypt$placeholder', 'operator') RETURNING id`, [LONG_EMAIL]);
  // Count queries of the audit store (N+1 check): a proxy over the same database.
  let queries = 0;
  const counted = new Proxy(db, {
    get: (t, k, r): unknown => (k === 'query' ? (...a: Parameters<Database['query']>) => { queries += 1; return t.query(...a); } : Reflect.get(t, k, r)),
  });
  return {
    db, sql, auth: createPgAuthStore(counted), control: createPgControlStore(db), servers: createPgServerStore(db),
    adminId: boot.userId, operatorId: (op.rows[0] as { id: string }).id, queries: () => queries,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function node(ctx: Ctx, name: string) {
  const created = await ctx.servers.create({ name, actorUserId: ctx.adminId, requestId: randomUUID() });
  if (created === 'name_taken') throw new Error('unexpected');
  const tokenHash = agentTokenDigest(newAgentToken());
  await ctx.servers.issueCredential({ serverId: created.id, tokenHash, actorUserId: ctx.adminId, requestId: randomUUID() });
  await ctx.servers.recordHeartbeat({ tokenHash, snapshot: validSnapshot() });
  return { serverId: created.id, tokenHash };
}
const target = (key: string, name: string): ControlTarget => ({ targetKey: key, name, pmId: 1, actions: ['start', 'stop', 'restart'], matchStatus: 'ok' });
const report = (targets: ControlTarget[]): PollReport => ({ version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets });
const result = (commandId: string): ResultReport => ({ version: 1, commandId, attempt: 1, outcome: 'succeeded', reason: null, before: { status: 'online' }, after: { status: 'online' } });
const add = (ctx: Ctx, entry: AuditEvent, actorUserId: string | null = null) => insertAudit(ctx.db, entry, { actorUserId, requestId: null });

describe('readable audit context', () => {
  it('command lifecycle: the requester is linked to system rows; stored service and server names; the actor e-mail of the request', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'node-a');
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api', 'orders-api')]), controlEnabled: false });
    const created = await ctx.control.createCommand({ serverId: n.serverId, targetKey: 'api', action: 'restart', idempotencyKey: randomUUID(), actorUserId: ctx.adminId, requestId: randomUUID(), actorRole: 'admin' });
    if (typeof created === 'string') throw new Error(created);
    const cmd = created.command.id;
    await ctx.control.poll({ tokenHash: n.tokenHash, report: report([target('api', 'orders-api')]), controlEnabled: true });
    expect(await ctx.control.recordResult({ tokenHash: n.tokenHash, result: result(cmd) })).toBe('recorded');

    const page = await ctx.auth.listAudit({ limit: 50, beforeId: null });
    const of = (event: string) => page.items.find((i) => i.event === event && i.details.commandId === cmd);
    const requested = of('process.command_requested');
    const dispatched = of('process.command_dispatched');
    const done = of('process.command_succeeded');
    // The verified service name (stored with the command at request time) is in the new audit rows themselves.
    for (const row of [requested, dispatched, done]) expect(row?.details).toMatchObject({ serviceName: 'orders-api', targetKey: 'api', action: 'restart' });
    const linked = { requestedBy: ctx.adminId, requestedByEmail: 'admin@example.test', serviceName: 'orders-api' };
    expect(requested?.actorUserId).toBe(ctx.adminId);
    expect(requested?.context).toEqual({ actorEmail: 'admin@example.test', serverName: 'node-a', targetUserEmail: null, command: linked });
    // A system step: the row has no actor; the requester comes from the linked command (a different fact).
    expect(done?.actorUserId).toBeNull();
    expect(done?.context).toEqual({ actorEmail: null, serverName: 'node-a', targetUserEmail: null, command: linked });
    expect(dispatched?.context.command).toEqual(linked);
  });

  it('old rows and broken links: no SQL error, no lost or duplicated row, nothing invented', async () => {
    const ctx = await setup();
    const a = await node(ctx, 'node-a');
    const b = await node(ctx, 'node-b');
    // A command created before service names were stored (service_name NULL), with an opaque auto-mode key.
    const opaque = 'n-0123456789abcdef01234567';
    const old = await ctx.sql(`INSERT INTO control_commands (server_id, target_key, action, requested_by, idempotency_key, requested_at, deadline_at, status, completed_at)
      VALUES ($1, $2, 'stop', $3, gen_random_uuid(), now(), now() + interval '1 minute', 'succeeded', now()) RETURNING id`, [a.serverId, opaque, ctx.operatorId]);
    const oldId = (old.rows[0] as { id: string }).id;
    const startId = (await ctx.sql('SELECT coalesce(max(id), 0)::text AS id FROM audit_log')).rows[0] as { id: string };
    await add(ctx, { event: 'process.command_succeeded', outcome: 'success', details: { serverId: a.serverId, commandId: oldId, targetKey: opaque, action: 'stop' } });
    await add(ctx, { event: 'process.command_succeeded', outcome: 'success', details: { serverId: b.serverId, commandId: oldId, targetKey: opaque, action: 'stop' } }); // wrong server
    await add(ctx, { event: 'process.command_succeeded', outcome: 'success', details: { serverId: a.serverId, commandId: oldId, targetKey: 'other', action: 'stop' } }); // wrong target
    await add(ctx, { event: 'logs.view_opened', outcome: 'success', details: { serverId: a.serverId, targetKey: 'n-aaaaaaaaaaaaaaaaaaaaaaaa' } }, ctx.operatorId); // old log row, no name
    await add(ctx, { event: 'server.created', outcome: 'success', details: { serverId: 'not-a-uuid' } }, ctx.adminId); // damaged id
    await add(ctx, { event: 'agent.credential_issued', outcome: 'success', details: { serverId: randomUUID(), rotated: false } }, ctx.adminId); // server gone
    await add(ctx, { event: 'user.role_changed', outcome: 'success', details: { targetUserId: ctx.operatorId, fromRole: 'viewer', toRole: 'operator', sessionsRevoked: 0 } }, ctx.adminId);
    await add(ctx, { event: 'user.activated', outcome: 'success', details: { targetUserId: "x'; DROP TABLE users; --", sessionsRevoked: 0 } }, ctx.adminId); // not a uuid
    await add(ctx, { event: 'auth.login', outcome: 'success' }); // no actor at all
    await add(ctx, { event: 'process.command_unknown', outcome: 'failure', details: { serverId: a.serverId, commandId: randomUUID(), targetKey: 'api', action: 'restart' } }); // command gone

    const total = Number(((await ctx.sql('SELECT count(*) AS n FROM audit_log')).rows[0] as { n: string }).n);
    const page = await ctx.auth.listAudit({ limit: 100, beforeId: null });
    expect(page.items).toHaveLength(total); // nothing dropped
    expect(new Set(page.items.map((i) => i.id)).size).toBe(total); // nothing duplicated
    const ids = page.items.map((i) => BigInt(i.id));
    expect(ids).toEqual([...ids].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0))); // id DESC kept

    const rows = page.items.filter((i) => BigInt(i.id) > BigInt(startId.id)).reverse(); // the ten rows above, in insert order
    expect(rows).toHaveLength(10);
    expect(rows[0]?.context).toEqual({ actorEmail: null, serverName: 'node-a', targetUserEmail: null, command: { requestedBy: ctx.operatorId, requestedByEmail: LONG_EMAIL, serviceName: null } });
    expect(rows[1]?.context.command).toBeNull(); // the command's server does not match the event
    expect(rows[1]?.context.serverName).toBe('node-b');
    expect(rows[2]?.context.command).toBeNull(); // the command's target does not match the event
    expect(rows[3]?.context).toEqual({ actorEmail: LONG_EMAIL, serverName: 'node-a', targetUserEmail: null, command: null });
    expect(rows[3]?.details).not.toHaveProperty('serviceName'); // nothing invented for an old row
    expect(rows[4]?.context.serverName).toBeNull(); // damaged id → null, no SQL error
    expect(rows[5]?.context.serverName).toBeNull(); // missing server
    expect(rows[6]?.context.targetUserEmail).toBe(LONG_EMAIL);
    expect(rows[7]?.context.targetUserEmail).toBeNull();
    expect(rows[8]?.context).toEqual({ actorEmail: null, serverName: null, targetUserEmail: null, command: null });
    expect(rows[9]?.context.command).toBeNull(); // the command no longer exists
    expect(Number(((await ctx.sql('SELECT count(*) AS n FROM users')).rows[0] as { n: string }).n)).toBe(2); // nothing executed from details
  });

  it('one query per page (no N+1); cursor and limit by id with ids above MAX_SAFE_INTEGER; nothing secret in the answer', async () => {
    const ctx = await setup();
    const n = await node(ctx, 'node-a');
    await ctx.sql('ALTER TABLE audit_log ALTER COLUMN id RESTART WITH 9007199254740990');
    for (let k = 0; k < 30; k += 1) {
      await add(ctx, { event: 'logs.view_opened', outcome: 'success', details: { serverId: n.serverId, targetKey: 'api', serviceName: `svc-${String(k)}` } }, ctx.operatorId);
    }
    const before = ctx.queries();
    const first = await ctx.auth.listAudit({ limit: 25, beforeId: null });
    expect(ctx.queries() - before).toBe(1);
    expect(first.items).toHaveLength(25);
    expect(first.items[0]?.details.serviceName).toBe('svc-29');
    expect(first.items[0]?.context).toEqual({ actorEmail: LONG_EMAIL, serverName: 'node-a', targetUserEmail: null, command: null });
    expect(first.nextBeforeId).toBe(first.items.at(-1)?.id);
    expect(BigInt(first.items[0]?.id ?? '0')).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const second = await ctx.auth.listAudit({ limit: 25, beforeId: first.nextBeforeId });
    expect(ctx.queries() - before).toBe(2);
    const logs = [...first.items, ...second.items].filter((i) => i.event === 'logs.view_opened');
    expect(logs.map((i) => i.details.serviceName)).toEqual(Array.from({ length: 30 }, (_, k) => `svc-${String(29 - k)}`));
    expect(JSON.stringify([first, second])).not.toMatch(/scrypt|password|token_hash|placeholder/i);
  });
});
