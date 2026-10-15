import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUTH_MESSAGES } from '../auth/plugin.js';
import { createRateLimiter, type RateLimiter } from '../auth/rate-limit.js';
import { describeError, PublicHttpError } from '../errors.js';
import type { RuntimeSource } from './engine.js';
import { seal, type SecretKey } from './secret.js';
import { type AlertSettings, SETTINGS_RANGES, type SettingKey } from './settings.js';
import type { SettingsPatch, SettingsStore } from './settings-store.js';
import { isSlackWebhookUrl, sendToSlack } from './slack.js';
import type { AlertsStore } from './store.js';

// Admin settings API (ADR-022): alerts:manage only (plugin.ts enforces the permission; Origin + CSRF for every
// mutation). Strict bodies; optimistic concurrency (settings.revision / integration.generation → 409 on mismatch);
// every mutation is audited in the same transaction. The webhook is write-only: no response, log or audit row
// ever contains it. The test message is sent outside any DB transaction, once per click, never retried.

export const SETTINGS_LIMITS = Object.freeze({ mutationsPerMinute: 30, testsPerMinute: 5 });
const MESSAGES = Object.freeze({
  conflict: 'Settings were changed by someone else; reload and try again',
  notConfigured: 'The Slack integration is not configured',
  keyMissing: 'The encryption key is not configured on the server',
  integrationError: 'The stored Slack integration cannot be used (encryption key problem)',
  invalidWebhook: 'Not a Slack Incoming Webhook URL',
  invalid: 'Invalid settings',
  testInProgress: 'A test message is already being sent',
  rateLimited: 'Too many requests, try again later',
});

const range = (k: SettingKey) => ({ type: 'integer', minimum: SETTINGS_RANGES[k][0], maximum: SETTINGS_RANGES[k][1] }) as const;
const RULE_KEYS = ['cpuOpenPercent', 'cpuClosePercent', 'confirmSamples', 'recoverSamples', 'statusConfirmSamples', 'restartsThreshold', 'restartsWindowMinutes'] as const;
const TIMING_KEYS = ['intervalSeconds', 'cooldownMinutes', 'reminderMinutes'] as const;
const ADVANCED_KEYS = ['httpTimeoutMs', 'maxAttempts', 'queueMax'] as const;
const group = (keys: readonly SettingKey[], extra: Record<string, unknown> = {}) => ({
  type: 'object', additionalProperties: false, minProperties: 1, properties: { ...Object.fromEntries(keys.map((k) => [k, range(k)])), ...extra },
}) as const;
const full = (keys: readonly SettingKey[], extra: Record<string, unknown> = {}) => ({
  type: 'object', additionalProperties: false, required: [...keys, ...Object.keys(extra)], properties: { ...Object.fromEntries(keys.map((k) => [k, { type: 'integer' }])), ...extra },
}) as const;
const nstr = { type: ['string', 'null'] } as const;

const settingsViewSchema = {
  type: 'object', additionalProperties: false,
  required: ['revision', 'updatedAt', 'engineEnabled', 'deliveryEnabled', 'rules', 'timing', 'advanced', 'ranges', 'slack', 'queue', 'publicUrlConfigured'],
  properties: {
    revision: { type: 'integer' }, updatedAt: { type: 'string' }, engineEnabled: { type: 'boolean' }, deliveryEnabled: { type: 'boolean' },
    rules: full(RULE_KEYS), timing: full(TIMING_KEYS, { reminderEnabled: { type: 'boolean' } }), advanced: full(ADVANCED_KEYS),
    ranges: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, required: ['min', 'max', 'default'], properties: { min: { type: 'integer' }, max: { type: 'integer' }, default: { type: 'integer' } } } },
    slack: {
      type: 'object', additionalProperties: false, required: ['state', 'error', 'generation', 'configuredAt', 'keyAvailable', 'lastTest'],
      properties: {
        state: { type: 'string', enum: ['not_configured', 'configured', 'error'] }, error: nstr, generation: { type: 'integer' }, configuredAt: nstr,
        keyAvailable: { type: 'boolean' },
        lastTest: { type: ['object', 'null'], additionalProperties: false, required: ['outcome', 'code', 'at'], properties: { outcome: { type: 'string' }, code: nstr, at: { type: 'string' } } },
      },
    },
    queue: full(['queued', 'sending', 'sent', 'failed', 'unknown', 'dropped', 'cancelled'] as unknown as SettingKey[]),
    publicUrlConfigured: { type: 'boolean' },
  },
} as const;

/** Ajv coerces "90" → 90 and "true" → true; settings must be real JSON numbers/booleans. */
function strictTypes(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return true;
  const b = body as Record<string, unknown>;
  for (const k of ['engineEnabled', 'deliveryEnabled']) if (k in b && typeof b[k] !== 'boolean') return false;
  if ('revision' in b && typeof b.revision !== 'number') return false;
  if ('generation' in b && typeof b.generation !== 'number') return false;
  for (const g of ['rules', 'timing', 'advanced']) {
    const v = b[g];
    if (v === undefined) continue;
    if (typeof v !== 'object' || v === null) return false;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k === 'reminderEnabled' ? typeof x !== 'boolean' : typeof x !== 'number') return false;
  }
  return true;
}

export interface SettingsRoutesOptions {
  settings: SettingsStore;
  alerts: AlertsStore;
  source: RuntimeSource;
  secretKey: SecretKey | null;
  publicUrl: string | null;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  testLimiter?: RateLimiter;
}

export function registerSettingsRoutes(app: FastifyInstance, options: SettingsRoutesOptions): void {
  const { settings, source } = options;
  const limiter = options.limiter ?? createRateLimiter({ max: SETTINGS_LIMITS.mutationsPerMinute, windowMs: 60_000 });
  const testLimiter = options.testLimiter ?? createRateLimiter({ max: SETTINGS_LIMITS.testsPerMinute, windowMs: 60_000 });
  let testInFlight = false;
  const unavailable = () => new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': '5' });
  const actorOf = (request: FastifyRequest, rl: RateLimiter = limiter) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    const retry = request.method === 'GET' ? 0 : rl.hit(auth.userId);
    if (retry > 0) throw new PublicHttpError(429, MESSAGES.rateLimited, { 'retry-after': String(retry) });
    return { userId: auth.userId, requestId: request.id };
  };
  const guarded = async <T>(request: FastifyRequest, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      request.log.error({ error: describeError(error) }, `${what} failed`);
      throw unavailable();
    }
  };
  const preValidation = (request: FastifyRequest, _reply: unknown, done: (e?: Error) => void) => {
    if (!strictTypes(request.body)) { done(new PublicHttpError(400, MESSAGES.invalid)); return; }
    done();
  };

  const view = async () => {
    const rt = await source.load();
    const integration = await settings.getIntegration();
    const summary = await options.alerts.summary(true);
    const s: AlertSettings = rt.settings;
    const t = s.thresholds;
    const lastTest = integration.lastTest && integration.lastTest.generation === integration.generation
      ? { outcome: integration.lastTest.outcome, code: integration.lastTest.code, at: integration.lastTest.at } : null;
    return {
      revision: s.revision, updatedAt: s.updatedAt, engineEnabled: s.engineEnabled, deliveryEnabled: s.deliveryEnabled,
      rules: {
        cpuOpenPercent: t.cpuOpenPercent, cpuClosePercent: t.cpuClosePercent,
        confirmSamples: t.confirmSamples, recoverSamples: t.recoverSamples, statusConfirmSamples: t.statusConfirmSamples,
        restartsThreshold: t.restartsThreshold, restartsWindowMinutes: t.restartsWindowSeconds / 60,
      },
      timing: { intervalSeconds: s.intervalSeconds, cooldownMinutes: s.cooldownSeconds / 60, reminderEnabled: s.reminderEnabled, reminderMinutes: s.reminderSeconds / 60 },
      advanced: { httpTimeoutMs: s.httpTimeoutMs, maxAttempts: s.maxAttempts, queueMax: s.queueMax },
      ranges: Object.fromEntries(Object.entries(SETTINGS_RANGES).map(([k, [min, max, def]]) => [k, { min, max, default: def }])),
      slack: {
        state: rt.integration.state, error: rt.integration.error, generation: integration.generation, configuredAt: integration.configuredAt,
        keyAvailable: options.secretKey !== null, lastTest,
      },
      queue: summary.queue ?? { queued: 0, sending: 0, sent: 0, failed: 0, unknown: 0, dropped: 0, cancelled: 0 },
      publicUrlConfigured: options.publicUrl !== null,
    };
  };

  app.get('/api/settings/alerts', { config: { access: { permission: 'alerts:manage' } }, schema: { response: { 200: settingsViewSchema } } },
    async (request) => { actorOf(request); return guarded(request, 'Settings read', view); });

  app.patch('/api/settings/alerts', {
    config: { access: { permission: 'alerts:manage' } },
    preValidation,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['revision'], minProperties: 2,
        properties: {
          revision: { type: 'integer', minimum: 1 }, engineEnabled: { type: 'boolean' }, deliveryEnabled: { type: 'boolean' },
          rules: group(RULE_KEYS), timing: group(TIMING_KEYS, { reminderEnabled: { type: 'boolean' } }), advanced: group(ADVANCED_KEYS),
        },
      },
      response: { 200: settingsViewSchema },
    },
  }, async (request) => {
    const actor = actorOf(request);
    const b = request.body as {
      revision: number; engineEnabled?: boolean; deliveryEnabled?: boolean;
      rules?: Partial<Record<(typeof RULE_KEYS)[number], number>>; timing?: Partial<Record<(typeof TIMING_KEYS)[number], number>> & { reminderEnabled?: boolean };
      advanced?: Partial<Record<(typeof ADVANCED_KEYS)[number], number>>;
    };
    const patch: SettingsPatch = {};
    if (b.engineEnabled !== undefined) patch.engineEnabled = b.engineEnabled;
    if (b.deliveryEnabled !== undefined) patch.deliveryEnabled = b.deliveryEnabled;
    if (b.rules) {
      const { restartsWindowMinutes, ...rest } = b.rules;
      patch.thresholds = { ...rest, ...(restartsWindowMinutes === undefined ? {} : { restartsWindowSeconds: restartsWindowMinutes * 60 }) };
    }
    if (b.timing) {
      if (b.timing.intervalSeconds !== undefined) patch.intervalSeconds = b.timing.intervalSeconds;
      if (b.timing.cooldownMinutes !== undefined) patch.cooldownSeconds = b.timing.cooldownMinutes * 60;
      if (b.timing.reminderEnabled !== undefined) patch.reminderEnabled = b.timing.reminderEnabled;
      if (b.timing.reminderMinutes !== undefined) patch.reminderSeconds = b.timing.reminderMinutes * 60;
    }
    if (b.advanced) Object.assign(patch, b.advanced);
    const r = await guarded(request, 'Settings update', () => settings.updateSettings({ expectedRevision: b.revision, patch, actor }));
    if (r.status === 'conflict') throw new PublicHttpError(409, MESSAGES.conflict);
    if (r.status === 'not_configured') throw new PublicHttpError(409, MESSAGES.notConfigured);
    if (r.status === 'invalid') throw new PublicHttpError(400, MESSAGES.invalid);
    return guarded(request, 'Settings read', view);
  });

  app.put('/api/settings/integrations/slack', {
    config: { access: { permission: 'alerts:manage' } },
    preValidation,
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['generation', 'webhookUrl'], properties: { generation: { type: 'integer', minimum: 0 }, webhookUrl: { type: 'string', minLength: 1, maxLength: 300 } } },
      response: { 200: settingsViewSchema },
    },
  }, async (request) => {
    const actor = actorOf(request);
    const { generation, webhookUrl } = request.body as { generation: number; webhookUrl: string };
    if (!isSlackWebhookUrl(webhookUrl)) throw new PublicHttpError(400, MESSAGES.invalidWebhook);
    const key = options.secretKey;
    if (!key) throw new PublicHttpError(409, MESSAGES.keyMissing);
    const r = await guarded(request, 'Slack integration update', () => settings.configureSlack({ expectedGeneration: generation, seal: (g) => seal(webhookUrl, g, key), actor }));
    if (r.status === 'conflict') throw new PublicHttpError(409, MESSAGES.conflict);
    return guarded(request, 'Settings read', view);
  });

  app.delete('/api/settings/integrations/slack', {
    config: { access: { permission: 'alerts:manage' } },
    preValidation,
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['generation'], properties: { generation: { type: 'integer', minimum: 0 } } },
      response: { 200: settingsViewSchema },
    },
  }, async (request) => {
    const actor = actorOf(request);
    const { generation } = request.body as { generation: number };
    const r = await guarded(request, 'Slack integration removal', () => settings.removeSlack({ expectedGeneration: generation, actor }));
    if (r.status === 'conflict') throw new PublicHttpError(409, MESSAGES.conflict);
    if (r.status === 'not_configured') throw new PublicHttpError(409, MESSAGES.notConfigured);
    return guarded(request, 'Settings read', view);
  });

  app.post('/api/settings/integrations/slack/test', {
    config: { access: { permission: 'alerts:manage' } },
    preValidation,
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['generation'], properties: { generation: { type: 'integer', minimum: 0 } } },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['operationId', 'generation', 'outcome', 'code', 'at', 'stored'],
          properties: { operationId: { type: 'string' }, generation: { type: 'integer' }, outcome: { type: 'string', enum: ['success', 'failed', 'unknown'] }, code: nstr, at: { type: 'string' }, stored: { type: 'boolean' } },
        },
      },
    },
  }, async (request) => {
    const actor = actorOf(request, testLimiter);
    const { generation } = request.body as { generation: number };
    const rt = await guarded(request, 'Settings read', () => source.load());
    if (rt.integration.generation !== generation) throw new PublicHttpError(409, MESSAGES.conflict);
    if (rt.integration.state === 'not_configured') throw new PublicHttpError(409, MESSAGES.notConfigured);
    if (rt.integration.state === 'error' || rt.integration.webhook === null) throw new PublicHttpError(409, MESSAGES.integrationError);
    if (testInFlight) throw new PublicHttpError(409, MESSAGES.testInProgress);
    testInFlight = true;
    try {
      const operationId = randomUUID();
      await guarded(request, 'Audit', () => settings.audit({ event: 'integration.slack_test_requested', outcome: 'success', details: { operationId, generation } }, actor));
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const link = options.publicUrl ? `\n<${options.publicUrl}/settings/integrations|Налаштування Node Control>` : '';
      const text = `:test_tube: Тестове повідомлення GOIT Node Control\nПеревірка Slack-інтеграції з розділу «Налаштування». Це не інцидент, дій не потрібно.\nЧас: ${now} UTC${link}`;
      const sent = await sendToSlack(rt.integration.webhook, text, {
        timeoutMs: rt.settings.httpTimeoutMs, signal: new AbortController().signal, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      const outcome = sent.kind === 'sent' ? 'success' as const : sent.kind === 'unknown' ? 'unknown' as const : 'failed' as const;
      const code = sent.kind === 'sent' ? null : sent.code;
      const result = await guarded(request, 'Test result', () => settings.recordTestResult({ generation, testId: operationId, outcome, code, actor }));
      return { operationId, generation, outcome, code, at: result.at, stored: result.stored };
    } finally {
      testInFlight = false;
    }
  });
}
