import type { FastifyInstance } from 'fastify';
import { AUTH_MESSAGES } from '../auth/plugin.js';
import { hasPermission } from '../auth/rbac.js';
import { describeError, PublicHttpError } from '../errors.js';
import type { EngineStats, RuntimeSource } from './engine.js';
import { RULES } from './rules.js';
import type { AlertsStore } from './store.js';

// Read-only alerts API (ADR-021). monitoring:read → safe incident metadata and the engine/delivery on-off state;
// alerts:manage (admin) → also per-incident delivery state, queue counters and non-secret configuration.
// The webhook URL is never returned (only whether one is configured). GET never evaluates or changes anything.

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const nullableObj = (properties: Record<string, unknown>) => ({ ...obj(properties), type: ['object', 'null'] }) as const;
const str = { type: 'string' } as const;
const nstr = { type: ['string', 'null'] } as const;
const int = { type: 'integer', minimum: 0 } as const;

const incidentSchema = obj({
  id: str, rule: { type: 'string', enum: RULES }, severity: { type: 'string', enum: ['critical', 'warning'] },
  status: { type: 'string', enum: ['firing', 'resolved'] }, resolution: nstr,
  serverId: str, serverName: str, serverStatus: { type: 'string', enum: ['online', 'offline', 'never_connected', 'inactive'] },
  processName: nstr, pmId: { type: ['integer', 'null'] },
  detail: {
    type: 'object', additionalProperties: false,
    properties: {
      value: { type: ['number', 'null'] }, threshold: { type: ['number', 'null'] }, status: str, state: str, lastSeenAt: nstr,
      delta: { type: 'number' }, spanSeconds: { type: 'number' }, windowSeconds: { type: 'number' },
    },
  },
  openedAt: str, lastObservedAt: str, resolvedAt: nstr,
  notification: nullableObj({ notify: { type: 'boolean' }, state: { type: 'string', enum: ['none', 'queued', 'sending', 'sent', 'failed', 'unknown', 'dropped', 'cancelled'] }, attempts: int, lastError: nstr }),
});

export interface AlertRoutesOptions { store: AlertsStore; source: RuntimeSource; publicUrlConfigured: boolean; stats: () => EngineStats | null }

export function registerAlertRoutes(app: FastifyInstance, options: AlertRoutesOptions): void {
  const { store, source } = options;
  const unavailable = () => new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': '5' });

  app.get('/api/alerts', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          state: { type: 'string', enum: ['active', 'resolved'], default: 'active' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, before: { type: 'string', pattern: UUID },
        },
      },
      response: { 200: obj({ items: { type: 'array', items: incidentSchema }, nextBefore: nstr }) },
    },
  }, async (request) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    const q = request.query as { state: 'active' | 'resolved'; limit: number; before?: string };
    try {
      return await store.listIncidents({ state: q.state, limit: q.limit, before: q.before ?? null, withDelivery: hasPermission(auth.role, 'alerts:manage') });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Alerts query failed');
      throw unavailable();
    }
  });

  app.get('/api/alerts/status', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      response: {
        200: obj({
          engine: obj({ enabled: { type: 'boolean' }, running: { type: 'boolean' }, lastEvaluationAt: nstr, lastEvaluationOk: { type: ['boolean', 'null'] } }),
          delivery: obj({ enabled: { type: 'boolean' } }),
          activeCount: int,
          admin: nullableObj({
            webhookConfigured: { type: 'boolean' }, publicUrlConfigured: { type: 'boolean' },
            intervalSeconds: int, cooldownMinutes: int, reminderMinutes: int, maxAttempts: int, queueMax: int,
            thresholds: obj({
              cpuOpenPercent: int, cpuClosePercent: int, confirmSamples: int,
              recoverSamples: int, statusConfirmSamples: int, restartsThreshold: int, restartsWindowMinutes: int,
            }),
            queue: obj({ queued: int, sending: int, sent: int, failed: int, unknown: int, dropped: int, cancelled: int }),
            lastSentAt: nstr, lastDeliveryError: nstr, lastEvaluationError: nstr,
            integrationState: { type: 'string', enum: ['not_configured', 'configured', 'error'] }, integrationError: nstr,
          }),
        }),
      },
    },
  }, async (request) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    const admin = hasPermission(auth.role, 'alerts:manage');
    let summary;
    let rt;
    try {
      summary = await store.summary(admin);
      rt = await source.load();
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Alerts status query failed');
      throw unavailable();
    }
    const s = options.stats();
    const cfg = rt.settings;
    const t = cfg.thresholds;
    return {
      engine: { enabled: cfg.engineEnabled, running: cfg.engineEnabled && (s?.running ?? false), lastEvaluationAt: s?.lastEvaluationAt ?? null, lastEvaluationOk: s?.lastEvaluationOk ?? null },
      delivery: { enabled: cfg.deliveryEnabled && rt.integration.state === 'configured' },
      activeCount: summary.active,
      admin: admin && summary.queue ? {
        webhookConfigured: rt.integration.state !== 'not_configured', publicUrlConfigured: options.publicUrlConfigured,
        intervalSeconds: cfg.intervalSeconds, cooldownMinutes: cfg.cooldownSeconds / 60, reminderMinutes: cfg.reminderEnabled ? cfg.reminderSeconds / 60 : 0,
        maxAttempts: cfg.maxAttempts, queueMax: cfg.queueMax, integrationState: rt.integration.state, integrationError: rt.integration.error,
        thresholds: {
          cpuOpenPercent: t.cpuOpenPercent, cpuClosePercent: t.cpuClosePercent,
          confirmSamples: t.confirmSamples, recoverSamples: t.recoverSamples, statusConfirmSamples: t.statusConfirmSamples,
          restartsThreshold: t.restartsThreshold, restartsWindowMinutes: t.restartsWindowSeconds / 60,
        },
        queue: summary.queue, lastSentAt: summary.lastSentAt, lastDeliveryError: s?.lastDeliveryError ?? null, lastEvaluationError: s?.lastEvaluationError ?? null,
      } : null,
    };
  });
}
