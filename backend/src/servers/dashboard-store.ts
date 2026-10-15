import type { Database, QueryClient } from '../database.js';
import { type ControlAction, RESULT_GRACE_SECONDS } from './control.js';
import { INVENTORY_FRESH_SECONDS, type ProcessStatus } from './inventory.js';
import { INVENTORY_STATE_SQL, type InventoryState, SERVER_STATUS_SQL } from './inventory-store.js';
import type { ServerSnapshot } from './snapshot.js';
import { ONLINE_WINDOW_SECONDS, type ServerStatus } from './store.js';

// Dashboard (ADR-020): one read-only, consistent snapshot of the whole system. All queries run in ONE
// REPEATABLE READ READ ONLY transaction, so totals and lists see the same data, and every freshness window is
// measured from the same now() (transaction start) — returned as generatedAt. Nothing is written or expired here.

export const DASHBOARD_LIMITS = Object.freeze({ attentionServers: 20, attentionProcesses: 20, serverList: 50, recentActions: 10 });

/** PM2 status groups (ADR-020). Restarts are a cumulative counter and never imply "frequent restarts". */
export const PROBLEM_STATUSES = ['errored', 'waiting restart', 'unknown', 'stopped'] as const satisfies readonly ProcessStatus[];
export const TRANSITIONAL_STATUSES = ['launching', 'stopping', 'one-launch-status'] as const satisfies readonly ProcessStatus[];

export type AttentionReason = 'offline' | 'never_connected' | 'inventory_unavailable' | 'inventory_stale' | 'inventory_not_reported';

export interface DashboardServer {
  id: string;
  name: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  /**
   * Only for an online server; never stale data presented as current. uptimeSeconds / cpuCount / memory are null when
   * the stored snapshot is minimal (ADR-023 rollback compatibility) — unknown, never 0.
   */
  metrics: {
    hostname: string;
    uptimeSeconds: number | null;
    cpuCount: number | null;
    loadAverage: [number, number, number];
    memory: { totalBytes: number; usedBytes: number; usedPercent: number | null } | null;
  } | null;
  inventory: { state: InventoryState; collectedAt: string | null };
  /** Counts of LIVE processes (online server + current inventory); null when the data is not live. */
  processes: { total: number; online: number; problem: number } | null;
}

export interface Dashboard {
  generatedAt: string;
  windows: { onlineSeconds: number; inventoryFreshSeconds: number };
  servers: { total: number; inactive: number; active: number; online: number; offline: number; neverConnected: number };
  inventory: { current: number; stale: number; unavailable: number; notReported: number };
  processes: { live: { total: number; online: number; problem: number; transitional: number }; notLive: number };
  attentionServers: { items: { id: string; name: string; status: ServerStatus; reason: AttentionReason; lastSeenAt: string | null; inventoryCollectedAt: string | null }[]; total: number; limit: number };
  attentionProcesses: { items: { serverId: string; serverName: string; pmId: number; name: string; status: ProcessStatus; restarts: number | null; uptimeSeconds: number | null }[]; total: number; limit: number };
  serverList: { items: DashboardServer[]; total: number; limit: number };
  recentActions: {
    items: {
      id: string; serverId: string; serverName: string; targetKey: string; action: ControlAction; status: string; reason: string | null;
      requestedAt: string; completedAt: string | null; requestedByMe: boolean; overdue: boolean;
    }[];
    limit: number;
  } | null;
}

export interface DashboardStore {
  /** `actionsFor`: the viewer's user id when they may see recent actions; null → the query is not run at all. */
  dashboard(input: { actionsFor: string | null }): Promise<Dashboard>;
}

// Per server: lifecycle status and inventory state, 1:1 joins on the server_id primary keys (no row multiplication).
const SRV = `SELECT s.id, s.name, s.is_active, h.received_at, h.snapshot, i.inventory_collected_at,
       ${SERVER_STATUS_SQL} AS status, ${INVENTORY_STATE_SQL} AS inv
  FROM servers s LEFT JOIN server_heartbeats h ON h.server_id = s.id LEFT JOIN server_inventories i ON i.server_id = s.id`;
const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const PROBLEM = sqlList(PROBLEM_STATUSES);
const TRANSITIONAL = sqlList(TRANSITIONAL_STATUSES);
const LIVE = "srv.status = 'online' AND srv.inv = 'current'";

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);

async function read(tx: QueryClient, actionsFor: string | null): Promise<Dashboard> {
  // Must precede every query of the transaction (SET commands do not take a snapshot).
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const totals = (await tx.query(`
    WITH srv AS (${SRV})
    SELECT now() AS generated_at,
           count(*) AS total, count(*) FILTER (WHERE NOT is_active) AS inactive, count(*) FILTER (WHERE is_active) AS active,
           count(*) FILTER (WHERE is_active AND status = 'online') AS online,
           count(*) FILTER (WHERE is_active AND status = 'offline') AS offline,
           count(*) FILTER (WHERE is_active AND status = 'never_connected') AS never_connected,
           count(*) FILTER (WHERE is_active AND inv = 'current') AS inv_current,
           count(*) FILTER (WHERE is_active AND inv = 'stale') AS inv_stale,
           count(*) FILTER (WHERE is_active AND inv = 'unavailable') AS inv_unavailable,
           count(*) FILTER (WHERE is_active AND inv = 'not_reported') AS inv_not_reported
      FROM srv`)).rows[0] ?? {};
  const procs = (await tx.query(`
    WITH srv AS (${SRV})
    SELECT count(*) FILTER (WHERE ${LIVE}) AS live_total,
           count(*) FILTER (WHERE ${LIVE} AND a.status = 'online') AS live_online,
           count(*) FILTER (WHERE ${LIVE} AND a.status IN (${PROBLEM})) AS live_problem,
           count(*) FILTER (WHERE ${LIVE} AND a.status IN (${TRANSITIONAL})) AS live_transitional,
           count(*) FILTER (WHERE NOT (${LIVE})) AS not_live
      FROM server_applications a JOIN srv ON srv.id = a.server_id
     WHERE srv.is_active`)).rows[0] ?? {};

  const attentionServers = (await tx.query(`
    WITH srv AS (${SRV}), att AS (
      SELECT id, name, status, received_at, inventory_collected_at,
             CASE WHEN status = 'offline' THEN 'offline' WHEN status = 'never_connected' THEN 'never_connected'
                  WHEN inv = 'unavailable' THEN 'inventory_unavailable' WHEN inv = 'stale' THEN 'inventory_stale'
                  ELSE 'inventory_not_reported' END AS reason,
             CASE WHEN status = 'offline' THEN 1 WHEN status = 'never_connected' THEN 2 WHEN inv = 'unavailable' THEN 3
                  WHEN inv = 'stale' THEN 4 ELSE 5 END AS priority
        FROM srv WHERE is_active AND (status <> 'online' OR inv <> 'current'))
    SELECT *, count(*) OVER () AS total FROM att ORDER BY priority, name, id LIMIT $1`, [DASHBOARD_LIMITS.attentionServers])).rows;

  const attentionProcesses = (await tx.query(`
    WITH srv AS (${SRV})
    SELECT a.server_id, srv.name AS server_name, a.pm_id, a.name, a.status, a.restarts, a.uptime_seconds, count(*) OVER () AS total
      FROM server_applications a JOIN srv ON srv.id = a.server_id
     WHERE srv.is_active AND ${LIVE} AND a.status IN (${PROBLEM})
     ORDER BY array_position(ARRAY[${PROBLEM}]::text[], a.status), srv.name, a.name, a.pm_id, a.server_id
     LIMIT $1`, [DASHBOARD_LIMITS.attentionProcesses])).rows;

  const serverList = (await tx.query(`
    WITH srv AS (${SRV})
    SELECT srv.id, srv.name, srv.status, srv.received_at, srv.inv, srv.inventory_collected_at,
           CASE WHEN srv.status = 'online' THEN srv.snapshot END AS snapshot,
           p.total AS p_total, p.online AS p_online, p.problem AS p_problem, count(*) OVER () AS total
      FROM srv
      LEFT JOIN LATERAL (
        SELECT count(*) AS total, count(*) FILTER (WHERE a.status = 'online') AS online,
               count(*) FILTER (WHERE a.status IN (${PROBLEM})) AS problem
          FROM server_applications a WHERE a.server_id = srv.id) p ON true
     WHERE srv.is_active
     ORDER BY srv.name, srv.id LIMIT $1`, [DASHBOARD_LIMITS.serverList])).rows;

  let recentActions: Dashboard['recentActions'] = null;
  if (actionsFor !== null) {
    const rows = (await tx.query(`
      SELECT c.id, c.server_id, s.name AS server_name, c.target_key, c.action, c.status, c.reason, c.requested_at, c.completed_at,
             c.requested_by = $2::uuid AS by_me,
             (c.status = 'queued' AND c.deadline_at <= now())
               OR (c.status = 'dispatched' AND c.deadline_at + make_interval(secs => ${String(RESULT_GRACE_SECONDS)}) <= now()) AS overdue
        FROM control_commands c JOIN servers s ON s.id = c.server_id
       ORDER BY c.requested_at DESC, c.id DESC LIMIT $1`, [DASHBOARD_LIMITS.recentActions, actionsFor])).rows;
    recentActions = {
      limit: DASHBOARD_LIMITS.recentActions,
      items: rows.map((r: Row) => ({
        id: String(r.id), serverId: String(r.server_id), serverName: String(r.server_name), targetKey: String(r.target_key),
        action: r.action as ControlAction, status: String(r.status), reason: (r.reason as string | null) ?? null,
        requestedAt: iso(r.requested_at) ?? '', completedAt: iso(r.completed_at), requestedByMe: r.by_me === true, overdue: r.overdue === true,
      })),
    };
  }

  const totalOf = (rows: Row[]) => num(rows[0]?.total);
  return {
    generatedAt: iso(totals.generated_at) ?? new Date(0).toISOString(),
    windows: { onlineSeconds: ONLINE_WINDOW_SECONDS, inventoryFreshSeconds: INVENTORY_FRESH_SECONDS },
    servers: {
      total: num(totals.total), inactive: num(totals.inactive), active: num(totals.active),
      online: num(totals.online), offline: num(totals.offline), neverConnected: num(totals.never_connected),
    },
    inventory: { current: num(totals.inv_current), stale: num(totals.inv_stale), unavailable: num(totals.inv_unavailable), notReported: num(totals.inv_not_reported) },
    processes: {
      live: { total: num(procs.live_total), online: num(procs.live_online), problem: num(procs.live_problem), transitional: num(procs.live_transitional) },
      notLive: num(procs.not_live),
    },
    attentionServers: {
      limit: DASHBOARD_LIMITS.attentionServers, total: totalOf(attentionServers),
      items: attentionServers.map((r: Row) => ({
        id: String(r.id), name: String(r.name), status: r.status as ServerStatus, reason: r.reason as AttentionReason,
        lastSeenAt: iso(r.received_at), inventoryCollectedAt: iso(r.inventory_collected_at),
      })),
    },
    attentionProcesses: {
      limit: DASHBOARD_LIMITS.attentionProcesses, total: totalOf(attentionProcesses),
      items: attentionProcesses.map((r: Row) => ({
        serverId: String(r.server_id), serverName: String(r.server_name), pmId: Number(r.pm_id), name: String(r.name), status: r.status as ProcessStatus,
        restarts: r.restarts === null ? null : Number(r.restarts), uptimeSeconds: r.uptime_seconds === null ? null : Number(r.uptime_seconds),
      })),
    },
    serverList: {
      limit: DASHBOARD_LIMITS.serverList, total: totalOf(serverList),
      items: serverList.map((r: Row): DashboardServer => {
        const s = r.snapshot as ServerSnapshot | null;
        const live = r.status === 'online' && r.inv === 'current';
        return {
          id: String(r.id), name: String(r.name), status: r.status as ServerStatus, lastSeenAt: iso(r.received_at),
          metrics: s ? {
            hostname: s.hostname, uptimeSeconds: s.uptimeSeconds ?? null, cpuCount: s.cpuCount ?? null, loadAverage: [s.loadAverage[0], s.loadAverage[1], s.loadAverage[2]],
            memory: s.memory ? {
              totalBytes: s.memory.totalBytes, usedBytes: s.memory.totalBytes - s.memory.freeBytes,
              // totalBytes = 0: the percentage is unknown, never 0 %.
              usedPercent: s.memory.totalBytes > 0 ? Math.round(((s.memory.totalBytes - s.memory.freeBytes) / s.memory.totalBytes) * 1000) / 10 : null,
            } : null,
          } : null,
          inventory: { state: r.inv as InventoryState, collectedAt: iso(r.inventory_collected_at) },
          processes: live ? { total: num(r.p_total), online: num(r.p_online), problem: num(r.p_problem) } : null,
        };
      }),
    },
    recentActions,
  };
}

export function createPgDashboardStore(db: Database): DashboardStore {
  return { dashboard: ({ actionsFor }) => db.transaction((tx) => read(tx, actionsFor)) };
}
