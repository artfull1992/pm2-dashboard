import { insertAudit } from '../auth/store.js';
import { type Scope, serverVisibleSql } from '../auth/scope.js';
import type { Database } from '../database.js';
import { normalizeSnapshot, type ServerSnapshot } from './snapshot.js';

// Server registry SQL (ADR-015). Parameterized only; admin mutations + audit in one transaction.

/** A server is online if its last ACCEPTED heartbeat (server clock) is newer than this. 3 × default interval. */
export const ONLINE_WINDOW_SECONDS = 90;

export type ServerStatus = 'online' | 'offline' | 'never_connected';

export interface ServerSummary {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  hasActiveCredential: boolean;
}

export interface ServerDetail extends ServerSummary {
  snapshot: ServerSnapshot | null;
}

export interface Actor {
  actorUserId: string;
  requestId: string;
}

export interface ServerStore {
  /** Only servers visible in `scope` (ADR-028), filtered before the page limit. */
  list(input: { limit: number; afterId: string | null; scope: Scope }): Promise<{ items: ServerSummary[]; nextAfterId: string | null }>;
  /** null: missing OR not visible in `scope` (the same answer — existence is not disclosed). */
  get(id: string, scope: Scope): Promise<ServerDetail | null>;
  create(input: { name: string } & Actor): Promise<ServerSummary | 'name_taken'>;
  /** Revokes any active credential and stores the new digest, atomically with the audit row. */
  issueCredential(input: { serverId: string; tokenHash: Buffer } & Actor): Promise<{ issuedAt: Date; rotated: boolean } | 'not_found' | 'inactive'>;
  revokeCredential(input: { serverId: string } & Actor): Promise<{ revoked: boolean } | 'not_found'>;
  /** Read-only lookup for the machine-auth hook. */
  resolveAgent(tokenHash: Buffer): Promise<{ serverId: string } | null>;
  /**
   * Re-validates the credential under FOR SHARE (a concurrent revoke waits, so no heartbeat is accepted after a
   * committed revoke) and upserts the snapshot with the SERVER clock; an older concurrent write never wins.
   */
  recordHeartbeat(input: { tokenHash: Buffer; snapshot: ServerSnapshot }): Promise<{ serverId: string; receivedAt: Date } | 'unauthorized'>;
}

const SUMMARY_COLUMNS = `s.id, s.name, s.is_active, s.created_at, h.received_at,
         CASE WHEN h.received_at IS NULL THEN 'never_connected'
              WHEN h.received_at > now() - make_interval(secs => ${String(ONLINE_WINDOW_SECONDS)}) THEN 'online'
              ELSE 'offline' END AS status,
         EXISTS (SELECT 1 FROM agent_credentials c WHERE c.server_id = s.id AND c.revoked_at IS NULL) AS has_active_credential`;
const SUMMARY_FROM = 'FROM servers s LEFT JOIN server_heartbeats h ON h.server_id = s.id';
const SUMMARY_SELECT = `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM}`;

interface SummaryRow {
  id: string; name: string; is_active: boolean; created_at: Date; received_at: Date | null; status: ServerStatus; has_active_credential: boolean;
  [key: string]: unknown;
}

function toSummary(row: SummaryRow): ServerSummary {
  return {
    id: row.id, name: row.name, isActive: row.is_active, createdAt: row.created_at.toISOString(), status: row.status,
    lastSeenAt: row.received_at ? row.received_at.toISOString() : null, hasActiveCredential: row.has_active_credential,
  };
}

const UNIQUE_VIOLATION = '23505';

// revoked_at uses clock_timestamp(): after waiting for the server row lock, now() (= transaction start) can be
// EARLIER than a credential a concurrent transaction just created, which would violate revoked_at >= created_at.
export function createPgServerStore(db: Database): ServerStore {
  return {
    async list({ limit, afterId, scope }) {
      const { rows } = await db.query<SummaryRow>(
        `${SUMMARY_SELECT}
          WHERE ${serverVisibleSql('s.id', '$3')}
            AND ($1::uuid IS NULL OR (s.created_at, s.id) > (SELECT created_at, id FROM servers WHERE id = $1::uuid))
          ORDER BY s.created_at, s.id LIMIT $2`,
        [afterId, limit + 1, scope],
      );
      const page = rows.slice(0, limit).map(toSummary);
      return { items: page, nextAfterId: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
    },

    async get(id, scope) {
      const { rows } = await db.query<SummaryRow & { snapshot: unknown }>(
        `SELECT h.snapshot, ${SUMMARY_COLUMNS} ${SUMMARY_FROM} WHERE s.id = $1 AND ${serverVisibleSql('s.id', '$2')}`,
        [id, scope],
      );
      const row = rows[0];
      // Rows written before ADR-023 still hold legacy keys (memory, uptime, cpuCount): read through the current contract.
      return row ? { ...toSummary(row), snapshot: row.snapshot === null ? null : normalizeSnapshot(row.snapshot) } : null;
    },

    async create({ name, actorUserId, requestId }) {
      try {
        return await db.transaction(async (tx) => {
          const { rows } = await tx.query<SummaryRow>(
            `INSERT INTO servers (name) VALUES ($1)
             RETURNING id, name, is_active, created_at, NULL::timestamptz AS received_at, 'never_connected' AS status, false AS has_active_credential`,
            [name],
          );
          const row = rows[0];
          if (!row) throw new Error('insert returned no row');
          await insertAudit(tx, { event: 'server.created', outcome: 'success', details: { serverId: row.id } }, { actorUserId, requestId });
          return toSummary(row);
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === UNIQUE_VIOLATION) return 'name_taken';
        throw error;
      }
    },

    issueCredential({ serverId, tokenHash, actorUserId, requestId }) {
      return db.transaction(async (tx) => {
        const server = await tx.query<{ is_active: boolean }>('SELECT is_active FROM servers WHERE id = $1 FOR UPDATE', [serverId]);
        const row = server.rows[0];
        if (!row) return 'not_found' as const;
        if (!row.is_active) return 'inactive' as const;
        const revoked = await tx.query('UPDATE agent_credentials SET revoked_at = clock_timestamp() WHERE server_id = $1 AND revoked_at IS NULL', [serverId]);
        const { rows } = await tx.query<{ created_at: Date }>(
          'INSERT INTO agent_credentials (server_id, token_hash) VALUES ($1, $2) RETURNING created_at',
          [serverId, tokenHash],
        );
        const rotated = (revoked.rowCount ?? 0) > 0;
        await insertAudit(tx, { event: 'agent.credential_issued', outcome: 'success', details: { serverId, rotated } }, { actorUserId, requestId });
        const issuedAt = rows[0]?.created_at;
        if (!issuedAt) throw new Error('insert returned no row');
        return { issuedAt, rotated };
      });
    },

    revokeCredential({ serverId, actorUserId, requestId }) {
      return db.transaction(async (tx) => {
        const server = await tx.query('SELECT 1 FROM servers WHERE id = $1 FOR UPDATE', [serverId]);
        if (server.rows.length === 0) return 'not_found' as const;
        const result = await tx.query('UPDATE agent_credentials SET revoked_at = clock_timestamp() WHERE server_id = $1 AND revoked_at IS NULL', [serverId]);
        const revoked = (result.rowCount ?? 0) > 0;
        await insertAudit(tx, { event: 'agent.credential_revoked', outcome: 'success', details: { serverId, revoked } }, { actorUserId, requestId });
        return { revoked };
      });
    },

    async resolveAgent(tokenHash) {
      const { rows } = await db.query<{ server_id: string }>(
        `SELECT c.server_id FROM agent_credentials c JOIN servers s ON s.id = c.server_id
          WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND s.is_active`,
        [tokenHash],
      );
      return rows[0] ? { serverId: rows[0].server_id } : null;
    },

    recordHeartbeat({ tokenHash, snapshot }) {
      return db.transaction(async (tx) => {
        const cred = await tx.query<{ server_id: string }>(
          `SELECT c.server_id FROM agent_credentials c JOIN servers s ON s.id = c.server_id
            WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND s.is_active
            FOR SHARE OF c, s`,
          [tokenHash],
        );
        const serverId = cred.rows[0]?.server_id;
        if (!serverId) return 'unauthorized' as const;
        // Server receive time, taken once: stored and returned. A concurrent heartbeat with a later timestamp is
        // never overwritten (WHERE …<=), so the row always holds the newest accepted snapshot.
        const clock = await tx.query<{ t: Date }>('SELECT clock_timestamp() AS t');
        const receivedAt = clock.rows[0]?.t;
        if (!receivedAt) throw new Error('clock query returned no row');
        await tx.query(
          `INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (server_id) DO UPDATE SET received_at = EXCLUDED.received_at, snapshot = EXCLUDED.snapshot
             WHERE server_heartbeats.received_at <= EXCLUDED.received_at`,
          [serverId, receivedAt, JSON.stringify(snapshot)],
        );
        return { serverId, receivedAt };
      });
    },
  };
}
