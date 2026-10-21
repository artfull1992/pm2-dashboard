// Real PostgreSQL tests for the server registry and Agent heartbeat — ONLY the isolated test DB, per-run schema.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/auth/bootstrap.js';
import { agentTokenDigest, newAgentToken } from '../../src/auth/tokens.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { createPgServerStore, type ServerStore } from '../../src/servers/store.js';
import { legacySnapshot, validSnapshot } from '../support/fake-server-store.js';
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

interface Ctx { schema: string; db: Database; store: ServerStore; actor: { actorUserId: string; requestId: string }; sql: (q: string, v?: unknown[]) => Promise<pg.QueryResult> }

async function setup(poolMax = 10): Promise<Ctx> {
  const schema = newRunSchemaName();
  schemas.push(schema);
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  const db = createDatabase({ ...config, poolMax }, { error: () => undefined }, createPool({ ...config, poolMax }, { searchPath: schema }));
  databases.push(db);
  const boot = await bootstrapAdmin(db, { email: 'admin@example.test', passwordHash: 'scrypt$placeholder' });
  if (boot.status !== 'created') throw new Error('bootstrap failed');
  const sql = async (q: string, v: unknown[] = []) => {
    await admin.query(`SET search_path TO "${schema}"`);
    try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
  };
  return { schema, db, store: createPgServerStore(db), actor: { actorUserId: boot.userId, requestId: '00000000-0000-4000-8000-000000000000' }, sql };
}

async function createServer(ctx: Ctx, name = 'node-1'): Promise<string> {
  const created = await ctx.store.create({ name, ...ctx.actor });
  if (created === 'name_taken') throw new Error('unexpected');
  return created.id;
}

async function issue(ctx: Ctx, serverId: string) {
  const token = newAgentToken();
  const result = await ctx.store.issueCredential({ serverId, tokenHash: agentTokenDigest(token), ...ctx.actor });
  return { token, result };
}

describe('schema (migration 1791900000002)', () => {
  it('constraints and indexes match the queries', async () => {
    const ctx = await setup();
    const { rows: cons } = await admin.query(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE n.nspname = $1 AND r.relname IN ('servers', 'agent_credentials', 'server_heartbeats') AND c.contype <> 'n' ORDER BY 1`, [ctx.schema]);
    expect(cons.map((r: { conname: string }) => r.conname)).toEqual(expect.arrayContaining([
      'agent_credentials_revoked_after_creation', 'agent_credentials_server_id_fkey', 'agent_credentials_token_hash_key', 'agent_credentials_token_hash_len',
      'server_heartbeats_pkey', 'server_heartbeats_server_id_fkey', 'server_heartbeats_snapshot_object', 'servers_name_format', 'servers_name_key', 'servers_pkey',
    ]));
    const { rows: idx } = await admin.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'agent_credentials_one_active_idx'`, [ctx.schema]);
    expect((idx[0] as { indexdef: string } | undefined)?.indexdef).toMatch(/UNIQUE INDEX .* \(server_id\) WHERE \(revoked_at IS NULL\)/);
    await expect(ctx.sql(`INSERT INTO servers (name) VALUES (' padded ')`)).rejects.toMatchObject({ code: '23514' });
    await expect(ctx.sql(`INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES (gen_random_uuid(), now(), '{}')`)).rejects.toMatchObject({ code: '23503' });
  });
});

describe('provisioning (transactional, audited)', () => {
  it('create + issue store only a digest; rotation keeps exactly one active credential', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    expect(await ctx.store.create({ name: 'node-1', ...ctx.actor })).toBe('name_taken');
    const first = await issue(ctx, serverId);
    const second = await issue(ctx, serverId);
    expect(first.result).toMatchObject({ rotated: false });
    expect(second.result).toMatchObject({ rotated: true });
    const { rows } = await ctx.sql('SELECT encode(token_hash, \'hex\') AS h, revoked_at IS NULL AS active FROM agent_credentials ORDER BY created_at');
    expect(rows).toEqual([
      { h: agentTokenDigest(first.token).toString('hex'), active: false },
      { h: agentTokenDigest(second.token).toString('hex'), active: true },
    ]);
    const dump = JSON.stringify((await ctx.sql('SELECT * FROM agent_credentials')).rows) + JSON.stringify((await ctx.sql('SELECT * FROM audit_log')).rows);
    expect(dump).not.toContain(first.token);
    expect(dump).not.toContain(second.token);
    const { rows: audit } = await ctx.sql(`SELECT event, details FROM audit_log WHERE event <> 'admin.bootstrap' ORDER BY id`);
    expect(audit).toEqual([
      { event: 'server.created', details: { serverId } },
      { event: 'agent.credential_issued', details: { serverId, rotated: false } },
      { event: 'agent.credential_issued', details: { serverId, rotated: true } },
    ]);
  });

  it('concurrent rotations end with exactly one active credential and one audit row each', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    await Promise.all(Array.from({ length: 5 }, () => issue(ctx, serverId)));
    expect((await ctx.sql('SELECT count(*)::int AS n FROM agent_credentials WHERE revoked_at IS NULL')).rows[0]).toEqual({ n: 1 });
    expect((await ctx.sql(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'agent.credential_issued'`)).rows[0]).toEqual({ n: 5 });
  });

  it('audit failure rolls back create, issue and revoke', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    await ctx.sql('ALTER TABLE audit_log RENAME TO audit_log_offline');
    try {
      await expect(ctx.store.create({ name: 'node-2', ...ctx.actor })).rejects.toThrow();
      await expect(issue(ctx, serverId)).rejects.toThrow();
    } finally {
      await ctx.sql('ALTER TABLE audit_log_offline RENAME TO audit_log');
    }
    expect((await ctx.sql('SELECT count(*)::int AS n FROM servers')).rows[0]).toEqual({ n: 1 });
    expect((await ctx.sql('SELECT count(*)::int AS n FROM agent_credentials')).rows[0]).toEqual({ n: 0 });
    await issue(ctx, serverId);
    await ctx.sql('ALTER TABLE audit_log RENAME TO audit_log_offline');
    try {
      await expect(ctx.store.revokeCredential({ serverId, ...ctx.actor })).rejects.toThrow();
    } finally {
      await ctx.sql('ALTER TABLE audit_log_offline RENAME TO audit_log');
    }
    expect((await ctx.sql('SELECT count(*)::int AS n FROM agent_credentials WHERE revoked_at IS NULL')).rows[0]).toEqual({ n: 1 });
  });

  it('inactive and unknown servers', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    await ctx.sql('UPDATE servers SET is_active = false WHERE id = $1', [serverId]);
    expect((await issue(ctx, serverId)).result).toBe('inactive');
    expect(await ctx.store.revokeCredential({ serverId: '44444444-4444-4444-8444-444444444444', ...ctx.actor })).toBe('not_found');
  });
});

describe('heartbeat', () => {
  it('status: never_connected → online (server clock) → offline; upsert keeps one row', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    const { token } = await issue(ctx, serverId);
    expect((await ctx.store.get(serverId, null))?.status).toBe('never_connected');
    const first = await ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot({ loadAverage: [1, 0, 0] }) });
    const second = await ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot({ loadAverage: [2, 0, 0] }) });
    expect(first).toMatchObject({ serverId });
    expect(second).toMatchObject({ serverId });
    const detail = await ctx.store.get(serverId, null);
    expect(detail).toMatchObject({ status: 'online', snapshot: { loadAverage: [2, 0, 0] } });
    expect((await ctx.sql('SELECT count(*)::int AS n FROM server_heartbeats')).rows[0]).toEqual({ n: 1 });
    await ctx.sql(`UPDATE server_heartbeats SET received_at = now() - interval '91 seconds'`);
    expect((await ctx.store.get(serverId, null))?.status).toBe('offline');
  });

  it('revoked credential / inactive server → unauthorized, nothing changes', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    const { token } = await issue(ctx, serverId);
    await ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot({ loadAverage: [10, 0, 0] }) });
    const before = (await ctx.sql('SELECT received_at FROM server_heartbeats')).rows[0] as { received_at: Date };
    await ctx.store.revokeCredential({ serverId, ...ctx.actor });
    expect(await ctx.store.resolveAgent(agentTokenDigest(token))).toBeNull();
    expect(await ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot({ loadAverage: [20, 0, 0] }) })).toBe('unauthorized');
    const { token: fresh } = await issue(ctx, serverId);
    await ctx.sql('UPDATE servers SET is_active = false');
    expect(await ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(fresh), snapshot: validSnapshot({ loadAverage: [30, 0, 0] }) })).toBe('unauthorized');
    const after = (await ctx.sql('SELECT received_at, snapshot FROM server_heartbeats')).rows[0] as { received_at: Date; snapshot: { loadAverage: number[] } };
    expect(after.received_at.getTime()).toBe(before.received_at.getTime());
    expect(after.snapshot.loadAverage[0]).toBe(10);
  });

  it('a row written before ADR-023 (legacy host metrics in JSONB) is read through the current contract', async () => {
    const ctx = await setup();
    const serverId = await createServer(ctx);
    await ctx.sql('INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now(), $2::jsonb)', [serverId, JSON.stringify(legacySnapshot())]);
    const detail = await ctx.store.get(serverId, null);
    expect(detail?.snapshot).toEqual({ agentVersion: '0.4.0', hostname: 'node-1.example', platform: 'linux', arch: 'x64', loadAverage: [0.5, 0.4, 0.3] });
    await ctx.sql(`UPDATE server_heartbeats SET snapshot = '{"unexpected": true}'::jsonb`);
    expect((await ctx.store.get(serverId, null))?.snapshot).toBeNull(); // unreadable stored shape → "no data", not a crash
  });

  it('concurrent heartbeats: one row, latest server timestamp wins', async () => {
    const ctx = await setup(12);
    const serverId = await createServer(ctx);
    const { token } = await issue(ctx, serverId);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot({ loadAverage: [i, 0, 0] }) })));
    expect(results.every((r) => r !== 'unauthorized')).toBe(true);
    const { rows } = await ctx.sql('SELECT received_at FROM server_heartbeats');
    expect(rows).toHaveLength(1);
    const latest = Math.max(...results.map((r) => (r === 'unauthorized' ? 0 : r.receivedAt.getTime())));
    expect((rows[0] as { received_at: Date }).received_at.getTime()).toBe(latest);
  });

  it('revoke racing heartbeats: no heartbeat is accepted after the revoke committed', async () => {
    const ctx = await setup(12);
    const serverId = await createServer(ctx);
    const { token } = await issue(ctx, serverId);
    const hb = () => ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot() });
    await Promise.all([...Array.from({ length: 8 }, hb), ctx.store.revokeCredential({ serverId, ...ctx.actor }), ...Array.from({ length: 8 }, hb)]);
    const { rows } = await ctx.sql(
      `SELECT h.received_at <= c.revoked_at AS before_revoke FROM server_heartbeats h JOIN agent_credentials c ON c.server_id = h.server_id`);
    for (const row of rows as { before_revoke: boolean }[]) expect(row.before_revoke).toBe(true);
    expect(await hb()).toBe('unauthorized');
  });

  it('server identity is bound to the credential', async () => {
    const ctx = await setup();
    const a = await createServer(ctx, 'a');
    const b = await createServer(ctx, 'b');
    const { token } = await issue(ctx, a);
    const result = await ctx.store.recordHeartbeat({ tokenHash: agentTokenDigest(token), snapshot: validSnapshot() });
    expect(result).toMatchObject({ serverId: a });
    expect((await ctx.store.get(b, null))?.status).toBe('never_connected');
  });

  it('list paginates by (created_at, id)', async () => {
    const ctx = await setup();
    for (const name of ['a', 'b', 'c']) await createServer(ctx, name);
    const first = await ctx.store.list({ limit: 2, afterId: null, scope: null });
    expect(first.items.map((s) => s.name)).toEqual(['a', 'b']);
    const second = await ctx.store.list({ limit: 2, afterId: first.nextAfterId, scope: null });
    expect(second).toMatchObject({ items: [{ name: 'c' }], nextAfterId: null });
  });
});
