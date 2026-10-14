import type { AlertThresholds } from './rules.js';

// Admin-managed alert settings (ADR-022): the database is the only source of the application parameters. The ranges
// below are the single definition used by env defaults, the API schema, the DB CHECKs (migration 7) and the UI.

export interface AlertSettingsValues {
  engineEnabled: boolean;
  deliveryEnabled: boolean;
  thresholds: AlertThresholds;
  intervalSeconds: number;
  cooldownSeconds: number;
  reminderEnabled: boolean;
  /** Interval while enabled; kept when reminders are switched off. */
  reminderSeconds: number;
  httpTimeoutMs: number;
  maxAttempts: number;
  queueMax: number;
}
export interface AlertSettings extends AlertSettingsValues { revision: number; rulesRevision: number; updatedAt: string }

/** [min, max, default] — percentages: PM2 CPU % may exceed 100 (multi-core), OS memory % may not. */
export const SETTINGS_RANGES = Object.freeze({
  cpuOpenPercent: [1, 10_000, 90], cpuClosePercent: [0, 10_000, 70],
  memoryOpenPercent: [1, 100, 90], memoryClosePercent: [0, 100, 80],
  confirmSamples: [1, 20, 3], recoverSamples: [1, 20, 2], statusConfirmSamples: [1, 20, 2],
  restartsThreshold: [1, 1000, 3], restartsWindowMinutes: [2, 1440, 10],
  intervalSeconds: [10, 600, 30], cooldownMinutes: [0, 1440, 15], reminderMinutes: [1, 10_080, 60],
  httpTimeoutMs: [1000, 30_000, 5000], maxAttempts: [1, 15, 6], queueMax: [10, 1000, 100],
} as const satisfies Record<string, readonly [number, number, number]>);
export type SettingKey = keyof typeof SETTINGS_RANGES;

/** What one evaluation cycle needs — a consistent snapshot of settings + integration. */
export interface EvaluationConfig {
  thresholds: AlertThresholds;
  cooldownSeconds: number;
  /** 0 = no reminders. */
  reminderSeconds: number;
  queueMax: number;
  /** Effective: delivery switched on AND a usable integration. */
  deliveryEnabled: boolean;
  /** Integration generation new outbox items are bound to (null = no integration). */
  generation: number | null;
  /** Rules revision the condition streaks are counted under. */
  rulesRevision: number;
}

export function evaluationConfig(s: AlertSettings, delivery: { usable: boolean; generation: number | null }): EvaluationConfig {
  return {
    thresholds: s.thresholds, cooldownSeconds: s.cooldownSeconds, reminderSeconds: s.reminderEnabled ? s.reminderSeconds : 0,
    queueMax: s.queueMax, deliveryEnabled: s.deliveryEnabled && delivery.usable, generation: delivery.generation, rulesRevision: s.rulesRevision,
  };
}

/** Cross-field rules (also enforced by DB CHECKs): recovery below opening. Returns the offending pair or null. */
export function settingsProblem(v: AlertSettingsValues): 'cpu' | 'memory' | null {
  if (v.thresholds.cpuClosePercent >= v.thresholds.cpuOpenPercent) return 'cpu';
  if (v.thresholds.memoryClosePercent >= v.thresholds.memoryOpenPercent) return 'memory';
  return null;
}
