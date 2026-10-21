import type { Database, QueryClient } from '../database.js';
import { PublicHttpError } from '../errors.js';
import { hasPermission, type Permission, type Role } from './rbac.js';

// Resource scope (ADR-028): access = permission of the role for the OPERATION (rbac.ts) + grant for the RESOURCE.
// One definition for every route: the SQL fragments below are embedded in the queries themselves, so lists, search,
// cursors, counters and aggregates are filtered BEFORE LIMIT/count — never loaded first and trimmed afterwards.
//
//   scope = null   → global (role admin: every server and service, also future ones; no grant rows needed);
//   scope = userId → only what user_server_access / user_service_access grant to that user (nothing by default).
//
// The role is re-read from the database on every request (auth plugin), so a role change applies to the next request.

export type Scope = string | null;

export function scopeOf(auth: { role: string; userId: string }): Scope {
  return auth.role === 'admin' ? null : auth.userId;
}

/** Scope of an authenticated browser request (the auth plugin has already checked the role permission). */
export function requestScope(auth: { role: string; userId: string } | null | undefined): Scope {
  if (!auth) throw new PublicHttpError(401, 'Authentication required');
  return scopeOf(auth);
}

/** True when `serverCol` is visible for the scope parameter `param` (a `$n` placeholder bound to a Scope). */
export function serverVisibleSql(serverCol: string, param: string): string {
  return `(${param}::uuid IS NULL OR EXISTS (SELECT 1 FROM user_server_access sa_g WHERE sa_g.user_id = ${param}::uuid AND sa_g.server_id = ${serverCol}))`;
}

/** True when the service `(serverCol, nameCol)` is visible: its server granted with mode 'all', or the name selected. */
export function serviceVisibleSql(serverCol: string, nameCol: string, param: string): string {
  return `(${param}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM user_server_access sv_g
             WHERE sv_g.user_id = ${param}::uuid AND sv_g.server_id = ${serverCol}
               AND (sv_g.mode = 'all' OR EXISTS (SELECT 1 FROM user_service_access sv_s
                                                  WHERE sv_s.user_id = sv_g.user_id AND sv_s.server_id = sv_g.server_id
                                                    AND sv_s.service_name = ${nameCol}))))`;
}

/**
 * Inside a transaction: is the service granted RIGHT NOW? With `lock`, the grant rows (and the user row) are read
 * FOR SHARE, so a concurrent revocation (DELETE of the grant, role change, deactivation) waits for this transaction —
 * an action authorised here cannot be created after the revocation committed.
 */
export async function serviceGranted(tx: QueryClient, scope: Scope, serverId: string, serviceName: string, lock = false): Promise<boolean> {
  if (scope === null) return true;
  const share = lock ? 'FOR SHARE' : '';
  const g = await tx.query<{ mode: string }>(`SELECT mode FROM user_server_access WHERE user_id = $1 AND server_id = $2 ${share}`, [scope, serverId]);
  const mode = g.rows[0]?.mode;
  if (mode === undefined) return false;
  if (mode === 'all') return true;
  const s = await tx.query(`SELECT 1 FROM user_service_access WHERE user_id = $1 AND server_id = $2 AND service_name = $3 ${share}`, [scope, serverId, serviceName]);
  return s.rows.length > 0;
}

export async function serverGranted(tx: QueryClient, scope: Scope, serverId: string): Promise<boolean> {
  if (scope === null) return true;
  const g = await tx.query('SELECT 1 FROM user_server_access WHERE user_id = $1 AND server_id = $2', [scope, serverId]);
  return g.rows.length > 0;
}

/** Database-backed checks for routes whose data is not in SQL (the in-memory log hub, ADR-018/028). */
export interface AccessChecker {
  /**
   * The CURRENT scope of a user for an operation: re-read role and active flag (ADR-028). null — no such active user,
   * or the role lacks `permission`. For work that runs later than the user's request (queued log delivery).
   */
  actorScope(userId: string, permission: Permission): Promise<{ scope: Scope } | null>;
  serverVisible(scope: Scope, serverId: string): Promise<boolean>;
  /** The subset of `names` (services of `serverId`) visible in the scope — one query for any number of names. */
  visibleServices(scope: Scope, serverId: string, names: readonly string[]): Promise<Set<string>>;
}

export function createAccessChecker(db: Database): AccessChecker {
  return {
    async actorScope(userId, permission) {
      const { rows } = await db.query<{ role: Role }>('SELECT role FROM users WHERE id = $1 AND is_active', [userId]);
      const role = rows[0]?.role;
      if (role === undefined || !hasPermission(role, permission)) return null;
      return { scope: role === 'admin' ? null : userId };
    },
    async serverVisible(scope, serverId) {
      const { rows } = await db.query(`SELECT 1 FROM servers s WHERE s.id = $1 AND ${serverVisibleSql('s.id', '$2')}`, [serverId, scope]);
      return rows.length > 0;
    },
    async visibleServices(scope, serverId, names) {
      if (names.length === 0) return new Set();
      if (scope === null) return new Set(names);
      const { rows } = await db.query<{ name: string }>(
        `SELECT n.name FROM unnest($3::text[]) AS n(name) WHERE ${serviceVisibleSql('$1::uuid', 'n.name', '$2')}`,
        [serverId, scope, [...names]],
      );
      return new Set(rows.map((r) => r.name));
    },
  };
}
