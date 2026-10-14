import type { Database } from '../database.js';
import {
  type ApplicationCursor, encodeCursor, INVENTORY_FRESH_SECONDS, type InventoryReport, type ProcessStatus,
} from './inventory.js';
import { ONLINE_WINDOW_SECONDS, type ServerStatus } from './store.js';

// PM2 inventory SQL (ADR-016). Parameterized only. A report is applied in one transaction that re-validates the
// credential (FOR SHARE, like the heartbeat), locks the server's inventory row and enforces ordering:
//   - capturedAt older than the last applied report → ignored (an old snapshot never overwrites a newer one);
//   - ok with the same capturedAt → state refresh only (no new collection time, freshness is not bumped);
//   - ok with a newer capturedAt → the process set is replaced (missing processes are deleted);
//   - stale / unavailable → state only, the last collected processes are kept and shown as not current.

export type InventoryState = 'not_reported' | 'current' | 'stale' | 'unavailable';

export interface InventoryInfo {
  state: InventoryState;
  reason: string | null;
  source: string | null;
  capturedAt: string | null;
  collectedAt: string | null;
  reportedAt: string | null;
  processCount: number | null;
}

export interface ApplicationItem {
  key: string;
  serverId: string;
  serverName: string;
  serverStatus: ServerStatus;
  source: string;
  pmId: number;
  name: string;
  status: ProcessStatus;
  uptimeSeconds: number | null;
  restarts: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  execMode: 'fork' | 'cluster' | null;
  firstSeenAt: string;
  inventoryState: Exclude<InventoryState, 'not_reported'>;
  capturedAt: string | null;
  collectedAt: string | null;
}

export interface InventoryStore {
  recordInventory(input: { tokenHash: Buffer; report: InventoryReport }): Promise<{ serverId: string; receivedAt: Date; status: 'accepted' | 'ignored' } | 'unauthorized'>;
  listApplications(input: { limit: number; cursor: ApplicationCursor | null; serverId: string | null; status: ProcessStatus | null }): Promise<{ items: ApplicationItem[]; nextCursor: string | null }>;
  serverApplications(serverId: string): Promise<{ serverId: string; serverStatus: ServerStatus; inventory: InventoryInfo; items: ApplicationItem[] } | null>;
}

const FRESH = `make_interval(secs => ${String(INVENTORY_FRESH_SECONDS)})`;
export const INVENTORY_STATE_SQL = `CASE WHEN i.server_id IS NULL THEN 'not_reported'
            WHEN i.state = 'unavailable' THEN 'unavailable'
            WHEN i.state = 'stale' OR i.inventory_collected_at IS NULL OR i.inventory_collected_at <= now() - ${FRESH} THEN 'stale'
            ELSE 'current' END`;
export const SERVER_STATUS_SQL = `CASE WHEN h.received_at IS NULL THEN 'never_connected'
            WHEN h.received_at > now() - make_interval(secs => ${String(ONLINE_WINDOW_SECONDS)}) THEN 'online'
            ELSE 'offline' END`;

const APP_SELECT = `SELECT a.server_id, s.name AS server_name, ${SERVER_STATUS_SQL} AS server_status, a.source, a.pm_id, a.name,
         a.status, a.uptime_seconds, a.restarts, a.cpu_percent::float8 AS cpu_percent, a.memory_bytes::float8 AS memory_bytes,
         a.exec_mode, a.first_seen_at, ${INVENTORY_STATE_SQL} AS inventory_state, i.inventory_captured_at, i.inventory_collected_at
    FROM server_applications a
    JOIN servers s ON s.id = a.server_id
    JOIN server_inventories i ON i.server_id = a.server_id
    LEFT JOIN server_heartbeats h ON h.server_id = a.server_id`;

interface AppRow {
  server_id: string; server_name: string; server_status: ServerStatus; source: string; pm_id: number; name: string; status: ProcessStatus;
  uptime_seconds: number | null; restarts: number | null; cpu_percent: number | null; memory_bytes: number | null;
  exec_mode: 'fork' | 'cluster' | null; first_seen_at: Date; inventory_state: Exclude<InventoryState, 'not_reported'>;
  inventory_captured_at: Date | null; inventory_collected_at: Date | null;
  [key: string]: unknown;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toItem(r: AppRow): ApplicationItem {
  return {
    key: `${r.server_id}:${r.source}:${String(r.pm_id)}`, serverId: r.server_id, serverName: r.server_name, serverStatus: r.server_status,
    source: r.source, pmId: r.pm_id, name: r.name, status: r.status, uptimeSeconds: r.uptime_seconds, restarts: r.restarts,
    cpuPercent: r.cpu_percent, memoryBytes: r.memory_bytes, execMode: r.exec_mode, firstSeenAt: r.first_seen_at.toISOString(),
    inventoryState: r.inventory_state, capturedAt: iso(r.inventory_captured_at), collectedAt: iso(r.inventory_collected_at),
  };
}

interface InventoryRow {
  source: string | null; state: 'ok' | 'stale' | 'unavailable'; report_captured_at: Date | null; inventory_captured_at: Date | null;
  [key: string]: unknown;
}

export function createPgInventoryStore(db: Database): InventoryStore {
  return {
    recordInventory({ tokenHash, report }) {
      return db.transaction(async (tx) => {
        const cred = await tx.query<{ server_id: string }>(
          `SELECT c.server_id FROM agent_credentials c JOIN servers s ON s.id = c.server_id
            WHERE c.token_hash = $1 AND c.revoked_at IS NULL AND s.is_active
            FOR SHARE OF c, s`,
          [tokenHash],
        );
        const serverId = cred.rows[0]?.server_id;
        if (!serverId) return 'unauthorized' as const;
        const clock = await tx.query<{ t: Date }>('SELECT clock_timestamp() AS t');
        const receivedAt = clock.rows[0]?.t;
        if (!receivedAt) throw new Error('clock query returned no row');

        // Create the row on first report (state placeholder), then serialise concurrent reports on its lock.
        await tx.query(
          `INSERT INTO server_inventories (server_id, source, state, reason, reported_at)
           VALUES ($1, NULL, 'unavailable', 'snapshot_missing', $2) ON CONFLICT (server_id) DO NOTHING`,
          [serverId, receivedAt],
        );
        const current = await tx.query<InventoryRow>(
          'SELECT source, state, report_captured_at, inventory_captured_at FROM server_inventories WHERE server_id = $1 FOR UPDATE',
          [serverId],
        );
        const row = current.rows[0];
        if (!row) throw new Error('inventory row missing after insert');
        const captured = report.capturedAt === null ? null : new Date(report.capturedAt);
        if (captured && row.report_captured_at && captured < row.report_captured_at) {
          return { serverId, receivedAt, status: 'ignored' as const };
        }

        if (report.state !== 'ok') {
          await tx.query(
            `UPDATE server_inventories SET state = $2, reason = $3, reported_at = $4,
                    source = COALESCE($5, source), report_captured_at = COALESCE($6, report_captured_at)
              WHERE server_id = $1`,
            [serverId, report.state, report.reason, receivedAt, report.source, captured],
          );
          return { serverId, receivedAt, status: 'accepted' as const };
        }

        const sameCollection = row.inventory_captured_at !== null && row.source === report.source
          && row.inventory_captured_at.getTime() === captured?.getTime();
        if (sameCollection) {
          await tx.query(
            `UPDATE server_inventories SET state = 'ok', reason = NULL, reported_at = $2, report_captured_at = $3 WHERE server_id = $1`,
            [serverId, receivedAt, captured],
          );
          return { serverId, receivedAt, status: 'accepted' as const };
        }

        const p = report.processes;
        await tx.query(
          'DELETE FROM server_applications WHERE server_id = $1 AND (source <> $2 OR NOT (pm_id = ANY($3::int[])))',
          [serverId, report.source, p.map((x) => x.pmId)],
        );
        await tx.query(
          `UPDATE server_inventories SET source = $2, state = 'ok', reason = NULL, reported_at = $3, report_captured_at = $4,
                  inventory_captured_at = $4, inventory_collected_at = $3, process_count = $5
            WHERE server_id = $1`,
          [serverId, report.source, receivedAt, captured, p.length],
        );
        if (p.length > 0) {
          await tx.query(
            `INSERT INTO server_applications
                    (server_id, source, pm_id, name, status, uptime_seconds, restarts, cpu_percent, memory_bytes, exec_mode, first_seen_at)
             SELECT $1, $2, u.pm_id, u.name, u.status, u.uptime_seconds, u.restarts, u.cpu_percent, u.memory_bytes, u.exec_mode, $11
               FROM unnest($3::int[], $4::text[], $5::text[], $6::int[], $7::int[], $8::numeric[], $9::bigint[], $10::text[])
                    AS u(pm_id, name, status, uptime_seconds, restarts, cpu_percent, memory_bytes, exec_mode)
             ON CONFLICT (server_id, source, pm_id) DO UPDATE SET
                    name = EXCLUDED.name, status = EXCLUDED.status, uptime_seconds = EXCLUDED.uptime_seconds,
                    restarts = EXCLUDED.restarts, cpu_percent = EXCLUDED.cpu_percent, memory_bytes = EXCLUDED.memory_bytes,
                    exec_mode = EXCLUDED.exec_mode,
                    -- pm_id reuse: a different name under the same pm_id is a new application.
                    first_seen_at = CASE WHEN server_applications.name = EXCLUDED.name THEN server_applications.first_seen_at ELSE EXCLUDED.first_seen_at END`,
            [
              serverId, report.source, p.map((x) => x.pmId), p.map((x) => x.name), p.map((x) => x.status), p.map((x) => x.uptimeSeconds),
              p.map((x) => x.restarts), p.map((x) => x.cpuPercent), p.map((x) => x.memoryBytes), p.map((x) => x.execMode), receivedAt,
            ],
          );
        }
        return { serverId, receivedAt, status: 'accepted' as const };
      });
    },

    async listApplications({ limit, cursor, serverId, status }) {
      const { rows } = await db.query<AppRow>(
        `${APP_SELECT}
          WHERE ($1::uuid IS NULL OR a.server_id = $1::uuid)
            AND ($2::text IS NULL OR a.status = $2::text)
            AND ($3::text IS NULL OR (a.name, a.server_id, a.pm_id) > ($3::text, $4::uuid, $5::int))
          ORDER BY a.name, a.server_id, a.pm_id
          LIMIT $6`,
        [serverId, status, cursor?.name ?? null, cursor?.serverId ?? null, cursor?.pmId ?? null, limit + 1],
      );
      const items = rows.slice(0, limit).map(toItem);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeCursor({ name: last.name, serverId: last.serverId, pmId: last.pmId }) : null };
    },

    async serverApplications(serverId) {
      const head = await db.query<{
        server_status: ServerStatus; inventory_state: InventoryState; reason: string | null; source: string | null;
        inventory_captured_at: Date | null; inventory_collected_at: Date | null; reported_at: Date | null; process_count: number | null;
        [key: string]: unknown;
      }>(
        `SELECT ${SERVER_STATUS_SQL} AS server_status, ${INVENTORY_STATE_SQL} AS inventory_state, i.reason, i.source,
                i.inventory_captured_at, i.inventory_collected_at, i.reported_at, i.process_count
           FROM servers s
           LEFT JOIN server_heartbeats h ON h.server_id = s.id
           LEFT JOIN server_inventories i ON i.server_id = s.id
          WHERE s.id = $1`,
        [serverId],
      );
      const r = head.rows[0];
      if (!r) return null;
      const apps = await db.query<AppRow>(`${APP_SELECT} WHERE a.server_id = $1 ORDER BY a.name, a.pm_id LIMIT 500`, [serverId]);
      return {
        serverId,
        serverStatus: r.server_status,
        inventory: {
          state: r.inventory_state, reason: r.reason, source: r.source, capturedAt: iso(r.inventory_captured_at),
          collectedAt: iso(r.inventory_collected_at), reportedAt: iso(r.reported_at), processCount: r.process_count,
        },
        items: apps.rows.map(toItem),
      };
    },
  };
}
