import type { Database, QueryClient } from '../database.js';
import type { Role } from './rbac.js';

// SQL for authentication, sessions and audit (ADR-011). Every statement is parameterized.
// Mutations and their audit rows share one transaction: if the audit insert fails, the mutation is rolled back.

export type AuditOutcome = 'success' | 'failure' | 'denied';
/** Server-defined events; details values are server-defined enums/ids only, never client input. */
export type AuditEvent =
  | { event: 'admin.bootstrap'; outcome: 'success'; details?: Record<string, never> }
  | { event: 'auth.login'; outcome: 'success'; details?: Record<string, never> }
  | { event: 'auth.login'; outcome: 'failure'; details: { reason: 'invalid_credentials' | 'inactive_user' } }
  | { event: 'auth.logout'; outcome: 'success'; details?: Record<string, never> }
  | { event: 'authz.denied'; outcome: 'denied'; details: { permission: string; route: string } }
  | { event: 'server.created'; outcome: 'success'; details: { serverId: string } }
  | { event: 'agent.credential_issued'; outcome: 'success'; details: { serverId: string; rotated: boolean } }
  | { event: 'agent.credential_revoked'; outcome: 'success'; details: { serverId: string; revoked: boolean } };

export interface AuditContext {
  actorUserId: string | null;
  requestId: string | null;
}

export interface LoginUser {
  id: string;
  email: string;
  role: Role;
  passwordHash: string;
  isActive: boolean;
}

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

export interface AuditItem {
  id: string;
  occurredAt: string;
  event: string;
  outcome: AuditOutcome;
  actorUserId: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface AuthStore {
  findLoginUser(email: string): Promise<LoginUser | null>;
  /** One transaction: revoke the presented session (fixation), prune the user's old sessions, insert, audit. */
  createSession(input: { userId: string; tokenHash: Buffer; ttlSeconds: number; previousTokenHash: Buffer | null; requestId: string }): Promise<{ expiresAt: Date }>;
  /** Current user data is re-read on every request: role changes and deactivation apply immediately. */
  resolveSession(tokenHash: Buffer): Promise<SessionUser | null>;
  /** One transaction: revoke + audit. Returns false if the session was already gone. */
  revokeSession(input: { sessionId: string; userId: string; requestId: string }): Promise<boolean>;
  recordAudit(entry: AuditEvent, context: AuditContext): Promise<void>;
  listAudit(input: { limit: number; beforeId: string | null }): Promise<{ items: AuditItem[]; nextBeforeId: string | null }>;
}

const PRUNE_AFTER = '1 day';

export async function insertAudit(client: QueryClient, entry: AuditEvent, context: AuditContext): Promise<void> {
  await client.query(
    'INSERT INTO audit_log (event, outcome, actor_user_id, request_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [entry.event, entry.outcome, context.actorUserId, context.requestId, JSON.stringify(entry.details ?? {})],
  );
}

export function createPgAuthStore(db: Database): AuthStore {
  return {
    async findLoginUser(email) {
      const { rows } = await db.query<{ id: string; email: string; role: Role; password_hash: string; is_active: boolean }>(
        'SELECT id, email, role, password_hash, is_active FROM users WHERE email = $1',
        [email],
      );
      const row = rows[0];
      return row ? { id: row.id, email: row.email, role: row.role, passwordHash: row.password_hash, isActive: row.is_active } : null;
    },

    createSession({ userId, tokenHash, ttlSeconds, previousTokenHash, requestId }) {
      return db.transaction(async (tx) => {
        if (previousTokenHash) {
          await tx.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [previousTokenHash]);
        }
        // Bounded cleanup without a background job: this user's sessions that ended over a day ago.
        await tx.query(
          `DELETE FROM sessions WHERE user_id = $1
             AND (expires_at < now() - $2::interval OR revoked_at < now() - $2::interval)`,
          [userId, PRUNE_AFTER],
        );
        const { rows } = await tx.query<{ expires_at: Date }>(
          `INSERT INTO sessions (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING expires_at`,
          [userId, tokenHash, ttlSeconds],
        );
        await insertAudit(tx, { event: 'auth.login', outcome: 'success' }, { actorUserId: userId, requestId });
        const expiresAt = rows[0]?.expires_at;
        if (!expiresAt) throw new Error('session insert returned no row');
        return { expiresAt };
      });
    },

    async resolveSession(tokenHash) {
      const { rows } = await db.query<{ session_id: string; user_id: string; email: string; role: Role; expires_at: Date }>(
        `SELECT s.id AS session_id, u.id AS user_id, u.email, u.role, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
        [tokenHash],
      );
      const row = rows[0];
      return row ? { sessionId: row.session_id, userId: row.user_id, email: row.email, role: row.role, expiresAt: row.expires_at } : null;
    },

    revokeSession({ sessionId, userId, requestId }) {
      return db.transaction(async (tx) => {
        const { rowCount } = await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
        if (!rowCount) return false;
        await insertAudit(tx, { event: 'auth.logout', outcome: 'success' }, { actorUserId: userId, requestId });
        return true;
      });
    },

    async recordAudit(entry, context) {
      await insertAudit(db, entry, context);
    },

    async listAudit({ limit, beforeId }) {
      // Keyset pagination on the identity PK: stable order, no OFFSET scans, never the whole table.
      const { rows } = await db.query<{
        id: string; occurred_at: Date; event: string; outcome: AuditOutcome; actor_user_id: string | null; request_id: string | null; details: Record<string, unknown>;
      }>(
        `SELECT id::text AS id, occurred_at, event, outcome, actor_user_id, request_id, details
           FROM audit_log WHERE ($1::bigint IS NULL OR id < $1::bigint)
          ORDER BY id DESC LIMIT $2`,
        [beforeId, limit + 1],
      );
      const page = rows.slice(0, limit);
      return {
        items: page.map((r) => ({
          id: r.id, occurredAt: r.occurred_at.toISOString(), event: r.event, outcome: r.outcome,
          actorUserId: r.actor_user_id, requestId: r.request_id, details: r.details,
        })),
        nextBeforeId: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    },
  };
}
