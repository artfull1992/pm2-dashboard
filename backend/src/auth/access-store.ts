import type { Database, QueryClient } from '../database.js';
import { insertAudit } from './store.js';
import { type ActorRef, actorIsAdmin } from './users-store.js';

// Resource grants administration (ADR-028). Only admins change them; the whole set of one user is replaced
// atomically, guarded by users.access_revision (a concurrent edit → conflict, never a silent overwrite), together
// with its audit row in ONE transaction. The target user row is locked FOR UPDATE and the grant rows are deleted, so a
// command authorisation holding them FOR SHARE (control-store) finishes first or sees the new state.

export type AccessMode = 'all' | 'selected';

export interface ServiceGrantView { name: string; /** The service currently exists on the server (inventory or control targets). */ available: boolean }
export interface ServerGrantView { serverId: string; serverName: string; serverActive: boolean; mode: AccessMode; grantedAt: string; services: ServiceGrantView[] }
export interface UserAccessView {
  userId: string; email: string; role: string; isActive: boolean;
  /** admin: global access to every server and service (grants are not used). */
  global: boolean;
  revision: number;
  servers: ServerGrantView[];
}

export interface GrantInput { serverId: string; mode: AccessMode; services: string[] }

export type SaveResult =
  | { status: 'ok'; access: UserAccessView }
  | { status: 'not_found' | 'revision_conflict' | 'role_global' | 'actor_revoked' }
  | { status: 'invalid'; reason: 'duplicate_server' | 'unknown_server' | 'empty_selection' | 'services_with_all' | 'unknown_service'; serverId: string; service?: string };

export interface ServerOption { id: string; name: string; isActive: boolean }
export interface ServiceOption { name: string; processes: number }

export interface AccessStore {
  getAccess(userId: string): Promise<UserAccessView | null>;
  saveAccess(input: { actor: ActorRef; userId: string; expectedRevision: number; servers: GrantInput[]; requestId: string }): Promise<SaveResult>;
  /** Servers for the editor (literal, case-insensitive name search), keyset by name. */
  searchServers(input: { q: string | null; limit: number; afterName: string | null }): Promise<{ items: ServerOption[]; nextAfterName: string | null }>;
  /** Current service names of one server (inventory ∪ control targets), at most `limit`; null: unknown server. */
  serverServices(input: { serverId: string; q: string | null; limit: number }): Promise<{ items: ServiceOption[]; truncated: boolean } | null>;
}

const CURRENT_NAMES = `SELECT name FROM server_applications WHERE server_id = $1 UNION SELECT name FROM server_control_targets WHERE server_id = $1`;

async function readAccess(q: QueryClient, userId: string): Promise<UserAccessView | null> {
  const user = (await q.query<{ id: string; email: string; role: string; is_active: boolean; access_revision: string | number }>(
    'SELECT id, email, role, is_active, access_revision FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) return null;
  const grants = (await q.query<{ server_id: string; name: string; is_active: boolean; mode: AccessMode; granted_at: Date }>(
    `SELECT g.server_id, s.name, s.is_active, g.mode, g.granted_at FROM user_server_access g JOIN servers s ON s.id = g.server_id
      WHERE g.user_id = $1 ORDER BY s.name, s.id`, [userId])).rows;
  const services = (await q.query<{ server_id: string; service_name: string; available: boolean }>(
    `SELECT a.server_id, a.service_name,
            (EXISTS (SELECT 1 FROM server_applications p WHERE p.server_id = a.server_id AND p.name = a.service_name)
             OR EXISTS (SELECT 1 FROM server_control_targets t WHERE t.server_id = a.server_id AND t.name = a.service_name)) AS available
       FROM user_service_access a WHERE a.user_id = $1 ORDER BY a.service_name`, [userId])).rows;
  return {
    userId: user.id, email: user.email, role: user.role, isActive: user.is_active, global: user.role === 'admin', revision: Number(user.access_revision),
    servers: grants.map((g) => ({
      serverId: g.server_id, serverName: g.name, serverActive: g.is_active, mode: g.mode, grantedAt: g.granted_at.toISOString(),
      services: services.filter((s) => s.server_id === g.server_id).map((s) => ({ name: s.service_name, available: s.available })),
    })),
  };
}

export function createPgAccessStore(db: Database): AccessStore {
  return {
    getAccess: (userId) => readAccess(db, userId),

    saveAccess({ actor, userId, expectedRevision, servers, requestId }) {
      return db.transaction(async (tx): Promise<SaveResult> => {
        if (!(await actorIsAdmin(tx, actor))) return { status: 'actor_revoked' };
        const target = (await tx.query<{ role: string; access_revision: string | number }>('SELECT role, access_revision FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
        if (!target) return { status: 'not_found' };
        if (Number(target.access_revision) !== expectedRevision) return { status: 'revision_conflict' };
        if (target.role === 'admin' && servers.length > 0) return { status: 'role_global' };
        const seen = new Set<string>();
        for (const s of servers) {
          if (seen.has(s.serverId)) return { status: 'invalid', reason: 'duplicate_server', serverId: s.serverId };
          seen.add(s.serverId);
          if (s.mode === 'selected' && s.services.length === 0) return { status: 'invalid', reason: 'empty_selection', serverId: s.serverId };
          if (s.mode === 'all' && s.services.length > 0) return { status: 'invalid', reason: 'services_with_all', serverId: s.serverId };
          if ((await tx.query('SELECT 1 FROM servers WHERE id = $1', [s.serverId])).rows.length === 0) return { status: 'invalid', reason: 'unknown_server', serverId: s.serverId };
          if (s.mode === 'selected') {
            // A NEW selection must name a service of THAT server; a name granted before may stay although it is gone
            // now (shown as unavailable — never turned into a wildcard).
            const known = new Set((await tx.query<{ name: string }>(
              `${CURRENT_NAMES} UNION SELECT service_name AS name FROM user_service_access WHERE user_id = $2 AND server_id = $1`, [s.serverId, userId])).rows.map((r) => r.name));
            const unknown = s.services.find((n) => !known.has(n));
            if (unknown !== undefined) return { status: 'invalid', reason: 'unknown_service', serverId: s.serverId, service: unknown };
          }
        }
        await tx.query('DELETE FROM user_server_access WHERE user_id = $1', [userId]);
        for (const s of servers) {
          await tx.query('INSERT INTO user_server_access (user_id, server_id, mode, granted_by) VALUES ($1, $2, $3, $4)', [userId, s.serverId, s.mode, actor.userId]);
          if (s.services.length > 0) {
            await tx.query(
              `INSERT INTO user_service_access (user_id, server_id, service_name, granted_by)
               SELECT $1, $2, n, $4 FROM unnest($3::text[]) AS n`,
              [userId, s.serverId, [...new Set(s.services)], actor.userId],
            );
          }
        }
        const revision = expectedRevision + 1;
        await tx.query('UPDATE users SET access_revision = $2 WHERE id = $1', [userId, revision]);
        await insertAudit(tx, {
          event: 'access.updated', outcome: 'success',
          details: { targetUserId: userId, revision, servers: servers.length, services: servers.reduce((n, s) => n + new Set(s.services).size, 0) },
        }, { actorUserId: actor.userId, requestId });
        const access = await readAccess(tx, userId);
        if (!access) throw new Error('user vanished inside the transaction');
        return { status: 'ok', access };
      });
    },

    async searchServers({ q, limit, afterName }) {
      const { rows } = await db.query<{ id: string; name: string; is_active: boolean }>(
        `SELECT id, name, is_active FROM servers
          WHERE ($1::text IS NULL OR strpos(lower(name), lower($1::text)) > 0) AND ($2::text IS NULL OR name > $2::text)
          ORDER BY name LIMIT $3`,
        [q, afterName, limit + 1],
      );
      const items = rows.slice(0, limit).map((r) => ({ id: r.id, name: r.name, isActive: r.is_active }));
      return { items, nextAfterName: rows.length > limit ? (items.at(-1)?.name ?? null) : null };
    },

    async serverServices({ serverId, q, limit }) {
      if ((await db.query('SELECT 1 FROM servers WHERE id = $1', [serverId])).rows.length === 0) return null;
      const { rows } = await db.query<{ name: string; processes: string | number }>(
        `SELECT n.name, (SELECT count(*) FROM server_applications p WHERE p.server_id = $1 AND p.name = n.name) AS processes
           FROM (${CURRENT_NAMES}) n
          WHERE $2::text IS NULL OR strpos(lower(n.name), lower($2::text)) > 0
          ORDER BY n.name LIMIT $3`,
        [serverId, q, limit + 1],
      );
      return { items: rows.slice(0, limit).map((r) => ({ name: r.name, processes: Number(r.processes) })), truncated: rows.length > limit };
    },
  };
}
