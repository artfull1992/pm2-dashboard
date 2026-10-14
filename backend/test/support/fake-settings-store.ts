// In-memory SettingsStore with the same contract as the PostgreSQL one (ADR-022): optimistic concurrency, audit in
// the same "transaction" (a failing audit leaves nothing changed), cancelled outbox counts via a callback.
// Real SQL semantics are covered by backend/test/db/settings.test.ts.
import type { AuditEvent } from '../../src/auth/store.js';
import type { SealedSecret } from '../../src/alerts/secret.js';
import type { AlertSettings, AlertSettingsValues } from '../../src/alerts/settings.js';
import type { Actor, IntegrationRow, SettingsPatch, SettingsStore } from '../../src/alerts/settings-store.js';
import { ALERTS_DEFAULTS } from '../../src/config.js';

export class FakeSettingsStore implements SettingsStore {
  settings: AlertSettings = { ...ALERTS_DEFAULTS.defaults, revision: 1, rulesRevision: 1, updatedAt: '2026-10-15T00:00:00.000Z' };
  integration: IntegrationRow = { generation: 0, sealed: null, configuredAt: null, lastTest: null };
  audits: { entry: AuditEvent; actor: Actor }[] = [];
  failAudit = false;
  fail = false;
  /** Pending outbox items that a cancel would affect (stand-in for alert_outbox). */
  pending = 0;
  cancelled: string[] = [];

  private check() { if (this.fail) throw Object.assign(new Error('connect ECONNREFUSED synthetic'), { code: 'ECONNREFUSED' }); }
  private audit_(entries: AuditEvent[], actor: Actor) {
    if (this.failAudit) throw new Error('audit insert failed (synthetic)');
    for (const entry of entries) this.audits.push({ entry, actor });
  }
  private cancel(reason: string) { const n = this.pending; this.pending = 0; if (n > 0) this.cancelled.push(`${reason}:${String(n)}`); return n; }

  initialize(_defaults: AlertSettingsValues) { this.check(); return Promise.resolve(false); }
  getSettings() { this.check(); return Promise.resolve({ ...this.settings, thresholds: { ...this.settings.thresholds } }); }
  getIntegration() { this.check(); return Promise.resolve({ ...this.integration }); }

  updateSettings({ expectedRevision, patch, actor }: { expectedRevision: number; patch: SettingsPatch; actor: Actor }) {
    this.check();
    const cur = this.settings;
    if (cur.revision !== expectedRevision) return Promise.resolve({ status: 'conflict' as const });
    const next = { ...cur, ...patch, thresholds: { ...cur.thresholds, ...(patch.thresholds ?? {}) } };
    if (next.thresholds.cpuClosePercent >= next.thresholds.cpuOpenPercent || next.thresholds.memoryClosePercent >= next.thresholds.memoryOpenPercent) return Promise.resolve({ status: 'invalid' as const });
    if (next.deliveryEnabled && !cur.deliveryEnabled && !this.integration.sealed) return Promise.resolve({ status: 'not_configured' as const });
    const changed = (Object.keys(patch) as (keyof SettingsPatch)[]).filter((k) => JSON.stringify(k === 'thresholds' ? next.thresholds : next[k]) !== JSON.stringify(k === 'thresholds' ? cur.thresholds : cur[k]));
    if (changed.length === 0) return Promise.resolve({ status: 'updated' as const, settings: cur });
    const revision = cur.revision + 1;
    const entries: AuditEvent[] = [];
    const other = changed.filter((k) => k !== 'deliveryEnabled');
    if (other.length > 0) entries.push({ event: 'settings.alerts_changed', outcome: 'success', details: { revision, changed: other.join(',') } });
    const willCancel = next.deliveryEnabled !== cur.deliveryEnabled && !next.deliveryEnabled ? this.pending : 0;
    if (next.deliveryEnabled !== cur.deliveryEnabled) entries.push({ event: next.deliveryEnabled ? 'settings.delivery_enabled' : 'settings.delivery_disabled', outcome: 'success', details: { revision, cancelledItems: willCancel } });
    this.audit_(entries, actor);
    if (willCancel > 0) this.cancel('delivery_disabled');
    this.settings = { ...next, revision, rulesRevision: changed.includes('thresholds') ? revision : cur.rulesRevision, updatedAt: new Date().toISOString() };
    return Promise.resolve({ status: 'updated' as const, settings: this.settings });
  }

  configureSlack({ expectedGeneration, seal, actor }: { expectedGeneration: number; seal: (g: number) => SealedSecret; actor: Actor }) {
    this.check();
    if (this.integration.generation !== expectedGeneration) return Promise.resolve({ status: 'conflict' as const });
    const generation = this.integration.generation + 1;
    const sealed = seal(generation);
    const cancelled = this.pending;
    this.audit_([{ event: 'integration.slack_configured', outcome: 'success', details: { generation, replaced: this.integration.sealed !== null, cancelledItems: cancelled } }], actor);
    this.cancel('integration_changed');
    this.integration = { generation, sealed, configuredAt: new Date().toISOString(), lastTest: null };
    return Promise.resolve({ status: 'configured' as const, generation, cancelled });
  }

  removeSlack({ expectedGeneration, actor }: { expectedGeneration: number; actor: Actor }) {
    this.check();
    if (this.integration.generation !== expectedGeneration) return Promise.resolve({ status: 'conflict' as const });
    if (!this.integration.sealed) return Promise.resolve({ status: 'not_configured' as const });
    const generation = this.integration.generation + 1;
    const cancelled = this.pending;
    this.audit_([{ event: 'integration.slack_removed', outcome: 'success', details: { generation, cancelledItems: cancelled } }], actor);
    this.cancel('integration_changed');
    this.integration = { generation, sealed: null, configuredAt: null, lastTest: null };
    if (this.settings.deliveryEnabled) this.settings = { ...this.settings, deliveryEnabled: false, revision: this.settings.revision + 1 };
    return Promise.resolve({ status: 'removed' as const, generation, cancelled });
  }

  audit(entry: AuditEvent, actor: Actor) { this.check(); this.audit_([entry], actor); return Promise.resolve(); }

  recordTestResult({ generation, testId, outcome, code, actor }: { generation: number; testId: string; outcome: 'success' | 'failed' | 'unknown'; code: string | null; actor: Actor }) {
    this.check();
    const stored = this.integration.generation === generation && this.integration.sealed !== null;
    const at = new Date().toISOString();
    this.audit_([{ event: 'integration.slack_test_result', outcome: outcome === 'success' ? 'success' : 'failure', details: { operationId: testId, generation, ...(code ? { code } : {}), ...(stored ? {} : { stale: true }) } }], actor);
    if (stored) this.integration = { ...this.integration, lastTest: { id: testId, generation, outcome, code, at } };
    return Promise.resolve({ stored, at });
  }
}
