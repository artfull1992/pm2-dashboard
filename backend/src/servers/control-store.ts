import { insertAudit, type ProcessCommandEvent } from '../auth/store.js';
import { hasPermission } from '../auth/rbac.js';
import { type Scope, scopeOf, serverVisibleSql, serviceGranted, serviceVisibleSql } from '../auth/scope.js';
import type { Database, QueryClient } from '../database.js';
import {
  type BrokerMode, COMMAND_DEADLINE_SECONDS, type CommandView, type ControlAction, type ControlTarget, LEASE_SECONDS, MAX_ATTEMPTS,
  type MatchStatus, type PollReport, RESULT_GRACE_SECONDS, type ResultReport, TARGET_FRESH_SECONDS,
} from './control.js';
import { lockAgentServer, ONLINE_WINDOW_SECONDS, type ServerStatus } from './store.js';

// PM2 process control SQL (ADR-017). Parameterized only. Every lifecycle transition and its audit row share one
// transaction. Command identity on the wire is the command id; a machine request is bound to the server of the
// credential, so an Agent can neither see nor confirm commands of another server.

export interface ControlView {
  serverId: string;
  serverStatus: ServerStatus;
  broker: {
    state: 'ok' | 'unavailable'; daemon: 'ok' | 'unavailable' | null; allowlist: 'ok' | 'invalid' | null; reportedAt: string; fresh: boolean;
    /** Reported by version-2 Agents; null for version 1 (allowlist). */
    mode: BrokerMode | null; protocol: 1 | 2;
    /**
     * Version 2: targets the broker knows (more than listed = cut at 500). Only for admin or an "all" grant on this
     * server; null for a selected grant (never reveals hidden services, review e621e31) and for version 1.
     */
    total: number | null;
  } | null;
  /** Only the targets of services visible in the scope (ADR-028). */
  targets: ControlTarget[];
}

export type CreateResult =
  | { command: CommandView; created: boolean }
  | 'not_found' | 'server_offline' | 'target_unavailable' | 'action_not_allowed' | 'command_in_progress' | 'idempotency_conflict';

export interface DeliveredCommand { id: string; attempt: number; targetKey: string; action: ControlAction; deadlineAt: string; identity?: string | null }

export interface ControlStore {
  /** null: server missing or not visible in `scope`. Targets: only visible services. */
  controlView(serverId: string, scope: Scope): Promise<ControlView | null>;
  /**
   * Authorisation and creation in ONE transaction (ADR-028): the actor row and the grant rows are read FOR SHARE, so
   * a concurrent revocation (role change, deactivation, grant removed) waits and no command is created after it.
   * `not_found` also for a server/service the actor may not see (existence is not disclosed).
   */
  createCommand(input: { serverId: string; targetKey: string; action: ControlAction; idempotencyKey: string; actorUserId: string; actorRole: string; requestId: string }): Promise<CreateResult>;
  /** Newest first; `targetKey` limits it to one target of this server (filtered before the limit); only visible services. */
  listCommands(serverId: string, limit: number, targetKey: string | null, scope: Scope): Promise<CommandView[] | null>;
  getCommand(id: string, scope: Scope): Promise<CommandView | null>;
  poll(input: { tokenHash: Buffer; report: PollReport; controlEnabled: boolean }): Promise<{ commands: DeliveredCommand[] } | 'unauthorized'>;
  recordResult(input: { tokenHash: Buffer; result: ResultReport }): Promise<'recorded' | 'duplicate' | 'not_found' | 'conflict' | 'unauthorized'>;
}

interface CommandRow {
  id: string; server_id: string; target_key: string; service_name: string | null; target_identity: string | null; action: ControlAction; status: CommandView['status']; reason: string | null;
  requested_by: string; requested_at: Date; deadline_at: Date; dispatched_at: Date | null; completed_at: Date | null;
  attempts: number; result: { before?: { status: string } | null; after?: { status: string } | null } | null;
  [key: string]: unknown;
}
const COMMAND_COLUMNS = 'id, server_id, target_key, service_name, target_identity, action, status, reason, requested_by, requested_at, deadline_at, dispatched_at, completed_at, attempts, result';
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toView(r: CommandRow): CommandView {
  return {
    id: r.id, serverId: r.server_id, targetKey: r.target_key, serviceName: r.service_name, action: r.action, status: r.status, reason: r.reason, requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(), deadlineAt: r.deadline_at.toISOString(), dispatchedAt: iso(r.dispatched_at),
    completedAt: iso(r.completed_at), attempts: r.attempts, before: r.result?.before ?? null, after: r.result?.after ?? null,
  };
}

const UNIQUE_VIOLATION = '23505';

// serviceName: the command's verified service name (stored with the command at request time), so the audit row keeps
// a readable name even after the target key is reused (ADR-033).
async function audit(tx: QueryClient, event: ProcessCommandEvent, outcome: 'success' | 'failure' | 'denied', c: { id: string; server_id: string; target_key: string; action: string; service_name: string | null }, reason: string | null, actorUserId: string | null, requestId: string | null) {
  await insertAudit(tx, {
    event, outcome,
    details: { serverId: c.server_id, commandId: c.id, targetKey: c.target_key, action: c.action, ...(reason ? { reason } : {}), ...(c.service_name ? { serviceName: c.service_name } : {}) },
  }, { actorUserId, requestId });
}

const OUTCOME_AUDIT: Record<ResultReport['outcome'], { event: ProcessCommandEvent; outcome: 'success' | 'failure' }> = {
  succeeded: { event: 'process.command_succeeded', outcome: 'success' },
  failed: { event: 'process.command_failed', outcome: 'failure' },
  rejected: { event: 'process.command_rejected', outcome: 'failure' },
  expired: { event: 'process.command_expired', outcome: 'failure' },
  unknown: { event: 'process.command_unknown', outcome: 'failure' },
};

const serverForToken = lockAgentServer;

async function clock(tx: QueryClient): Promise<Date> {
  const r = await tx.query<{ t: Date }>('SELECT clock_timestamp() AS t');
  const t = r.rows[0]?.t;
  if (!t) throw new Error('clock query returned no row');
  return t;
}

export function createPgControlStore(db: Database): ControlStore {
  return {
    async controlView(serverId, scope) {
      const head = await db.query<{ server_status: ServerStatus; broker_state: 'ok' | 'unavailable' | null; daemon_state: 'ok' | 'unavailable' | null; allowlist: 'ok' | 'invalid' | null; reported_at: Date | null; fresh: boolean | null; protocol: number | null; mode: BrokerMode | null; targets_total: number | null; total_visible: boolean; [k: string]: unknown }>(
        `SELECT CASE WHEN h.received_at IS NULL THEN 'never_connected'
                     WHEN h.received_at > now() - make_interval(secs => ${String(ONLINE_WINDOW_SECONDS)}) THEN 'online' ELSE 'offline' END AS server_status,
                cs.broker_state, cs.daemon_state, cs.allowlist, cs.reported_at, cs.protocol, cs.mode, cs.targets_total,
                cs.reported_at > now() - make_interval(secs => ${String(TARGET_FRESH_SECONDS)}) AS fresh,
                -- The broker's total counts EVERY process of the owner: only for readers who may see all services of
                -- this server (admin, or an "all" grant); a selected grant never learns how many others exist (ADR-028).
                ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM user_server_access g WHERE g.user_id = $2::uuid AND g.server_id = s.id AND g.mode = 'all')) AS total_visible
           FROM servers s
           LEFT JOIN server_heartbeats h ON h.server_id = s.id
           LEFT JOIN server_control_status cs ON cs.server_id = s.id
          WHERE s.id = $1 AND ${serverVisibleSql('s.id', '$2')}`,
        [serverId, scope],
      );
      const r = head.rows[0];
      if (!r) return null;
      const targets = await db.query<{ target_key: string; name: string; pm_id: number | null; actions: ControlAction[]; match_status: MatchStatus; [k: string]: unknown }>(
        `SELECT t.target_key, t.name, t.pm_id, t.actions, t.match_status FROM server_control_targets t
          WHERE t.server_id = $1 AND ${serviceVisibleSql('t.server_id', 't.name', '$2')} ORDER BY t.name, t.target_key`,
        [serverId, scope],
      );
      return {
        serverId,
        serverStatus: r.server_status,
        broker: r.broker_state && r.reported_at
          ? { state: r.broker_state, daemon: r.daemon_state, allowlist: r.allowlist, reportedAt: r.reported_at.toISOString(), fresh: r.fresh === true, mode: r.mode, protocol: r.protocol === 2 ? 2 : 1, total: r.total_visible ? r.targets_total : null }
          : null,
        targets: targets.rows.map((t) => ({ targetKey: t.target_key, name: t.name, pmId: t.pm_id, actions: t.actions, matchStatus: t.match_status })),
      };
    },

    createCommand({ serverId, targetKey, action, idempotencyKey, actorUserId, actorRole, requestId }) {
      return db.transaction(async (tx): Promise<CreateResult> => {
        // The actor as it is NOW, locked against a concurrent role change / deactivation until this transaction ends.
        const actor = await tx.query<{ role: string; is_active: boolean }>('SELECT role, is_active FROM users WHERE id = $1 FOR SHARE', [actorUserId]);
        const a = actor.rows[0];
        if (!a?.is_active || a.role !== actorRole || !hasPermission(a.role, 'processes:control')) return 'not_found';
        const scope = scopeOf({ role: a.role, userId: actorUserId });
        const existing = await tx.query<CommandRow>(`SELECT ${COMMAND_COLUMNS} FROM control_commands WHERE requested_by = $1 AND idempotency_key = $2`, [actorUserId, idempotencyKey]);
        const replay = existing.rows[0];
        if (replay) {
          if (replay.server_id !== serverId || replay.target_key !== targetKey || replay.action !== action) return 'idempotency_conflict';
          // A replay after the access was revoked does not return the command either.
          if (!(await serviceGranted(tx, scope, replay.server_id, replay.service_name ?? '', true)) && scope !== null) return 'not_found';
          return { command: toView(replay), created: false };
        }
        const server = await tx.query<{ online: boolean; [k: string]: unknown }>(
          `SELECT COALESCE(h.received_at > now() - make_interval(secs => ${String(ONLINE_WINDOW_SECONDS)}), false) AS online
             FROM servers s LEFT JOIN server_heartbeats h ON h.server_id = s.id
            WHERE s.id = $1 AND s.is_active AND ${serverVisibleSql('s.id', '$2')} FOR SHARE OF s`,
          [serverId, scope],
        );
        const srv = server.rows[0];
        if (!srv) return 'not_found';
        const target = await tx.query<{ actions: ControlAction[]; name: string; identity: string | null; ok: boolean; [k: string]: unknown }>(
          `SELECT t.actions, t.name, t.identity,
                  (t.match_status = 'ok' AND cs.broker_state = 'ok' AND cs.reported_at > now() - make_interval(secs => ${String(TARGET_FRESH_SECONDS)})) AS ok
             FROM server_control_targets t JOIN server_control_status cs ON cs.server_id = t.server_id
            WHERE t.server_id = $1 AND t.target_key = $2`,
          [serverId, targetKey],
        );
        const t = target.rows[0];
        // The grant is checked (and locked) for the service the target belongs to; a hidden one is "not found".
        if (t && !(await serviceGranted(tx, scope, serverId, t.name, true))) return 'not_found';
        if (!srv.online) return 'server_offline';
        if (!t?.ok) return 'target_unavailable';
        if (!t.actions.includes(action)) return 'action_not_allowed';
        const now = await clock(tx);
        await tx.query('SAVEPOINT create_command');
        let inserted: CommandRow | undefined;
        try {
          const ins = await tx.query<CommandRow>(
            `INSERT INTO control_commands (server_id, target_key, service_name, target_identity, action, requested_by, idempotency_key, requested_at, deadline_at)
             VALUES ($1, $2, $7, $8, $3, $4, $5, $6::timestamptz, $6::timestamptz + make_interval(secs => ${String(COMMAND_DEADLINE_SECONDS)}))
             RETURNING ${COMMAND_COLUMNS}`,
            [serverId, targetKey, action, actorUserId, idempotencyKey, now, t.name, t.identity],
          );
          inserted = ins.rows[0];
        } catch (error) {
          const e = error as { code?: string; constraint?: string };
          if (e.code !== UNIQUE_VIOLATION) throw error;
          await tx.query('ROLLBACK TO SAVEPOINT create_command');
          if (e.constraint === 'control_commands_one_active_idx') return 'command_in_progress';
          // Same key inserted concurrently: compare with the winner.
          const again = await tx.query<CommandRow>(`SELECT ${COMMAND_COLUMNS} FROM control_commands WHERE requested_by = $1 AND idempotency_key = $2`, [actorUserId, idempotencyKey]);
          const winner = again.rows[0];
          if (winner && winner.server_id === serverId && winner.target_key === targetKey && winner.action === action) return { command: toView(winner), created: false };
          return 'idempotency_conflict';
        }
        if (!inserted) throw new Error('command insert returned no row');
        await audit(tx, 'process.command_requested', 'success', inserted, null, actorUserId, requestId);
        return { command: toView(inserted), created: true };
      });
    },

    async listCommands(serverId, limit, targetKey, scope) {
      const exists = await db.query(`SELECT 1 FROM servers s WHERE s.id = $1 AND ${serverVisibleSql('s.id', '$2')}`, [serverId, scope]);
      if (exists.rows.length === 0) return null;
      const { rows } = await db.query<CommandRow>(
        `SELECT ${COMMAND_COLUMNS} FROM control_commands c
          WHERE c.server_id = $1 AND ($3::text IS NULL OR c.target_key = $3::text) AND ${serviceVisibleSql('c.server_id', 'c.service_name', '$4')}
          ORDER BY c.requested_at DESC, c.id LIMIT $2`,
        [serverId, limit, targetKey, scope],
      );
      return rows.map(toView);
    },

    async getCommand(id, scope) {
      const { rows } = await db.query<CommandRow>(
        `SELECT ${COMMAND_COLUMNS} FROM control_commands c WHERE c.id = $1 AND ${serviceVisibleSql('c.server_id', 'c.service_name', '$2')}`,
        [id, scope],
      );
      return rows[0] ? toView(rows[0]) : null;
    },

    poll({ tokenHash, report, controlEnabled }) {
      return db.transaction(async (tx) => {
        const serverId = await serverForToken(tx, tokenHash);
        if (!serverId) return 'unauthorized' as const;
        // One poll per server at a time, without queueing: a concurrent poll (e.g. overlapping Agent restarts)
        // gets no command and changes nothing instead of waiting for row locks.
        const lock = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended('nc-control:' || $1::text, 0)) AS ok`, [serverId]);
        if (lock.rows[0]?.ok !== true) return { commands: [] };
        const now = await clock(tx);

        // 1. Latest broker state and targets (replaced as a whole).
        await tx.query(
          `INSERT INTO server_control_status (server_id, broker_state, daemon_state, allowlist, reported_at, protocol, mode, targets_total) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (server_id) DO UPDATE SET broker_state = EXCLUDED.broker_state, daemon_state = EXCLUDED.daemon_state,
             allowlist = EXCLUDED.allowlist, reported_at = EXCLUDED.reported_at, protocol = EXCLUDED.protocol, mode = EXCLUDED.mode, targets_total = EXCLUDED.targets_total`,
          [serverId, report.broker, report.daemon, report.allowlist, now, report.version, report.version === 2 ? (report.mode ?? null) : null, report.version === 2 ? (report.total ?? report.targets.length) : null],
        );
        await tx.query('DELETE FROM server_control_targets WHERE server_id = $1', [serverId]);
        if (report.targets.length > 0) {
          const t = report.targets;
          await tx.query(
            `INSERT INTO server_control_targets (server_id, target_key, name, pm_id, actions, match_status, identity)
             SELECT $1, u.k, u.n, u.p, string_to_array(u.a, ','), u.m, u.i
               FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[]) AS u(k, n, p, a, m, i)`,
            [serverId, t.map((x) => x.targetKey), t.map((x) => x.name), t.map((x) => x.pmId), t.map((x) => x.actions.join(',')), t.map((x) => x.matchStatus), t.map((x) => x.identity ?? null)],
          );
        }

        // 2. Housekeeping: never-dispatched commands past the deadline expire; dispatched ones without any result
        //    after deadline + grace become unknown (they may have run — never re-executed automatically).
        const expired = await tx.query<CommandRow>(
          `UPDATE control_commands SET status = 'expired', reason = 'not_dispatched', completed_at = $2
            WHERE server_id = $1 AND status = 'queued' AND deadline_at <= $2 RETURNING ${COMMAND_COLUMNS}`,
          [serverId, now],
        );
        for (const c of expired.rows) await audit(tx, 'process.command_expired', 'failure', c, 'not_dispatched', null, null);
        const unknown = await tx.query<CommandRow>(
          `UPDATE control_commands SET status = 'unknown', reason = 'no_result', completed_at = $2, lease_until = NULL
            WHERE server_id = $1 AND status = 'dispatched' AND deadline_at + make_interval(secs => ${String(RESULT_GRACE_SECONDS)}) <= $2::timestamptz
            RETURNING ${COMMAND_COLUMNS}`,
          [serverId, now],
        );
        for (const c of unknown.rows) await audit(tx, 'process.command_unknown', 'failure', c, 'no_result', null, null);

        if (!controlEnabled) return { commands: [] };

        // 3. One executor per server: nothing new while a delivery holds a valid lease.
        const busy = await tx.query('SELECT 1 FROM control_commands WHERE server_id = $1 AND status = $2 AND lease_until > $3 LIMIT 1', [serverId, 'dispatched', now]);
        if (busy.rows.length > 0) return { commands: [] };

        const pick = await tx.query<CommandRow>(
          `SELECT ${COMMAND_COLUMNS} FROM control_commands
            WHERE server_id = $1 AND deadline_at > $2
              AND (status = 'queued' OR (status = 'dispatched' AND lease_until <= $2 AND attempts < ${String(MAX_ATTEMPTS)}))
            ORDER BY requested_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [serverId, now],
        );
        const c = pick.rows[0];
        if (!c) return { commands: [] };

        // 4. Re-check at claim time: current role/active flag AND resource grant of the requester (ADR-028: access
        //    revoked after the request means the queued command is never handed to the Agent), and the reported target
        //    (same service name, same process definition identity when the command recorded one).
        const actor = await tx.query<{ role: string; is_active: boolean }>('SELECT role, is_active FROM users WHERE id = $1 FOR SHARE', [c.requested_by]);
        const a = actor.rows[0];
        const actorOk = a !== undefined && a.is_active && hasPermission(a.role, 'processes:control')
          && (a.role === 'admin' || (c.service_name !== null && await serviceGranted(tx, scopeOf({ role: a.role, userId: c.requested_by }), c.server_id, c.service_name, true)));
        const target = report.targets.find((t) => t.targetKey === c.target_key);
        const sameService = !target || c.service_name === null || target.name === c.service_name;
        const sameIdentity = c.target_identity === null || target?.identity === c.target_identity;
        const targetOk = report.broker === 'ok' && target?.matchStatus === 'ok' && target.actions.includes(c.action) && sameService && sameIdentity;
        if (!actorOk || !targetOk) {
          if (c.status === 'queued') {
            const reason = !actorOk ? 'actor_not_authorized' : !target || target.matchStatus !== 'ok' ? 'target_unavailable'
              : !sameService || !sameIdentity ? 'target_changed' : 'action_not_allowed';
            await tx.query(`UPDATE control_commands SET status = 'rejected', reason = $2, completed_at = $3 WHERE id = $1`, [c.id, reason, now]);
            await audit(tx, 'process.command_rejected', 'failure', c, reason, null, null);
          }
          // A redelivery that fails the re-check is NOT delivered (it may already have run); it ends as unknown.
          return { commands: [] };
        }

        const attempt = c.attempts + 1;
        await tx.query(
          `UPDATE control_commands SET status = 'dispatched', attempts = $2, lease_until = $3::timestamptz + make_interval(secs => ${String(LEASE_SECONDS)}),
                  dispatched_at = COALESCE(dispatched_at, $3::timestamptz) WHERE id = $1`,
          [c.id, attempt, now],
        );
        await audit(tx, 'process.command_dispatched', 'success', c, null, null, null);
        return { commands: [{ id: c.id, attempt, targetKey: c.target_key, action: c.action, deadlineAt: c.deadline_at.toISOString(), ...(report.version === 2 ? { identity: c.target_identity } : {}) }] };
      });
    },

    recordResult({ tokenHash, result }) {
      return db.transaction(async (tx) => {
        const serverId = await serverForToken(tx, tokenHash);
        if (!serverId) return 'unauthorized' as const;
        const found = await tx.query<CommandRow>(`SELECT ${COMMAND_COLUMNS} FROM control_commands WHERE id = $1 AND server_id = $2 FOR UPDATE`, [result.commandId, serverId]);
        const c = found.rows[0];
        if (!c) return 'not_found' as const;
        if (c.status === result.outcome && (c.status !== 'unknown' || c.reason === result.reason)) return 'duplicate' as const;
        // Only a dispatched command, or one that became unknown for lack of a result, accepts a result. A late but
        // confirmed result replaces `unknown/no_result` (reconciliation); anything else is a conflict.
        const open = c.status === 'dispatched' || (c.status === 'unknown' && c.reason === 'no_result');
        if (!open || result.attempt > c.attempts) return 'conflict' as const;
        const now = await clock(tx);
        await tx.query(
          `UPDATE control_commands SET status = $2, reason = $3, completed_at = $4, lease_until = NULL, result = $5::jsonb WHERE id = $1`,
          [c.id, result.outcome, result.reason, now, JSON.stringify({ before: result.before, after: result.after })],
        );
        const a = OUTCOME_AUDIT[result.outcome];
        await audit(tx, a.event, a.outcome, c, result.reason, null, null);
        return 'recorded' as const;
      });
    },
  };
}
