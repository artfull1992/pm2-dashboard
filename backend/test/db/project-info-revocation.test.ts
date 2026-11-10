// Review ad41717 (P2): a project information save must never be written on the strength of an admin check that a
// concurrent revocation has already invalidated. Real PostgreSQL (isolated per-run schema), the real stores of every
// revocation path — role change and deactivation (users-store), logout and password change (auth store) — and
// controlled barriers instead of sleeps:
//   - a separate transaction holds the metadata row (or an uncommitted INSERT of the same key, for the first save), so
//     the save is provably waiting AFTER its authorisation;
//   - a revocation transaction is paused right before its commit;
//   - "is waiting for a lock" is read from pg_stat_activity by the backend pid of that very transaction.
// Allowed outcomes only: the save authorised first commits before the revocation (which waits for it), or a revocation
// committed first makes the save fail (actor_revoked) with the metadata and the audit trail untouched.
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAccessStore } from '../../src/auth/access-store.js';
import { createPgAuthStore } from '../../src/auth/store.js';
import { createPgUserStore } from '../../src/auth/users-store.js';
import type { DbConfig } from '../../src/config.js';
import { createDatabase, createPool, type Database, type QueryClient } from '../../src/database.js';
import { migrateUp } from '../../src/migrations.js';
import { createPgProjectInfoStore, type SaveProjectInfoResult } from '../../src/servers/project-info-store.js';
import { connectTestClient, createRunSchema, dropRunSchema, newRunSchemaName, readTestDbEnv, testDbConfig } from '../support/test-db.js';

const noLog = { error: () => undefined };
const WAIT_MS = 5_000;
let config: DbConfig;
let admin: pg.Client;
let schema: string;
let db: Database;
const clients: pg.Client[] = [];

const sql = async (q: string, v: unknown[] = []) => {
  await admin.query(`SET search_path TO "${schema}"`);
  try { return await admin.query(q, v); } finally { await admin.query('RESET search_path'); }
};

beforeAll(async () => {
  config = testDbConfig(readTestDbEnv());
  admin = await connectTestClient(config);
  schema = newRunSchemaName();
  await createRunSchema(admin, schema);
  const client = await connectTestClient(config);
  try { await migrateUp(client, { schema }); } finally { await client.end(); }
  db = createDatabase({ ...config, poolMax: 10 }, noLog, createPool({ ...config, poolMax: 10 }, { searchPath: schema }));
});

afterAll(async () => {
  for (const c of clients) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); }
  await db.close();
  await dropRunSchema(admin, schema); // only this run's schema
  await admin.end();
});

/**
 * The same database with one observable transaction: its backend pid, and optionally a pause AFTER the first query
 * matching `pauseAfter` (the transaction then waits for `release()` before going on to COMMIT).
 */
function traced(pauseAfter?: RegExp) {
  let pid!: (n: number) => void;
  const pidP = new Promise<number>((r) => { pid = r; });
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => { reached = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let paused = false;
  const wrapped: Database = {
    ...db,
    transaction: (fn) => db.transaction(async (tx) => {
      pid((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? -1);
      const client: QueryClient = {
        query: async (q, v) => {
          const result = await tx.query(q, v);
          if (pauseAfter && !paused && pauseAfter.test(q)) { paused = true; reached(); await gate; }
          return result as never;
        },
      };
      return fn(client);
    }),
  };
  return { db: wrapped, pid: pidP, reached: reachedP, release };
}

/** Resolves once backend `pid` waits for a lock; rejects if `op` settles first or nothing waits within WAIT_MS. */
async function waitsForLock(pid: Promise<number>, op: Promise<unknown>, what: string): Promise<void> {
  const id = await pid;
  const op$ = { settled: false };
  void op.then(() => { op$.settled = true; }, () => { op$.settled = true; });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = (await admin.query<{ wait_event_type: string | null }>('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [id])).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    if (op$.settled) throw new Error(`${what} completed instead of waiting for the lock (not serialized)`);
    if (Date.now() > deadline) throw new Error(`${what} did not wait for a lock within ${String(WAIT_MS)} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Both operations must settle (no deadlock, no hang) within the bound. */
async function bothSettle<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('operations did not finish (deadlock or hang)')); }, WAIT_MS * 2); });
  try { return await Promise.race([Promise.all([a, b]), limit]); } finally { clearTimeout(timer); }
}

/** Ends a test's own transactions and waits for its operations, whatever the assertions did (no leaked locks). */
async function cleanup(locker: pg.Client | null, ops: Promise<unknown>[], release?: () => void): Promise<void> {
  release?.();
  if (locker) await locker.query('ROLLBACK').catch(() => undefined);
  await Promise.allSettled(ops);
}

async function lockClient(): Promise<pg.Client> {
  const c = await connectTestClient(config);
  clients.push(c);
  await c.query(`SET search_path TO "${schema}"`);
  return c;
}

interface Fixture { victim: { userId: string; sessionId: string }; boss: { userId: string; sessionId: string }; serverId: string; credentialVersion: number }

async function user(role: 'admin' | 'operator') {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await sql('INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)', [userId, `u-${userId.slice(0, 8)}@example.test`, 'scrypt$synthetic-not-for-login', role]);
  await sql("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [sessionId, userId, randomBytes(32)]);
  return { userId, sessionId };
}

async function fixture(withRow: boolean): Promise<Fixture> {
  const victim = await user('admin');
  const boss = await user('admin'); // the admin who demotes / deactivates the victim
  const serverId = randomUUID();
  await sql('INSERT INTO servers (id, name) VALUES ($1, $2)', [serverId, `srv-${serverId.slice(0, 8)}`]);
  await sql("INSERT INTO server_inventories (server_id, state, reported_at) VALUES ($1, 'ok', now())", [serverId]);
  await sql("INSERT INTO server_applications (server_id, source, pm_id, name, status, first_seen_at) VALUES ($1, 'pm2', 0, 'api', 'online', now())", [serverId]);
  if (withRow) await sql("INSERT INTO application_project_info (server_id, service_name, revision, description) VALUES ($1, 'api', 1, 'before')", [serverId]);
  const v = (await sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [victim.userId])).rows[0] as { v: number };
  return { victim, boss, serverId, credentialVersion: v.v };
}

type Kind = 'role' | 'deactivate' | 'logout' | 'password';
const EVENT: Record<Kind, string> = { role: 'user.role_changed', deactivate: 'user.deactivated', logout: 'auth.logout', password: 'auth.password_change' };
/** The last statement of each revocation before its audit row (where a paused revocation waits to commit). */
const LAST_WRITE: Record<Kind, RegExp> = { role: /INSERT INTO audit_log/, deactivate: /INSERT INTO audit_log/, logout: /INSERT INTO audit_log/, password: /INSERT INTO audit_log/ };

/** The real revocation operation of `kind` against `database` (its own transaction). */
async function revoke(kind: Kind, f: Fixture, database: Database): Promise<void> {
  const requestId = randomUUID();
  if (kind === 'role' || kind === 'deactivate') {
    const r = await createPgUserStore(database).updateUser({ actor: f.boss, targetId: f.victim.userId, ...(kind === 'role' ? { role: 'viewer' as const } : { isActive: false }), requestId });
    expect(r.status).toBe('updated');
  } else if (kind === 'logout') {
    expect(await createPgAuthStore(database).revokeSession({ sessionId: f.victim.sessionId, userId: f.victim.userId, requestId })).toBe(true);
  } else {
    const r = await createPgAuthStore(database).changePassword({ userId: f.victim.userId, expectedVersion: f.credentialVersion, passwordHash: 'scrypt$synthetic-new', requestId });
    expect(r.status).toBe('changed');
  }
}

const save = (f: Fixture, database: Database, expectedRevision: number, description = 'after'): Promise<SaveProjectInfoResult> =>
  createPgProjectInfoStore(database).save({
    actor: f.victim, serverId: f.serverId, serviceName: 'api', expectedRevision, value: { githubUrl: null, projectUrl: null, description }, requestId: randomUUID(),
  });
const metadata = async (serverId: string) => (await sql('SELECT description, revision::int AS revision FROM application_project_info WHERE server_id = $1', [serverId])).rows as { description: string; revision: number }[];
/** Audit rows of this fixture, in insertion order: the save's success row and the revocation's row. */
async function trail(f: Fixture, kind: Kind) {
  const { rows } = await sql(
    `SELECT event FROM audit_log
      WHERE (event = 'application.project_info_changed' AND details->>'serverId' = $1)
         OR (event = $2 AND (actor_user_id::text = $3 OR details->>'targetUserId' = $3))
      ORDER BY id`, [f.serverId, EVENT[kind], f.victim.userId]);
  return rows.map((r: { event: string }) => r.event);
}

const KINDS: Kind[] = ['role', 'deactivate', 'logout', 'password'];

describe('save authorised first: the revocation waits for it', () => {
  // Codex's scenario: the save has passed its admin check and waits for the metadata row; the revocation starts now.
  it.each(KINDS)('%s — existing row: the save commits first, the revocation then commits; a further save is refused', async (kind) => {
    const f = await fixture(true);
    const locker = await lockClient();
    await locker.query('BEGIN');
    await locker.query("SELECT 1 FROM application_project_info WHERE server_id = $1 AND service_name = 'api' FOR UPDATE", [f.serverId]);
    const s = traced();
    const saving = save(f, s.db, 1);
    const r = traced();
    let revoking: Promise<void> = Promise.resolve();
    let saved: SaveProjectInfoResult;
    try {
      await waitsForLock(s.pid, saving, 'save'); // past the authorisation, waiting for the metadata row
      revoking = revoke(kind, f, r.db);
      await waitsForLock(r.pid, revoking, `${kind} revocation`); // must wait for the save's locks on the admin/session
      await locker.query('COMMIT');
      [saved] = await bothSettle(saving, revoking);
    } finally {
      await cleanup(locker, [saving, revoking]);
    }
    expect(saved.status).toBe('ok');
    expect(await metadata(f.serverId)).toEqual([{ description: 'after', revision: 2 }]);
    expect(await trail(f, kind)).toEqual(['application.project_info_changed', EVENT[kind]]); // the save before the revocation
    // After the revocation committed, the next attempt is refused and changes nothing.
    expect((await save(f, db, 2, 'later')).status).toBe('actor_revoked');
    expect(await metadata(f.serverId)).toEqual([{ description: 'after', revision: 2 }]);
    expect(await trail(f, kind)).toEqual(['application.project_info_changed', EVENT[kind]]);
  });

  it.each(KINDS)('%s — first save (no row yet): the save waiting on a concurrent insert of the same key keeps the admin locked', async (kind) => {
    const f = await fixture(false);
    const locker = await lockClient();
    await locker.query('BEGIN');
    await locker.query("INSERT INTO application_project_info (server_id, service_name, revision, description) VALUES ($1, 'api', 1, 'other')", [f.serverId]);
    const s = traced();
    const saving = save(f, s.db, 0);
    const r = traced();
    let revoking: Promise<void> = Promise.resolve();
    let saved: SaveProjectInfoResult;
    try {
      await waitsForLock(s.pid, saving, 'first save');
      revoking = revoke(kind, f, r.db);
      await waitsForLock(r.pid, revoking, `${kind} revocation`);
      await locker.query('ROLLBACK'); // the competing insert disappears: this save inserts revision 1
      [saved] = await bothSettle(saving, revoking);
    } finally {
      await cleanup(locker, [saving, revoking]);
    }
    expect(saved.status).toBe('ok');
    expect(await metadata(f.serverId)).toEqual([{ description: 'after', revision: 1 }]);
    expect(await trail(f, kind)).toEqual(['application.project_info_changed', EVENT[kind]]);
    expect((await save(f, db, 1, 'later')).status).toBe('actor_revoked');
  });
});

describe('revocation first: the save is refused without any change', () => {
  it.each(KINDS)('%s — already committed before the save', async (kind) => {
    const f = await fixture(true);
    await revoke(kind, f, db);
    expect((await save(f, db, 1)).status).toBe('actor_revoked');
    expect(await metadata(f.serverId)).toEqual([{ description: 'before', revision: 1 }]);
    expect(await trail(f, kind)).toEqual([EVENT[kind]]);
  });

  it.each(KINDS)('%s — in progress (paused before COMMIT): the save waits for it and is then refused', async (kind) => {
    const f = await fixture(true);
    const r = traced(LAST_WRITE[kind]);
    const revoking = revoke(kind, f, r.db);
    await r.reached; // the revocation has written its changes and holds its locks, uncommitted
    const s = traced();
    const saving = save(f, s.db, 1);
    let saved: SaveProjectInfoResult;
    try {
      await waitsForLock(s.pid, saving, 'save');
      r.release();
      [saved] = await bothSettle(saving, revoking);
    } finally {
      await cleanup(null, [saving, revoking], r.release);
    }
    expect(saved.status).toBe('actor_revoked');
    expect(await metadata(f.serverId)).toEqual([{ description: 'before', revision: 1 }]);
    expect(await trail(f, kind)).toEqual([EVENT[kind]]);
  });

  it('a first save after a committed revocation creates no row', async () => {
    const f = await fixture(false);
    await revoke('role', f, db);
    expect((await save(f, db, 0)).status).toBe('actor_revoked');
    expect(await metadata(f.serverId)).toEqual([]);
  });
});

describe('locks are limited to the acting admin and the session', () => {
  it('while a save waits, other users are changed, log in and log out without waiting', async () => {
    const f = await fixture(true);
    const bystander = await user('operator');
    const locker = await lockClient();
    await locker.query('BEGIN');
    await locker.query("SELECT 1 FROM application_project_info WHERE server_id = $1 AND service_name = 'api' FOR UPDATE", [f.serverId]);
    const s = traced();
    const saving = save(f, s.db, 1);
    try {
    await waitsForLock(s.pid, saving, 'save');
    const users = createPgUserStore(db);
    const auth = createPgAuthStore(db);
    const others = (async () => {
      expect((await users.updateUser({ actor: f.boss, targetId: bystander.userId, role: 'viewer', requestId: randomUUID() })).status).toBe('updated');
      const fresh = (await sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [bystander.userId])).rows[0] as { v: number };
      expect(await auth.createSession({ userId: bystander.userId, credentialVersion: fresh.v, tokenHash: randomBytes(32), ttlSeconds: 3600, previousTokenHash: null, requestId: randomUUID() })).not.toBeNull();
      // The acting admin can still sign in elsewhere (login reads its row FOR SHARE, like the save).
      const own = (await sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [f.victim.userId])).rows[0] as { v: number };
      expect(await auth.createSession({ userId: f.victim.userId, credentialVersion: own.v, tokenHash: randomBytes(32), ttlSeconds: 3600, previousTokenHash: null, requestId: randomUUID() })).not.toBeNull();
    })();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([others, new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('unrelated operations waited for the save')); }, WAIT_MS); })]);
    clearTimeout(timer);
    await locker.query('COMMIT');
    expect((await saving).status).toBe('ok');
    } finally {
      await cleanup(locker, [saving]);
    }
  });
});

// ── Scoped operators (permission applications:metadata:write + the grant of the service) ──────────────────────────
// The same barriers for an operator: besides role, activity, logout and password, the grant itself is revoked through
// the real access administration (saveAccess) — the server grant removed, «all» narrowed to «selected» without this
// service, or this service removed from «selected». Allowed outcomes only, as above.

type OpKind = 'role' | 'deactivate' | 'logout' | 'password' | 'grant_removed' | 'all_to_selected' | 'service_removed';
const OP_EVENT: Record<OpKind, string> = { ...EVENT, grant_removed: 'access.updated', all_to_selected: 'access.updated', service_removed: 'access.updated' };
/** What a save gets once the revocation committed: no session any more (401) or no grant of the service (404). */
const OP_REFUSAL: Record<OpKind, SaveProjectInfoResult['status']> = {
  role: 'actor_revoked', deactivate: 'actor_revoked', logout: 'actor_revoked', password: 'actor_revoked',
  grant_removed: 'not_found', all_to_selected: 'not_found', service_removed: 'not_found',
};
/** The grant the operator starts with: «all» on the server, or «selected» with both services. */
const OP_START: Record<OpKind, 'all' | 'selected'> = {
  role: 'all', deactivate: 'all', logout: 'selected', password: 'selected', grant_removed: 'selected', all_to_selected: 'all', service_removed: 'selected',
};

async function opFixture(kind: OpKind, withRow: boolean): Promise<Fixture> {
  const f = await fixture(withRow);
  await sql("UPDATE users SET role = 'operator' WHERE id = $1", [f.victim.userId]);
  await sql("INSERT INTO server_applications (server_id, source, pm_id, name, status, first_seen_at) VALUES ($1, 'pm2', 1, 'other', 'online', now())", [f.serverId]);
  await sql('INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, $3)', [f.victim.userId, f.serverId, OP_START[kind]]);
  if (OP_START[kind] === 'selected') {
    await sql("INSERT INTO user_service_access (user_id, server_id, service_name) SELECT $1, $2, n FROM unnest(ARRAY['api', 'other']) AS n", [f.victim.userId, f.serverId]);
  }
  const v = (await sql('SELECT credential_version::int AS v FROM users WHERE id = $1', [f.victim.userId])).rows[0] as { v: number };
  return { ...f, credentialVersion: v.v };
}

async function opRevoke(kind: OpKind, f: Fixture, database: Database): Promise<void> {
  if (kind === 'role' || kind === 'deactivate' || kind === 'logout' || kind === 'password') { await revoke(kind, f, database); return; }
  const revision = ((await sql('SELECT access_revision::int AS r FROM users WHERE id = $1', [f.victim.userId])).rows[0] as { r: number }).r;
  const servers = kind === 'grant_removed' ? [] : [{ serverId: f.serverId, mode: 'selected' as const, services: ['other'] }];
  const r = await createPgAccessStore(database).saveAccess({ actor: f.boss, userId: f.victim.userId, expectedRevision: revision, servers, requestId: randomUUID() });
  expect(r.status).toBe('ok');
}

async function opTrail(f: Fixture, kind: OpKind) {
  const { rows } = await sql(
    `SELECT event FROM audit_log
      WHERE (event = 'application.project_info_changed' AND details->>'serverId' = $1)
         OR (event = $2 AND (actor_user_id::text = $3 OR details->>'targetUserId' = $3))
      ORDER BY id`, [f.serverId, OP_EVENT[kind], f.victim.userId]);
  return rows.map((r: { event: string }) => r.event);
}

const OP_KINDS: OpKind[] = ['role', 'deactivate', 'logout', 'password', 'grant_removed', 'all_to_selected', 'service_removed'];

describe('operator: save authorised first, the revocation waits for it', () => {
  it.each(OP_KINDS.flatMap((k) => [[k, true], [k, false]] as [OpKind, boolean][]))('%s — %s row: the save commits first; a further save is refused', async (kind, withRow) => {
    const f = await opFixture(kind, withRow);
    const locker = await lockClient();
    await locker.query('BEGIN');
    if (withRow) await locker.query("SELECT 1 FROM application_project_info WHERE server_id = $1 AND service_name = 'api' FOR UPDATE", [f.serverId]);
    else await locker.query("INSERT INTO application_project_info (server_id, service_name, revision, description) VALUES ($1, 'api', 1, 'other')", [f.serverId]);
    const s = traced();
    const saving = save(f, s.db, withRow ? 1 : 0);
    const r = traced();
    let revoking: Promise<void> = Promise.resolve();
    let saved: SaveProjectInfoResult;
    try {
      await waitsForLock(s.pid, saving, 'save'); // authorised (user, session, grant held), waiting for the metadata
      revoking = opRevoke(kind, f, r.db);
      await waitsForLock(r.pid, revoking, `${kind} revocation`);
      await locker.query(withRow ? 'COMMIT' : 'ROLLBACK');
      [saved] = await bothSettle(saving, revoking);
    } finally {
      await cleanup(locker, [saving, revoking]);
    }
    expect(saved.status).toBe('ok');
    expect(await metadata(f.serverId)).toEqual([{ description: 'after', revision: withRow ? 2 : 1 }]);
    expect(await opTrail(f, kind)).toEqual(['application.project_info_changed', OP_EVENT[kind]]);
    expect((await save(f, db, withRow ? 2 : 1, 'later')).status).toBe(OP_REFUSAL[kind]);
    expect(await metadata(f.serverId)).toEqual([{ description: 'after', revision: withRow ? 2 : 1 }]);
    expect(await opTrail(f, kind)).toEqual(['application.project_info_changed', OP_EVENT[kind]]);
  });
});

describe('operator: revocation first, the save is refused without any change', () => {
  it.each(OP_KINDS)('%s — already committed', async (kind) => {
    const f = await opFixture(kind, true);
    await opRevoke(kind, f, db);
    expect((await save(f, db, 1)).status).toBe(OP_REFUSAL[kind]);
    expect(await metadata(f.serverId)).toEqual([{ description: 'before', revision: 1 }]);
    expect(await opTrail(f, kind)).toEqual([OP_EVENT[kind]]);
  });

  it.each(OP_KINDS)('%s — in progress (paused before COMMIT): the save waits for it and is then refused', async (kind) => {
    const f = await opFixture(kind, true);
    const r = traced(/INSERT INTO audit_log/);
    const revoking = opRevoke(kind, f, r.db);
    await r.reached;
    const s = traced();
    const saving = save(f, s.db, 1);
    let saved: SaveProjectInfoResult;
    try {
      await waitsForLock(s.pid, saving, 'save');
      r.release();
      [saved] = await bothSettle(saving, revoking);
    } finally {
      await cleanup(null, [saving, revoking], r.release);
    }
    expect(saved.status).toBe(OP_REFUSAL[kind]);
    expect(await metadata(f.serverId)).toEqual([{ description: 'before', revision: 1 }]);
    expect(await opTrail(f, kind)).toEqual([OP_EVENT[kind]]);
  });

  it('a first save after a committed grant removal creates no row', async () => {
    const f = await opFixture('grant_removed', false);
    await opRevoke('grant_removed', f, db);
    expect((await save(f, db, 0)).status).toBe('not_found');
    expect(await metadata(f.serverId)).toEqual([]);
  });
});

describe('operator: grant changes of ANOTHER user do not wait for the save', () => {
  it('while an operator\'s save waits, an admin changes another operator\'s grants on the same server without waiting; the save then succeeds', async () => {
    const f = await opFixture('service_removed', true);
    const locker = await lockClient();
    await locker.query('BEGIN');
    await locker.query("SELECT 1 FROM application_project_info WHERE server_id = $1 AND service_name = 'api' FOR UPDATE", [f.serverId]);
    const s = traced();
    const saving = save(f, s.db, 1);
    try {
      await waitsForLock(s.pid, saving, 'save');
      // Another operator's grants change meanwhile: unrelated rows, nothing waits.
      const other = await user('operator');
      const revision = ((await sql('SELECT access_revision::int AS r FROM users WHERE id = $1', [other.userId])).rows[0] as { r: number }).r;
      const changed = createPgAccessStore(db).saveAccess({ actor: f.boss, userId: other.userId, expectedRevision: revision, servers: [{ serverId: f.serverId, mode: 'all', services: [] }], requestId: randomUUID() });
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([changed, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('another user\'s grants waited for the save')); }, WAIT_MS); })]);
      clearTimeout(timer);
      expect(result.status).toBe('ok');
      await locker.query('COMMIT');
      expect((await saving).status).toBe('ok');
    } finally {
      await cleanup(locker, [saving]);
    }
  });
});

describe('operator: the grant rows themselves are held (defence in depth)', () => {
  // saveAccess always locks the target user row first, which the save already holds, so it is serialized by that
  // lock alone. A writer that removes the grant rows WITHOUT touching the user row must wait for the save as well.
  it.each(['server', 'service'] as const)('a direct DELETE of the %s grant waits for the authorised save', async (which) => {
    const f = await opFixture('service_removed', true); // «selected»: api + other
    const locker = await lockClient();
    await locker.query('BEGIN');
    await locker.query("SELECT 1 FROM application_project_info WHERE server_id = $1 AND service_name = 'api' FOR UPDATE", [f.serverId]);
    const s = traced();
    const saving = save(f, s.db, 1);
    const deleter = await lockClient();
    let deleting: Promise<unknown> = Promise.resolve();
    try {
      await waitsForLock(s.pid, saving, 'save');
      const pid = (await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? -1;
      deleting = which === 'server'
        ? deleter.query('DELETE FROM user_server_access WHERE user_id = $1 AND server_id = $2', [f.victim.userId, f.serverId])
        : deleter.query("DELETE FROM user_service_access WHERE user_id = $1 AND server_id = $2 AND service_name = 'api'", [f.victim.userId, f.serverId]);
      await waitsForLock(Promise.resolve(pid), deleting, `${which} grant delete`);
      await locker.query('COMMIT');
      const [saved] = await bothSettle(saving, deleting);
      expect(saved.status).toBe('ok');
    } finally {
      await cleanup(locker, [saving, deleting]);
    }
    expect(await metadata(f.serverId)).toEqual([{ description: 'after', revision: 2 }]);
    expect((await save(f, db, 2, 'later')).status).toBe('not_found');
  });
});
