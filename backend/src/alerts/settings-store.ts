import { type AuditEvent, insertAudit } from '../auth/store.js';
import type { Database, QueryClient } from '../database.js';
import type { SealedSecret } from './secret.js';
import { type AlertSettings, type AlertSettingsValues, LEGACY_MEMORY_THRESHOLDS } from './settings.js';

// Settings and Slack integration persistence (ADR-022). Singletons with optimistic concurrency (settings.revision,
// integration.generation). Every mutation and its audit rows are one transaction; lock order: alert_settings →
// alert_slack_integration → alert_outbox. The sealed webhook is read only by the worker/test path, never returned.

export interface IntegrationRow {
  generation: number;
  sealed: SealedSecret | null;
  configuredAt: string | null;
  lastTest: { id: string; generation: number; outcome: 'success' | 'failed' | 'unknown'; code: string | null; at: string } | null;
}
export interface Actor { userId: string; requestId: string }
export type SettingsPatch = Partial<Omit<AlertSettingsValues, 'thresholds'>> & { thresholds?: Partial<AlertSettingsValues['thresholds']> };

export interface SettingsStore {
  /** Creates the singleton from defaults only if it does not exist (startup; never overwrites saved settings). */
  initialize(defaults: AlertSettingsValues): Promise<boolean>;
  getSettings(): Promise<AlertSettings>;
  getIntegration(): Promise<IntegrationRow>;
  updateSettings(input: { expectedRevision: number; patch: SettingsPatch; actor: Actor }): Promise<{ status: 'updated'; settings: AlertSettings } | { status: 'conflict' | 'not_configured' | 'invalid' }>;
  configureSlack(input: { expectedGeneration: number; seal: (generation: number) => SealedSecret; actor: Actor }): Promise<{ status: 'configured'; generation: number; cancelled: number } | { status: 'conflict' }>;
  removeSlack(input: { expectedGeneration: number; actor: Actor }): Promise<{ status: 'removed'; generation: number; cancelled: number } | { status: 'conflict' | 'not_configured' }>;
  audit(entry: AuditEvent, actor: Actor): Promise<void>;
  /** Stores a test result only while the integration is still at `generation`; the audit row is written either way. */
  recordTestResult(input: { generation: number; testId: string; outcome: 'success' | 'failed' | 'unknown'; code: string | null; actor: Actor }): Promise<{ stored: boolean; at: string }>;
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
// memory_open_percent / memory_close_percent: retired rule (ADR-023) — never read, never updated (see settings.ts).
const COLUMNS = `revision, rules_revision, engine_enabled, delivery_enabled, cpu_open_percent, cpu_close_percent,
  confirm_samples, recover_samples, status_confirm_samples, restarts_threshold, restarts_window_minutes,
  interval_seconds, cooldown_minutes, reminder_enabled, reminder_minutes, http_timeout_ms, max_attempts, queue_max, updated_at`;

function toSettings(r: Row): AlertSettings {
  const n = (k: string) => Number(r[k]);
  return {
    revision: n('revision'), rulesRevision: n('rules_revision'), engineEnabled: r.engine_enabled === true, deliveryEnabled: r.delivery_enabled === true,
    thresholds: {
      cpuOpenPercent: n('cpu_open_percent'), cpuClosePercent: n('cpu_close_percent'), confirmSamples: n('confirm_samples'), recoverSamples: n('recover_samples'),
      statusConfirmSamples: n('status_confirm_samples'), restartsThreshold: n('restarts_threshold'), restartsWindowSeconds: n('restarts_window_minutes') * 60,
    },
    intervalSeconds: n('interval_seconds'), cooldownSeconds: n('cooldown_minutes') * 60, reminderEnabled: r.reminder_enabled === true,
    reminderSeconds: n('reminder_minutes') * 60, httpTimeoutMs: n('http_timeout_ms'), maxAttempts: n('max_attempts'), queueMax: n('queue_max'),
    updatedAt: iso(r.updated_at) ?? '',
  };
}

function toRow(v: AlertSettingsValues): unknown[] {
  const t = v.thresholds;
  return [v.engineEnabled, v.deliveryEnabled, t.cpuOpenPercent, t.cpuClosePercent, t.confirmSamples,
    t.recoverSamples, t.statusConfirmSamples, t.restartsThreshold, Math.round(t.restartsWindowSeconds / 60), v.intervalSeconds,
    Math.round(v.cooldownSeconds / 60), v.reminderEnabled, Math.round(v.reminderSeconds / 60), v.httpTimeoutMs, v.maxAttempts, v.queueMax];
}

const RULE_KEYS = ['thresholds'] as const;

/** Pending/sending outbox items never go to another address or burst out after re-enabling: they are cancelled. */
async function cancelPending(tx: QueryClient, reason: 'integration_changed' | 'delivery_disabled'): Promise<number> {
  const r = await tx.query(
    `UPDATE alert_outbox SET status = 'cancelled', finished_at = now(), lease_until = NULL, last_error = $1 WHERE status IN ('queued', 'sending')`, [reason]);
  return r.rowCount ?? 0;
}

const auditOf = (tx: QueryClient, actor: Actor) => (entry: AuditEvent) => insertAudit(tx, entry, { actorUserId: actor.userId, requestId: actor.requestId });

export function createPgSettingsStore(db: Database): SettingsStore {
  const readIntegration = async (q: QueryClient, lock = ''): Promise<IntegrationRow> => {
    const r = (await q.query(`SELECT generation, ciphertext, nonce, tag, key_version, configured_at, last_test_id, last_test_generation, last_test_outcome, last_test_code, last_test_at
                                FROM alert_slack_integration WHERE id = 1 ${lock}`)).rows[0] ?? {};
    return {
      generation: Number(r.generation ?? 0),
      sealed: r.ciphertext ? { ciphertext: r.ciphertext as Buffer, nonce: r.nonce as Buffer, tag: r.tag as Buffer, keyVersion: Number(r.key_version) } : null,
      configuredAt: iso(r.configured_at),
      lastTest: r.last_test_outcome ? {
        id: String(r.last_test_id), generation: Number(r.last_test_generation), outcome: r.last_test_outcome as 'success' | 'failed' | 'unknown',
        code: (r.last_test_code as string | null) ?? null, at: iso(r.last_test_at) ?? '',
      } : null,
    };
  };

  return {
    async initialize(defaults) {
      const r = await db.query(
        `INSERT INTO alert_settings (id, engine_enabled, delivery_enabled, cpu_open_percent, cpu_close_percent,
           confirm_samples, recover_samples, status_confirm_samples, restarts_threshold, restarts_window_minutes, interval_seconds, cooldown_minutes,
           reminder_enabled, reminder_minutes, http_timeout_ms, max_attempts, queue_max, memory_open_percent, memory_close_percent)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (id) DO NOTHING`, [...toRow({ ...defaults, engineEnabled: false, deliveryEnabled: false }), LEGACY_MEMORY_THRESHOLDS.open, LEGACY_MEMORY_THRESHOLDS.close]);
      await db.query('INSERT INTO alert_slack_integration (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
      return (r.rowCount ?? 0) > 0;
    },

    async getSettings() {
      const r = (await db.query(`SELECT ${COLUMNS} FROM alert_settings WHERE id = 1`)).rows[0];
      if (!r) throw new Error('alert settings not initialized');
      return toSettings(r);
    },

    getIntegration() { return readIntegration(db); },

    updateSettings({ expectedRevision, patch, actor }) {
      return db.transaction(async (tx) => {
        const row = (await tx.query(`SELECT ${COLUMNS} FROM alert_settings WHERE id = 1 FOR UPDATE`)).rows[0];
        if (!row) throw new Error('alert settings not initialized');
        const current = toSettings(row);
        if (current.revision !== expectedRevision) return { status: 'conflict' } as const;
        const next: AlertSettingsValues = {
          ...current, ...patch, thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) },
        };
        if (next.thresholds.cpuClosePercent >= next.thresholds.cpuOpenPercent) return { status: 'invalid' } as const;
        const integration = await readIntegration(tx, 'FOR SHARE');
        if (next.deliveryEnabled && !current.deliveryEnabled && integration.sealed === null) return { status: 'not_configured' } as const;
        const changed = (Object.keys(patch) as (keyof SettingsPatch)[]).filter((k) => JSON.stringify(k === 'thresholds' ? next.thresholds : next[k]) !== JSON.stringify(k === 'thresholds' ? current.thresholds : current[k]));
        if (changed.length === 0) return { status: 'updated', settings: current } as const;
        const rulesChanged = changed.some((k) => (RULE_KEYS as readonly string[]).includes(k));
        const revision = current.revision + 1;
        const updated = (await tx.query(
          `UPDATE alert_settings SET revision = $17, rules_revision = CASE WHEN $18 THEN $17 ELSE rules_revision END,
             engine_enabled = $1, delivery_enabled = $2, cpu_open_percent = $3, cpu_close_percent = $4,
             confirm_samples = $5, recover_samples = $6, status_confirm_samples = $7, restarts_threshold = $8, restarts_window_minutes = $9,
             interval_seconds = $10, cooldown_minutes = $11, reminder_enabled = $12, reminder_minutes = $13, http_timeout_ms = $14, max_attempts = $15,
             queue_max = $16, updated_at = now(), updated_by = $19
           WHERE id = 1 RETURNING ${COLUMNS}`, [...toRow(next), revision, rulesChanged, actor.userId])).rows[0];
        if (!updated) throw new Error('settings update returned no row');
        const audit = auditOf(tx, actor);
        const other = changed.filter((k) => k !== 'deliveryEnabled');
        if (other.length > 0) await audit({ event: 'settings.alerts_changed', outcome: 'success', details: { revision, changed: other.join(',') } });
        if (next.deliveryEnabled !== current.deliveryEnabled) {
          const cancelledItems = next.deliveryEnabled ? 0 : await cancelPending(tx, 'delivery_disabled');
          await audit({ event: next.deliveryEnabled ? 'settings.delivery_enabled' : 'settings.delivery_disabled', outcome: 'success', details: { revision, cancelledItems } });
        }
        return { status: 'updated', settings: toSettings(updated) } as const;
      });
    },

    configureSlack({ expectedGeneration, seal, actor }) {
      return db.transaction(async (tx) => {
        await tx.query('SELECT 1 FROM alert_settings WHERE id = 1 FOR UPDATE');
        const current = await readIntegration(tx, 'FOR UPDATE');
        if (current.generation !== expectedGeneration) return { status: 'conflict' } as const;
        const generation = current.generation + 1;
        const sealed = seal(generation);
        await tx.query(
          `UPDATE alert_slack_integration SET generation = $1, ciphertext = $2, nonce = $3, tag = $4, key_version = $5, configured_at = now(), configured_by = $6,
             last_test_id = NULL, last_test_generation = NULL, last_test_outcome = NULL, last_test_code = NULL, last_test_at = NULL
           WHERE id = 1`, [generation, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyVersion, actor.userId]);
        const cancelled = await cancelPending(tx, 'integration_changed');
        await auditOf(tx, actor)({ event: 'integration.slack_configured', outcome: 'success', details: { generation, replaced: current.sealed !== null, cancelledItems: cancelled } });
        return { status: 'configured', generation, cancelled } as const;
      });
    },

    removeSlack({ expectedGeneration, actor }) {
      return db.transaction(async (tx) => {
        const settings = (await tx.query<{ revision: string; delivery_enabled: boolean }>('SELECT revision, delivery_enabled FROM alert_settings WHERE id = 1 FOR UPDATE')).rows[0];
        const current = await readIntegration(tx, 'FOR UPDATE');
        if (current.generation !== expectedGeneration) return { status: 'conflict' } as const;
        if (current.sealed === null) return { status: 'not_configured' } as const;
        const generation = current.generation + 1;
        await tx.query(
          `UPDATE alert_slack_integration SET generation = $1, ciphertext = NULL, nonce = NULL, tag = NULL, key_version = NULL, configured_at = NULL, configured_by = NULL,
             last_test_id = NULL, last_test_generation = NULL, last_test_outcome = NULL, last_test_code = NULL, last_test_at = NULL WHERE id = 1`, [generation]);
        const audit = auditOf(tx, actor);
        if (settings?.delivery_enabled) {
          const revision = Number(settings.revision) + 1;
          await tx.query('UPDATE alert_settings SET delivery_enabled = false, revision = $1, updated_at = now(), updated_by = $2 WHERE id = 1', [revision, actor.userId]);
          await audit({ event: 'settings.delivery_disabled', outcome: 'success', details: { revision, cancelledItems: 0 } });
        }
        const cancelled = await cancelPending(tx, 'integration_changed');
        await audit({ event: 'integration.slack_removed', outcome: 'success', details: { generation, cancelledItems: cancelled } });
        return { status: 'removed', generation, cancelled } as const;
      });
    },

    async audit(entry, actor) { await insertAudit(db, entry, { actorUserId: actor.userId, requestId: actor.requestId }); },

    recordTestResult({ generation, testId, outcome, code, actor }) {
      return db.transaction(async (tx) => {
        const r = await tx.query<{ at: Date }>(
          `UPDATE alert_slack_integration SET last_test_id = $2, last_test_generation = $1, last_test_outcome = $3, last_test_code = $4, last_test_at = now()
            WHERE id = 1 AND generation = $1 AND ciphertext IS NOT NULL RETURNING last_test_at AS at`, [generation, testId, outcome, code]);
        await auditOf(tx, actor)({
          event: 'integration.slack_test_result', outcome: outcome === 'success' ? 'success' : 'failure',
          details: { operationId: testId, generation, ...(code ? { code } : {}), ...(r.rows[0] ? {} : { stale: true }) },
        });
        return { stored: (r.rowCount ?? 0) > 0, at: iso(r.rows[0]?.at) ?? new Date().toISOString() };
      });
    },
  };
}

export { cancelPending };
