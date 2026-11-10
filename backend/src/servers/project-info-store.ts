import { hasPermission } from '../auth/rbac.js';
import { type Scope, scopeOf, serviceGranted, serviceVisibleSql } from '../auth/scope.js';
import { insertAudit } from '../auth/store.js';
import type { ActorRef } from '../auth/users-store.js';
import type { Database, QueryClient } from '../database.js';
import { FIELD_NAMES, type ProjectInfoFields } from './project-info.js';

// Project information SQL (ADR-036). Parameterized only. Keyed by (server, PM2 process name) — the service identity of
// ADR-028 — and stored apart from the inventory, so reports never overwrite it.
//   - Reading never writes: without a row the answer is the empty state with revision 0.
//   - A service is readable when the reader may see it (scope, in SQL) and it is either in the current inventory of
//     that server or already has saved information; anything else — unknown server, invisible service, a name that
//     was never reported — is "not found", without telling which.
//   - A save needs the permission applications:metadata:write (admin, operator) AND, for a scoped user, the grant of
//     this very service (server «all», or the name selected) — checked and held until the transaction ends by
//     lockEditor, so a concurrent revocation of the role, activity, session or grant is serialized with it; then the
//     service in the current inventory (no records for invented names) and the expected revision: revision 0 inserts
//     (a concurrent first save loses on the primary key → conflict), otherwise the row is locked FOR UPDATE and
//     compared. The change and its audit row are one transaction: a failing audit insert rolls the change back.

export interface ProjectInfoView extends ProjectInfoFields {
  serverId: string;
  serviceName: string;
  revision: number;
  updatedAt: string | null;
}

export type SaveProjectInfoResult =
  | { status: 'ok'; info: ProjectInfoView; changed: boolean }
  | { status: 'not_found' | 'revision_conflict' | 'actor_revoked' | 'forbidden' };

export interface ProjectInfoStore {
  /** null: not found for this scope (see above). */
  get(input: { serverId: string; serviceName: string; scope: Scope }): Promise<ProjectInfoView | null>;
  save(input: { actor: ActorRef; serverId: string; serviceName: string; expectedRevision: number; value: ProjectInfoFields; requestId: string }): Promise<SaveProjectInfoResult>;
}

interface Row { github_url: string | null; project_url: string | null; description: string | null; revision: string | number; updated_at: Date; [key: string]: unknown }

const toView = (serverId: string, serviceName: string, row: Row | undefined): ProjectInfoView => (row ? {
  serverId, serviceName, githubUrl: row.github_url, projectUrl: row.project_url, description: row.description,
  revision: Number(row.revision), updatedAt: row.updated_at.toISOString(),
} : { serverId, serviceName, githubUrl: null, projectUrl: null, description: null, revision: 0, updatedAt: null });

const COLUMNS = 'github_url, project_url, description, revision, updated_at';
const IN_INVENTORY = 'EXISTS (SELECT 1 FROM server_applications a WHERE a.server_id = $1 AND a.name = $2)';
/** Audit codes of the changed fields (never their values). */
const FIELD_CODES: Record<(typeof FIELD_NAMES)[number], string> = { githubUrl: 'github', projectUrl: 'url', description: 'description' };

/**
 * The editor of project information, checked and HELD until the transaction ends (reviews ad41717, b2adb4f): FOR SHARE
 * on the actor's users row, then its session row, then — for a scoped user — its grant rows of this service
 * (user_server_access, and user_service_access for «selected»; serviceGranted with lock). A role or activity change
 * or a password change (UPDATE users), a logout (UPDATE sessions) or a grant change (saveAccess: DELETE of the grant
 * rows) waits for this transaction; one committed first is seen, because a FOR SHARE that had to wait re-reads the
 * row (a deleted grant row is then gone). Lock order users → sessions → grants, as in login, every revocation and
 * saveAccess (target user row FOR UPDATE, then its grant rows): no cycles. Only this actor's rows are locked.
 * A concurrently REPLACED grant (saveAccess deletes and re-inserts the whole set) is refused even when the new set
 * still includes the service: fail closed, the user saves again.
 *   actor_revoked — inactive user or no valid session (401); forbidden — the role lacks the permission (403);
 *   not_found — no grant of this service (404, nothing disclosed).
 * The permission is only this one: it never stands for an admin check, and no other operation uses this helper.
 */
async function lockEditor(tx: QueryClient, actor: ActorRef, serverId: string, serviceName: string): Promise<'ok' | 'actor_revoked' | 'forbidden' | 'not_found'> {
  const user = (await tx.query<{ role: string; is_active: boolean }>('SELECT role, is_active FROM users WHERE id = $1 FOR SHARE', [actor.userId])).rows[0];
  if (!user?.is_active) return 'actor_revoked';
  const session = await tx.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now() FOR SHARE',
    [actor.sessionId, actor.userId],
  );
  if (session.rows.length === 0) return 'actor_revoked';
  if (!hasPermission(user.role, 'applications:metadata:write')) return 'forbidden';
  return (await serviceGranted(tx, scopeOf({ role: user.role, userId: actor.userId }), serverId, serviceName, true)) ? 'ok' : 'not_found';
}

export function createPgProjectInfoStore(db: Database): ProjectInfoStore {
  return {
    async get({ serverId, serviceName, scope }) {
      // Without a saved row the LEFT JOIN columns are NULL (revision included).
      const { rows } = await db.query<{ github_url: string | null; project_url: string | null; description: string | null; revision: string | number | null; updated_at: Date | null; found: boolean }>(
        `SELECT p.github_url, p.project_url, p.description, p.revision, p.updated_at,
                (p.server_id IS NOT NULL OR ${IN_INVENTORY}) AS found
           FROM servers s
           LEFT JOIN application_project_info p ON p.server_id = s.id AND p.service_name = $2
          WHERE s.id = $1 AND ${serviceVisibleSql('s.id', '$2::text', '$3')}`,
        [serverId, serviceName, scope],
      );
      const row = rows[0];
      if (!row?.found) return null;
      const { revision, updated_at: updatedAt } = row;
      return toView(serverId, serviceName, revision === null || updatedAt === null ? undefined : { ...row, revision, updated_at: updatedAt });
    },

    save({ actor, serverId, serviceName, expectedRevision, value, requestId }) {
      return db.transaction(async (tx): Promise<SaveProjectInfoResult> => {
        // The editor (role, activity, session, grant) stays locked until COMMIT: a revocation committed later waits for
        // this save, one committed earlier refuses it. Lock order: users → session → grants → metadata row.
        const editor = await lockEditor(tx, actor, serverId, serviceName);
        if (editor !== 'ok') return { status: editor };
        const known = await tx.query(`SELECT 1 FROM servers s WHERE s.id = $1 AND ${IN_INVENTORY}`, [serverId, serviceName]);
        if (known.rows.length === 0) return { status: 'not_found' };
        const current = (await tx.query<Row>(
          `SELECT ${COLUMNS} FROM application_project_info WHERE server_id = $1 AND service_name = $2 FOR UPDATE`, [serverId, serviceName])).rows[0];
        const before = toView(serverId, serviceName, current);
        if (before.revision !== expectedRevision) return { status: 'revision_conflict' };
        const changed = FIELD_NAMES.filter((f) => before[f] !== value[f]);
        if (changed.length === 0) return { status: 'ok', info: before, changed: false };
        const revision = expectedRevision + 1;
        let saved: Row | undefined;
        if (current) {
          saved = (await tx.query<Row>(
            `UPDATE application_project_info SET github_url = $3, project_url = $4, description = $5, revision = $6, updated_at = now(), updated_by = $7
              WHERE server_id = $1 AND service_name = $2 RETURNING ${COLUMNS}`,
            [serverId, serviceName, value.githubUrl, value.projectUrl, value.description, revision, actor.userId])).rows[0];
        } else {
          // First save: a concurrent first save of the same service commits first or conflicts on the primary key.
          saved = (await tx.query<Row>(
            `INSERT INTO application_project_info (server_id, service_name, github_url, project_url, description, revision, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (server_id, service_name) DO NOTHING RETURNING ${COLUMNS}`,
            [serverId, serviceName, value.githubUrl, value.projectUrl, value.description, revision, actor.userId])).rows[0];
          if (!saved) return { status: 'revision_conflict' };
        }
        await insertAudit(tx, {
          event: 'application.project_info_changed', outcome: 'success',
          details: { serverId, serviceName, revision, changed: changed.map((f) => FIELD_CODES[f]).join(',') },
        }, { actorUserId: actor.userId, requestId });
        return { status: 'ok', info: toView(serverId, serviceName, saved), changed: true };
      });
    },
  };
}
