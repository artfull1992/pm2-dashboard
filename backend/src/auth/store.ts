import type { Database, QueryClient } from '../database.js';
import type { Role } from './rbac.js';

// SQL for authentication, sessions and audit (ADR-011). Every statement is parameterized.
// Mutations and their audit rows share one transaction: if the audit insert fails, the mutation is rolled back.

export type AuditOutcome = 'success' | 'failure' | 'denied';
/** Server-defined events; details values are server-defined enums/ids only, never client input. */
export type AuditEvent =
  | { event: 'admin.bootstrap'; outcome: 'success'; details?: Record<string, never> }
  | { event: 'auth.login'; outcome: 'success'; details?: Record<string, never> }
  | { event: 'auth.login'; outcome: 'failure'; details: { reason: 'invalid_credentials' | 'inactive_user' | 'stale_credentials' } }
  // User administration and self-service password change (ADR-019): ids/roles/counts only — never email or secrets.
  | { event: 'auth.password_change'; outcome: 'success'; details: { sessionsRevoked: number } }
  | { event: 'auth.password_change'; outcome: 'failure'; details: { reason: 'invalid_current_password' | 'stale_credentials' } }
  | { event: 'user.created'; outcome: 'success'; details: { targetUserId: string; role: Role } }
  | { event: 'user.create_rejected'; outcome: 'failure'; details: { reason: 'email_taken' } }
  | { event: 'user.role_changed'; outcome: 'success'; details: { targetUserId: string; fromRole: Role; toRole: Role; sessionsRevoked: number } }
  | { event: 'user.deactivated' | 'user.activated'; outcome: 'success'; details: { targetUserId: string; sessionsRevoked: number } }
  | { event: 'user.update_rejected'; outcome: 'denied'; details: { targetUserId: string; reason: 'self_change' | 'last_admin' } }
  // Alert settings and Slack integration (ADR-022): revisions, counts and fixed codes only — never the webhook.
  | { event: 'settings.alerts_changed'; outcome: 'success'; details: { revision: number; changed: string } }
  | { event: 'settings.delivery_enabled' | 'settings.delivery_disabled'; outcome: 'success'; details: { revision: number; cancelledItems: number } }
  | { event: 'integration.slack_configured'; outcome: 'success'; details: { generation: number; replaced: boolean; cancelledItems: number } }
  | { event: 'integration.slack_removed'; outcome: 'success'; details: { generation: number; cancelledItems: number } }
  | { event: 'integration.slack_test_requested'; outcome: 'success'; details: { operationId: string; generation: number } }
  | { event: 'integration.slack_test_result'; outcome: 'success' | 'failure'; details: { operationId: string; generation: number; code?: string; stale?: boolean } }
  | { event: 'auth.logout'; outcome: 'success'; details?: Record<string, never> }
  | { event: 'access.updated'; outcome: 'success'; details: { targetUserId: string; revision: number; servers: number; services: number } }
  | { event: 'authz.denied'; outcome: 'denied'; details: { permission: string; route: string } }
  | { event: 'server.created'; outcome: 'success'; details: { serverId: string } }
  | { event: 'agent.credential_issued'; outcome: 'success'; details: { serverId: string; rotated: boolean } }
  | { event: 'agent.credential_revoked'; outcome: 'success'; details: { serverId: string; revoked: boolean } }
  // PM2 process control lifecycle (ADR-017). reason is a server-defined code; never PM2 output.
  | { event: ProcessCommandEvent; outcome: AuditOutcome; details: ProcessCommandDetails }
  // Log viewing (ADR-018): metadata only — never log text.
  | { event: 'logs.view_opened'; outcome: 'success'; details: { serverId: string; targetKey: string } }
  | { event: 'logs.view_denied'; outcome: 'denied'; details: { serverId: string; targetKey: string; reason: string } };

export type ProcessCommandEvent =
  | 'process.command_requested' | 'process.command_rejected' | 'process.command_expired' | 'process.command_dispatched'
  | 'process.command_succeeded' | 'process.command_failed' | 'process.command_unknown';
export interface ProcessCommandDetails {
  serverId: string;
  commandId: string;
  targetKey: string;
  action: string;
  reason?: string;
}

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
  /** Bumped with every password/role/activity change (ADR-019); a session is created only for an unchanged version. */
  credentialVersion: number;
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
  /**
   * One transaction: lock the user row (FOR SHARE) and require it to be active with the credential version the
   * password was verified against — otherwise null and nothing is written; then revoke the presented session
   * (fixation), prune the user's old sessions, insert, audit.
   */
  createSession(input: {
    userId: string; credentialVersion: number; tokenHash: Buffer; ttlSeconds: number; previousTokenHash: Buffer | null; requestId: string;
  }): Promise<{ expiresAt: Date } | null>;
  /** Hash + version of an ACTIVE user, read for verifying the current password outside any transaction. */
  getCredentials(userId: string): Promise<{ passwordHash: string; credentialVersion: number } | null>;
  /**
   * One transaction, compare-and-set on the version read by getCredentials: new hash + version bump, revoke ALL of
   * the user's sessions, audit. 'stale': the version/activity changed meanwhile — nothing written.
   */
  changePassword(input: { userId: string; expectedVersion: number; passwordHash: string; requestId: string }): Promise<{ status: 'changed'; sessionsRevoked: number } | { status: 'stale' }>;
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
      const { rows } = await db.query<{ id: string; email: string; role: Role; password_hash: string; is_active: boolean; credential_version: string }>(
        'SELECT id, email, role, password_hash, is_active, credential_version::text FROM users WHERE email = $1',
        [email],
      );
      const row = rows[0];
      return row ? {
        id: row.id, email: row.email, role: row.role, passwordHash: row.password_hash, isActive: row.is_active, credentialVersion: Number(row.credential_version),
      } : null;
    },

    createSession({ userId, credentialVersion, tokenHash, ttlSeconds, previousTokenHash, requestId }) {
      return db.transaction(async (tx) => {
        // Lock order everywhere: users row → sessions. FOR SHARE waits for a concurrent password/role/activity change
        // and then sees its committed version; a change that starts later waits for this login and revokes its session.
        const current = await tx.query('SELECT 1 FROM users WHERE id = $1 AND is_active AND credential_version = $2 FOR SHARE', [userId, credentialVersion]);
        if (current.rows.length === 0) return null;
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

    async getCredentials(userId) {
      const { rows } = await db.query<{ password_hash: string; credential_version: string }>(
        'SELECT password_hash, credential_version::text FROM users WHERE id = $1 AND is_active',
        [userId],
      );
      const row = rows[0];
      return row ? { passwordHash: row.password_hash, credentialVersion: Number(row.credential_version) } : null;
    },

    changePassword({ userId, expectedVersion, passwordHash, requestId }) {
      return db.transaction(async (tx) => {
        const updated = await tx.query(
          `UPDATE users SET password_hash = $2, credential_version = credential_version + 1
            WHERE id = $1 AND is_active AND credential_version = $3`,
          [userId, passwordHash, expectedVersion],
        );
        if (!updated.rowCount) return { status: 'stale' } as const;
        const revoked = await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        const sessionsRevoked = revoked.rowCount ?? 0;
        await insertAudit(tx, { event: 'auth.password_change', outcome: 'success', details: { sessionsRevoked } }, { actorUserId: userId, requestId });
        return { status: 'changed', sessionsRevoked } as const;
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
