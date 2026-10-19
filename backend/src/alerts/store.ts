import type { Database, QueryClient } from '../database.js';
import { INVENTORY_STATE_SQL, SERVER_STATUS_SQL } from '../servers/inventory-store.js';
import { type ConditionRow, type Detail, evaluate, type EvaluationResult, MAX_SAMPLES, type ProcessObs, type Resolution, RETIRED_RULES, type Rule, type ServerObs, type Severity, type Transition } from './rules.js';
import type { MessageIncident } from './slack.js';
import type { EvaluationConfig } from './settings.js';

// Alerts persistence (ADR-021). Parameterized SQL only.
//  * evaluation: ONE transaction (REPEATABLE READ: a consistent snapshot) under a transaction-scoped advisory lock, so
//    evaluations never run concurrently (other API processes/cycles skip); incident transitions, condition state and
//    outbox rows commit together or not at all;
//  * delivery: outbox rows claimed with FOR UPDATE SKIP LOCKED + a lease; a result is written only by the claim that
//    still owns the row (status = 'sending' AND attempts = claimed attempts);
//  * order within one incident: a recovery/reminder is claimable only after its problem message of the SAME generation
//    ended as sent or unknown (announced) and nothing older of that incident is still queued/sending; if that problem
//    can no longer be announced (failed, cancelled, dropped, another generation) the dependant is cancelled.

export const EVALUATION_LOCK = 7_301_013_001; // advisory lock id (bigint) reserved for the alerts evaluator
export const RETENTION = Object.freeze({ outboxDays: 30, incidentDays: 90, batch: 500 });
export const LEASE_SECONDS = 60;
const MAX_PROCESSES = 20_000;

export type OutboxKind = 'firing' | 'resolved' | 'reminder';
export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'dropped' | 'cancelled';

export interface EvaluationSummary { skipped: boolean; opened: number; resolved: number; observed: number; enqueued: number; dropped: number; retired: number; at: string | null }

export interface ClaimedItem { id: string; kind: OutboxKind; attempts: number; incident: MessageIncident }

export interface IncidentView {
  id: string; rule: Rule; severity: Severity; status: 'firing' | 'resolved'; resolution: Resolution | null;
  serverId: string; serverName: string; serverStatus: 'online' | 'offline' | 'never_connected' | 'inactive';
  processName: string | null; pmId: number | null; detail: Detail;
  openedAt: string; lastObservedAt: string; resolvedAt: string | null;
  /** Admin only (alerts:manage); null otherwise. */
  notification: { notify: boolean; state: OutboxStatus | 'none'; attempts: number; lastError: string | null } | null;
}

export interface AlertsStore {
  evaluateOnce(config: EvaluationConfig): Promise<EvaluationSummary>;
  /** Claims only items of the given integration generation (never another address). */
  claim(limit: number, generation: number): Promise<ClaimedItem[]>;
  finish(item: { id: string; attempts: number }, outcome: { status: 'sent' } | { status: 'queued'; code: string; delaySeconds: number } | { status: 'failed' | 'unknown'; code: string }): Promise<boolean>;
  listIncidents(input: { state: 'active' | 'resolved'; limit: number; before: string | null; withDelivery: boolean }): Promise<{ items: IncidentView[]; nextBefore: string | null }>;
  summary(withQueue: boolean): Promise<{ active: number; queue: Record<OutboxStatus, number> | null; lastSentAt: string | null }>;
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : null);

async function loadSnapshot(tx: QueryClient): Promise<ServerObs[]> {
  const servers = (await tx.query(`
    SELECT s.id, s.name, ${SERVER_STATUS_SQL} AS status, h.received_at, ${INVENTORY_STATE_SQL} AS inv,
           i.reported_at, i.inventory_collected_at
      FROM servers s LEFT JOIN server_heartbeats h ON h.server_id = s.id LEFT JOIN server_inventories i ON i.server_id = s.id
     WHERE s.is_active ORDER BY s.id`)).rows;
  const procs = (await tx.query(`
    SELECT a.server_id, a.source, a.pm_id, a.name, a.status, a.cpu_percent::float8 AS cpu, a.restarts, a.first_seen_at
      FROM server_applications a JOIN servers s ON s.id = a.server_id WHERE s.is_active
     ORDER BY a.server_id, a.source, a.pm_id LIMIT $1`, [MAX_PROCESSES])).rows;
  const byServer = new Map<string, ProcessObs[]>();
  for (const p of procs) {
    const list = byServer.get(String(p.server_id)) ?? [];
    list.push({
      source: String(p.source), pmId: Number(p.pm_id), name: String(p.name), status: String(p.status),
      cpuPercent: p.cpu === null ? null : Number(p.cpu), restarts: p.restarts === null ? null : Number(p.restarts), firstSeenAt: iso(p.first_seen_at) ?? '',
    });
    byServer.set(String(p.server_id), list);
  }
  return servers.map((s: Row): ServerObs => {
    return {
      id: String(s.id), name: String(s.name), status: s.status as ServerObs['status'], heartbeatAt: ms(s.received_at),
      inventory: { state: s.inv as ServerObs['inventory']['state'], reportedAt: ms(s.reported_at), collectedAt: ms(s.inventory_collected_at) },
      processes: byServer.get(String(s.id)) ?? [],
    };
  });
}

/**
 * Streaks counted under older rule thresholds are not carried into the new rules: pending → ok, recovering → firing.
 * Open incidents, cooldown history and restart baselines are kept.
 */
async function loadConditions(tx: QueryClient, rulesRevision: number): Promise<ConditionRow[]> {
  const { rows } = await tx.query('SELECT condition_key, server_id, rule, process_key, state, streak, last_sample_at, samples, incident_id, rules_revision FROM alert_conditions');
  return rows.map((r: Row) => {
    const row = toCondition(r);
    if (Number(r.rules_revision) === rulesRevision) return row;
    if (row.state === 'pending') return { ...row, state: 'ok' as const, streak: 0 };
    if (row.state === 'recovering') return { ...row, state: 'firing' as const, streak: 0 };
    return row;
  });
}

function toCondition(r: Row): ConditionRow {
  return ({
    key: String(r.condition_key), serverId: String(r.server_id), rule: r.rule as Rule, processKey: (r.process_key as string | null) ?? null,
    state: r.state as ConditionRow['state'], streak: Number(r.streak), lastSampleAt: ms(r.last_sample_at),
    samples: (r.samples as ConditionRow['samples']), incidentId: (r.incident_id as string | null) ?? null,
  });
}

const RETIRED = [...RETIRED_RULES] as string[];

/**
 * Queued notifications of retired rules are never sent: cancelled like any other no-longer-valid item. A row still
 * leased by a running delivery finishes normally (its message is a problem/reminder, never a fake recovery); if that
 * delivery puts it back to "queued" or its lease expires, the next call cancels it. Idempotent.
 */
async function cancelRetiredOutbox(q: QueryClient | Database): Promise<number> {
  const r = await q.query(
    `UPDATE alert_outbox o SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = 'rule_retired'
       FROM alert_incidents i
      WHERE i.id = o.incident_id AND i.rule = ANY($1::text[])
        AND (o.status = 'queued' OR (o.status = 'sending' AND o.lease_until < now()))`, [RETIRED]);
  return r.rowCount ?? 0;
}

/** The problem message of the same incident AND generation ended as delivered or possibly delivered. */
const ANNOUNCED = `EXISTS (SELECT 1 FROM alert_outbox f WHERE f.incident_id = o.incident_id AND f.kind = 'firing' AND f.generation = o.generation
                          AND f.status IN ('sent', 'unknown'))`;
/** …or may still be: queued/sending in the same generation. */
const ANNOUNCEABLE = `EXISTS (SELECT 1 FROM alert_outbox f WHERE f.incident_id = o.incident_id AND f.kind = 'firing' AND f.generation = o.generation
                          AND f.status IN ('queued', 'sending', 'sent', 'unknown'))`;

/**
 * A recovery/reminder whose problem message can no longer be announced to its channel (failed permanently, cancelled,
 * dropped, missing or of another generation) is cancelled: never sent alone, never left waiting forever. Idempotent;
 * a row still leased by a running delivery is left to finish.
 */
async function cancelUnannounced(q: QueryClient | Database): Promise<number> {
  const r = await q.query(
    `UPDATE alert_outbox o SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = 'problem_not_announced'
      WHERE o.kind <> 'firing' AND (o.status = 'queued' OR (o.status = 'sending' AND o.lease_until < now())) AND NOT ${ANNOUNCEABLE}`);
  return r.rowCount ?? 0;
}

/** A reminder ("still ongoing") of an incident that is no longer firing: its future attempts are obsolete. */
const OBSOLETE_REMINDER = `o.kind = 'reminder' AND EXISTS (SELECT 1 FROM alert_incidents r WHERE r.id = o.incident_id AND r.status = 'resolved')`;

/**
 * Reminders of resolved incidents never start another attempt: queued ones and ones whose lease expired are cancelled
 * (`superseded`). A reminder still leased by a running delivery finishes that one attempt (its HTTP request may already
 * be out and cannot be recalled); finish() then cancels it instead of re-queueing. Idempotent.
 */
async function cancelObsoleteReminders(q: QueryClient | Database): Promise<number> {
  const r = await q.query(
    `UPDATE alert_outbox o SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = 'superseded'
      WHERE ${OBSOLETE_REMINDER} AND (o.status = 'queued' OR (o.status = 'sending' AND o.lease_until < now()))`);
  return r.rowCount ?? 0;
}

/**
 * Takes retired rules out of service inside the evaluation transaction: open incidents are closed as "retired"
 * (no recovery message is queued), their pending notifications are cancelled and their condition state is dropped.
 * Migration 1791900000008 does the same once at deploy; this repeats it for anything an older API created meanwhile.
 */
async function retireRules(tx: QueryClient, now: Date): Promise<number> {
  const closed = await tx.query(
    `UPDATE alert_incidents SET status = 'resolved', resolution = 'retired', resolved_at = $2, last_observed_at = GREATEST(last_observed_at, $2)
      WHERE rule = ANY($1::text[]) AND status = 'firing'`, [RETIRED, now]);
  await cancelRetiredOutbox(tx);
  await tx.query('DELETE FROM alert_conditions WHERE rule = ANY($1::text[])', [RETIRED]);
  return closed.rowCount ?? 0;
}

/** Enqueue (bounded): beyond queueMax pending rows the item is recorded as dropped instead of growing the queue. */
async function enqueue(tx: QueryClient, incidentId: string, kind: OutboxKind, queueMax: number, generation: number): Promise<'queued' | 'dropped'> {
  const pending = Number((await tx.query("SELECT count(*) AS n FROM alert_outbox WHERE status IN ('queued', 'sending')")).rows[0]?.n ?? 0);
  if (pending >= queueMax) {
    await tx.query(
      `INSERT INTO alert_outbox (incident_id, kind, status, last_error, finished_at, generation) VALUES ($1, $2, 'dropped', 'queue_full', now(), $3)
       ON CONFLICT DO NOTHING`, [incidentId, kind, generation]);
    return 'dropped';
  }
  await tx.query('INSERT INTO alert_outbox (incident_id, kind, generation) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [incidentId, kind, generation]);
  return 'queued';
}

async function applyTransitions(tx: QueryClient, result: EvaluationResult, config: EvaluationConfig, now: Date): Promise<Omit<EvaluationSummary, 'skipped' | 'at' | 'retired'>> {
  const opened = new Map<string, string>();
  let enqueued = 0;
  let dropped = 0;
  let observed = 0;
  let resolved = 0;
  const at = (t: Transition) => (t.observedAt > 0 ? new Date(t.observedAt) : now);
  const send = async (incidentId: string, kind: OutboxKind) => {
    if (!config.deliveryEnabled || config.generation === null) return;
    if ((await enqueue(tx, incidentId, kind, config.queueMax, config.generation)) === 'queued') enqueued += 1; else dropped += 1;
  };
  for (const t of result.transitions) {
    if (t.kind === 'open') {
      // Flapping guard: re-opened within the cooldown after a resolution → recorded but not notified (nor its recovery).
      const recent = await tx.query(
        "SELECT 1 FROM alert_incidents WHERE condition_key = $1 AND status = 'resolved' AND resolved_at > $2::timestamptz - make_interval(secs => $3) LIMIT 1",
        [t.key, now, config.cooldownSeconds]);
      const notify = recent.rows.length === 0;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO alert_incidents (condition_key, server_id, rule, severity, server_name, process_name, pm_id, detail, notify, opened_at, last_observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)
         ON CONFLICT (condition_key) WHERE status = 'firing' DO NOTHING RETURNING id`,
        [t.key, t.serverId, t.rule, t.severity, t.serverName.slice(0, 100), t.processName?.slice(0, 128) ?? null, t.pmId, JSON.stringify(t.detail), notify, at(t)]);
      let id = ins.rows[0]?.id;
      if (!id) id = (await tx.query<{ id: string }>("SELECT id FROM alert_incidents WHERE condition_key = $1 AND status = 'firing'", [t.key])).rows[0]?.id ?? '';
      else if (notify) await send(id, 'firing');
      opened.set(t.key, id);
    } else if (t.kind === 'observe') {
      observed += 1;
      await tx.query("UPDATE alert_incidents SET last_observed_at = GREATEST(last_observed_at, $2), detail = $3::jsonb WHERE id = $1 AND status = 'firing'",
        [t.incidentId, at(t), JSON.stringify(t.detail)]);
    } else {
      const upd = await tx.query<{ notify: boolean }>(
        `UPDATE alert_incidents SET status = 'resolved', resolution = $2, resolved_at = $3,
                last_observed_at = GREATEST(last_observed_at, $3), detail = CASE WHEN $4::jsonb = '{}'::jsonb THEN detail ELSE $4::jsonb END
          WHERE id = $1 AND status = 'firing' RETURNING notify`,
        [t.incidentId, t.resolution, at(t), JSON.stringify(t.detail)]);
      if (upd.rows[0]) {
        resolved += 1;
        // A recovery is queued only if the problem was (or may still be) announced to the SAME channel — the generation
        // the recovery would be sent to: delivered, possibly delivered (unknown) or still on its way (queued/sending;
        // claim then holds the recovery until the problem has ended). Never for a problem that was dropped, cancelled,
        // failed permanently or announced to a previous webhook (that channel is no longer ours, the new one never saw it).
        // A reminder still waiting is obsolete: cancelled, so "still ongoing" never follows "recovered".
        await tx.query(
          "UPDATE alert_outbox SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = 'superseded' WHERE incident_id = $1 AND kind = 'reminder' AND status = 'queued'",
          [t.incidentId]);
        const announced = config.generation === null ? { rows: [] } : await tx.query(
          "SELECT 1 FROM alert_outbox WHERE incident_id = $1 AND kind = 'firing' AND generation = $2 AND status IN ('queued', 'sending', 'sent', 'unknown')",
          [t.incidentId, config.generation]);
        if (upd.rows[0].notify && announced.rows.length > 0) await send(t.incidentId, 'resolved');
      }
    }
  }
  for (const row of result.upserts) {
    const incidentId = row.state === 'firing' || row.state === 'recovering' ? (opened.get(row.key) ?? row.incidentId) : null;
    await tx.query(
      `INSERT INTO alert_conditions (condition_key, server_id, rule, process_key, state, streak, last_sample_at, samples, incident_id, updated_at, rules_revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
       ON CONFLICT (condition_key) DO UPDATE SET state = EXCLUDED.state, streak = EXCLUDED.streak, last_sample_at = EXCLUDED.last_sample_at,
         samples = EXCLUDED.samples, incident_id = EXCLUDED.incident_id, updated_at = EXCLUDED.updated_at, rules_revision = EXCLUDED.rules_revision`,
      [row.key, row.serverId, row.rule, row.processKey, row.state, Math.min(row.streak, 1000), row.lastSampleAt === null ? null : new Date(row.lastSampleAt),
        JSON.stringify(row.samples.slice(-MAX_SAMPLES)), incidentId, now, config.rulesRevision]);
  }
  if (result.deletes.length > 0) await tx.query('DELETE FROM alert_conditions WHERE condition_key = ANY($1::text[])', [result.deletes]);

  // Optional reminders for incidents still firing (bounded).
  if (config.reminderSeconds > 0 && config.deliveryEnabled && config.generation !== null) {
    const due = await tx.query<{ id: string }>(
      `SELECT i.id FROM alert_incidents i
        WHERE i.status = 'firing' AND i.notify
          AND EXISTS (SELECT 1 FROM alert_outbox o WHERE o.incident_id = i.id AND o.kind = 'firing' AND o.generation = $3
                        AND o.status IN ('queued', 'sending', 'sent', 'unknown'))
          AND NOT EXISTS (SELECT 1 FROM alert_outbox o WHERE o.incident_id = i.id AND o.created_at > $1::timestamptz - make_interval(secs => $2))
        ORDER BY i.opened_at LIMIT 20`, [now, config.reminderSeconds, config.generation]);
    for (const r of due.rows) await send(r.id, 'reminder');
  }
  // Retention: only this feature's own tables, bounded batches.
  await tx.query(`DELETE FROM alert_outbox WHERE id IN (SELECT id FROM alert_outbox WHERE finished_at < $1::timestamptz - make_interval(days => ${String(RETENTION.outboxDays)}) LIMIT ${String(RETENTION.batch)})`, [now]);
  await tx.query(`DELETE FROM alert_incidents WHERE id IN (SELECT id FROM alert_incidents WHERE status = 'resolved' AND resolved_at < $1::timestamptz - make_interval(days => ${String(RETENTION.incidentDays)}) LIMIT ${String(RETENTION.batch)})`, [now]);
  return { opened: opened.size, resolved, observed, enqueued, dropped };
}

const INCIDENT_COLUMNS = `i.id, i.rule, i.severity, i.status, i.resolution, i.server_id, i.server_name, i.process_name, i.pm_id, i.detail,
       i.opened_at, i.last_observed_at, i.resolved_at, i.notify`;

function toMessage(r: Row): MessageIncident {
  return {
    id: String(r.id), rule: r.rule as Rule, severity: r.severity as Severity, serverId: String(r.server_id), serverName: String(r.server_name),
    processName: (r.process_name as string | null) ?? null, pmId: r.pm_id === null ? null : Number(r.pm_id), detail: r.detail as Detail,
    openedAt: iso(r.opened_at) ?? '', lastObservedAt: iso(r.last_observed_at) ?? '', resolvedAt: iso(r.resolved_at), resolution: (r.resolution as Resolution | null) ?? null,
  };
}

export function createPgAlertsStore(db: Database): AlertsStore {
  return {
    evaluateOnce(config) {
      return db.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const lock = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [EVALUATION_LOCK]);
        if (!lock.rows[0]?.ok) return { skipped: true, opened: 0, resolved: 0, observed: 0, enqueued: 0, dropped: 0, retired: 0, at: null };
        const now = (await tx.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now ?? new Date();
        const retired = await retireRules(tx, now);
        const servers = await loadSnapshot(tx);
        const conditions = await loadConditions(tx, config.rulesRevision);
        const result = evaluate(servers, conditions, config.thresholds);
        const counts = await applyTransitions(tx, result, config, now);
        return { skipped: false, ...counts, retired, at: now.toISOString() };
      });
    },

    async claim(limit, generation) {
      await cancelRetiredOutbox(db);
      await cancelObsoleteReminders(db);
      await cancelUnannounced(db);
      // Dependency, not just order: a recovery/reminder waits until its problem message (same generation) has ended as
      // sent/unknown AND no older item of the incident is queued/sending — whatever backoff or lease that item is in.
      // Checked against committed rows: a concurrent claim that has just taken the problem still sees it queued/sending.
      const { rows } = await db.query(
        `WITH picked AS (
           SELECT o.id FROM alert_outbox o
            WHERE o.generation = $3 AND ((o.status = 'queued' AND o.next_attempt_at <= now()) OR (o.status = 'sending' AND o.lease_until < now()))
              AND NOT EXISTS (SELECT 1 FROM alert_incidents i WHERE i.id = o.incident_id AND i.rule = ANY($4::text[]))
              AND NOT (${OBSOLETE_REMINDER})
              AND (o.kind = 'firing' OR (${ANNOUNCED}
                   AND NOT EXISTS (SELECT 1 FROM alert_outbox e WHERE e.incident_id = o.incident_id AND e.id < o.id AND e.status IN ('queued', 'sending'))))
            ORDER BY o.next_attempt_at, o.id LIMIT $1 FOR UPDATE OF o SKIP LOCKED)
         UPDATE alert_outbox o SET status = 'sending', attempts = LEAST(o.attempts + 1, 20), lease_until = now() + make_interval(secs => $2)
           FROM picked WHERE o.id = picked.id
         RETURNING o.id::text AS outbox_id, o.kind, o.attempts, o.incident_id`, [limit, LEASE_SECONDS, generation, RETIRED]);
      if (rows.length === 0) return [];
      const incidents = await db.query(`SELECT ${INCIDENT_COLUMNS} FROM alert_incidents i WHERE i.id = ANY($1::uuid[])`, [rows.map((r: Row) => r.incident_id)]);
      const byId = new Map(incidents.rows.map((r: Row) => [String(r.id), toMessage(r)]));
      return rows.flatMap((r: Row) => {
        const incident = byId.get(String(r.incident_id));
        return incident ? [{ id: String(r.outbox_id), kind: r.kind as OutboxKind, attempts: Number(r.attempts), incident }] : [];
      });
    },

    async finish(item, outcome) {
      const owned = "id = $1::bigint AND status = 'sending' AND attempts = $2";
      if (outcome.status === 'sent') {
        return ((await db.query(`UPDATE alert_outbox SET status = 'sent', finished_at = now(), lease_until = NULL, last_error = NULL WHERE ${owned}`, [item.id, item.attempts])).rowCount ?? 0) > 0;
      }
      if (outcome.status === 'queued') {
        // A retry of a reminder whose incident has meanwhile been resolved is not scheduled: the reminder ends here
        // (cancelled/superseded) and no longer holds the recovery back. Decided in the same statement as the ownership.
        return ((await db.query(
          `UPDATE alert_outbox o SET
                  status = CASE WHEN ${OBSOLETE_REMINDER} THEN 'cancelled' ELSE 'queued' END,
                  finished_at = CASE WHEN ${OBSOLETE_REMINDER} THEN now() ELSE NULL END,
                  last_error = CASE WHEN ${OBSOLETE_REMINDER} THEN 'superseded' ELSE $3 END,
                  lease_until = NULL, next_attempt_at = now() + make_interval(secs => $4)
            WHERE o.id = $1::bigint AND o.status = 'sending' AND o.attempts = $2`,
          [item.id, item.attempts, outcome.code, outcome.delaySeconds])).rowCount ?? 0) > 0;
      }
      return ((await db.query(`UPDATE alert_outbox SET status = $3, finished_at = now(), lease_until = NULL, last_error = $4 WHERE ${owned}`,
        [item.id, item.attempts, outcome.status, outcome.code])).rowCount ?? 0) > 0;
    },

    async listIncidents({ state, limit, before, withDelivery }) {
      const status = state === 'active' ? 'firing' : 'resolved';
      const order = state === 'active' ? 'i.opened_at DESC, i.id DESC' : 'i.resolved_at DESC, i.id DESC';
      const cursor = state === 'active'
        ? '(i.opened_at, i.id) < (SELECT opened_at, id FROM alert_incidents WHERE id = $2::uuid)'
        : '(i.resolved_at, i.id) < (SELECT resolved_at, id FROM alert_incidents WHERE id = $2::uuid)';
      const { rows } = await db.query(
        `SELECT ${INCIDENT_COLUMNS}, s.is_active, ${SERVER_STATUS_SQL} AS server_status, o.status AS o_status, o.attempts AS o_attempts, o.last_error AS o_error
           FROM alert_incidents i JOIN servers s ON s.id = i.server_id LEFT JOIN server_heartbeats h ON h.server_id = i.server_id
           LEFT JOIN LATERAL (SELECT status, attempts, last_error FROM alert_outbox WHERE incident_id = i.id ORDER BY id DESC LIMIT 1) o ON true
          WHERE i.status = $1 AND ($2::uuid IS NULL OR ${cursor})
          ORDER BY ${order} LIMIT $3`, [status, before, limit + 1]);
      const page = rows.slice(0, limit);
      return {
        items: page.map((r: Row): IncidentView => ({
          ...toMessage(r), status: r.status as IncidentView['status'],
          serverStatus: r.is_active === false ? 'inactive' : r.server_status as IncidentView['serverStatus'],
          notification: withDelivery ? { notify: r.notify === true, state: (r.o_status as OutboxStatus | null) ?? 'none', attempts: Number(r.o_attempts ?? 0), lastError: (r.o_error as string | null) ?? null } : null,
        })),
        nextBefore: rows.length > limit ? (page.at(-1)?.id as string | undefined) ?? null : null,
      };
    },

    async summary(withQueue) {
      const active = Number((await db.query("SELECT count(*) AS n FROM alert_incidents WHERE status = 'firing'")).rows[0]?.n ?? 0);
      if (!withQueue) return { active, queue: null, lastSentAt: null };
      const { rows } = await db.query('SELECT status, count(*) AS n FROM alert_outbox GROUP BY status');
      const queue: Record<OutboxStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, unknown: 0, dropped: 0, cancelled: 0 };
      for (const r of rows) queue[r.status as OutboxStatus] = Number(r.n);
      const last = (await db.query("SELECT max(finished_at) AS t FROM alert_outbox WHERE status = 'sent'")).rows[0]?.t;
      return { active, queue, lastSentAt: iso(last) };
    },
  };
}
