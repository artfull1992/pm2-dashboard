import type { Database, QueryClient } from '../database.js';
import type { Role } from './rbac.js';
import { insertAudit } from './store.js';

// User administration (ADR-019). Every mutation is one short transaction that
//   1. takes `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` — serializes all writes to users (admin mutations,
//      password changes, bootstrap) without blocking reads or logins (FOR SHARE);
//   2. re-checks the ACTOR under that lock: its session is still valid and it is still an active admin — so a
//      concurrently demoted/deactivated admin cannot commit late;
//   3. changes the target, bumps credential_version, revokes ALL of the target's sessions and writes the audit rows.
// Lock order: users table → users rows → sessions (the same order as login and password change: no cycles).

export interface UserView {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActorRef {
  userId: string;
  sessionId: string;
}

export type CreateUserResult = { status: 'created'; user: UserView } | { status: 'email_taken' } | { status: 'actor_revoked' };
export type UpdateUserResult =
  | { status: 'updated'; user: UserView; changed: boolean }
  | { status: 'not_found' } | { status: 'actor_revoked' } | { status: 'self_change' } | { status: 'last_admin' };

export interface UserStore {
  listUsers(input: { limit: number; after: string | null }): Promise<{ items: UserView[]; nextAfter: string | null }>;
  createUser(input: { actor: ActorRef; email: string; passwordHash: string; role: Role; requestId: string }): Promise<CreateUserResult>;
  updateUser(input: { actor: ActorRef; targetId: string; role?: Role; isActive?: boolean; requestId: string }): Promise<UpdateUserResult>;
}

export interface UserChange { role?: Role; isActive?: boolean }
interface UserState { id: string; role: Role; isActive: boolean }

/**
 * Pure policy for a PATCH (also used by the in-memory test store). `otherActiveAdmins` = active admins except the
 * target. Returns the denial reason, or the resulting state and whether anything changes.
 */
export function decideUserChange(actorId: string, target: UserState, change: UserChange, otherActiveAdmins: number):
  { status: 'self_change' | 'last_admin' } | { status: 'ok'; role: Role; isActive: boolean; changed: boolean } {
  if (actorId === target.id) return { status: 'self_change' };
  const role = change.role ?? target.role;
  const isActive = change.isActive ?? target.isActive;
  const changed = role !== target.role || isActive !== target.isActive;
  const losesAdmin = target.role === 'admin' && target.isActive && (role !== 'admin' || !isActive);
  if (changed && losesAdmin && otherActiveAdmins < 1) return { status: 'last_admin' };
  return { status: 'ok', role, isActive, changed };
}

type UserRow = { id: string; email: string; role: Role; is_active: boolean; created_at: Date; updated_at: Date };
const USER_COLUMNS = 'id, email, role, is_active, created_at, updated_at';
const view = (r: UserRow): UserView => ({
  id: r.id, email: r.email, role: r.role, isActive: r.is_active, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

/** Under the users table lock: the actor's session is valid and the actor is an active admin. */
export async function actorIsAdmin(tx: QueryClient, actor: ActorRef): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM users u JOIN sessions s ON s.user_id = u.id
      WHERE u.id = $1 AND s.id = $2 AND u.is_active AND u.role = 'admin' AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [actor.userId, actor.sessionId],
  );
  return rows.length > 0;
}

export function createPgUserStore(db: Database): UserStore {
  return {
    async listUsers({ limit, after }) {
      // Keyset on (created_at, id); the cursor is a user id (users are never deleted), never an email.
      const { rows } = await db.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users
          WHERE $1::uuid IS NULL OR (created_at, id) > (SELECT created_at, id FROM users WHERE id = $1::uuid)
          ORDER BY created_at, id LIMIT $2`,
        [after, limit + 1],
      );
      const page = rows.slice(0, limit);
      return { items: page.map(view), nextAfter: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
    },

    createUser({ actor, email, passwordHash, role, requestId }) {
      return db.transaction(async (tx): Promise<CreateUserResult> => {
        await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        if (!(await actorIsAdmin(tx, actor))) return { status: 'actor_revoked' };
        const taken = await tx.query('SELECT 1 FROM users WHERE email = $1', [email]);
        if (taken.rows.length > 0) return { status: 'email_taken' };
        const { rows } = await tx.query<UserRow>(
          `INSERT INTO users (email, password_hash, role, is_active) VALUES ($1, $2, $3, true) RETURNING ${USER_COLUMNS}`,
          [email, passwordHash, role],
        );
        const row = rows[0];
        if (!row) throw new Error('insert returned no row');
        await insertAudit(tx, { event: 'user.created', outcome: 'success', details: { targetUserId: row.id, role } }, { actorUserId: actor.userId, requestId });
        return { status: 'created', user: view(row) };
      });
    },

    updateUser({ actor, targetId, role, isActive, requestId }) {
      return db.transaction(async (tx): Promise<UpdateUserResult> => {
        await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        if (!(await actorIsAdmin(tx, actor))) return { status: 'actor_revoked' };
        const { rows } = await tx.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 FOR UPDATE`, [targetId]);
        const target = rows[0];
        if (!target) return { status: 'not_found' };
        const others = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1",
          [targetId],
        );
        const change: UserChange = { ...(role === undefined ? {} : { role }), ...(isActive === undefined ? {} : { isActive }) };
        const decision = decideUserChange(actor.userId, { id: target.id, role: target.role, isActive: target.is_active }, change, others.rows[0]?.n ?? 0);
        if (decision.status !== 'ok') return { status: decision.status };
        // No-op: nothing written, no audit, sessions untouched.
        if (!decision.changed) return { status: 'updated', user: view(target), changed: false };

        const updated = await tx.query<UserRow>(
          `UPDATE users SET role = $2, is_active = $3, credential_version = credential_version + 1 WHERE id = $1 RETURNING ${USER_COLUMNS}`,
          [targetId, decision.role, decision.isActive],
        );
        const row = updated.rows[0];
        if (!row) throw new Error('update returned no row');
        // Any change of role or activity ends every session of the target; reactivation never restores them.
        const revoked = await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetId]);
        const sessionsRevoked = revoked.rowCount ?? 0;
        const context = { actorUserId: actor.userId, requestId };
        if (decision.role !== target.role) {
          await insertAudit(tx, {
            event: 'user.role_changed', outcome: 'success', details: { targetUserId: targetId, fromRole: target.role, toRole: decision.role, sessionsRevoked },
          }, context);
        }
        if (decision.isActive !== target.is_active) {
          await insertAudit(tx, {
            event: decision.isActive ? 'user.activated' : 'user.deactivated', outcome: 'success', details: { targetUserId: targetId, sessionsRevoked },
          }, context);
        }
        return { status: 'updated', user: view(row), changed: true };
      });
    },
  };
}
