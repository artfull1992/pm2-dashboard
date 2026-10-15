import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { open, seal } from '../src/alerts/secret.js';
import type { AlertsStore } from '../src/alerts/store.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { type AlertsConfig, loadAlertsConfig } from '../src/config.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';
import { FakeSettingsStore } from './support/fake-settings-store.js';

// Admin settings and Slack integration API (Task 013.1, ADR-022): alerts:manage only, Origin + CSRF, strict bodies,
// optimistic concurrency, audit atomicity, write-only encrypted webhook, explicit test message (mock transport only).

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Settings-Passw0rd-1';
const WEBHOOK = `https://hooks.slack.com/services/T0SYNTH04/B0SYNTH04/${'q'.repeat(24)}`;
const WEBHOOK2 = `https://hooks.slack.com/services/T0SYNTH05/B0SYNTH05/${'z'.repeat(24)}`;
const KEY = Buffer.alloc(32, 5).toString('base64');
const config = (key: string | null = KEY): AlertsConfig => loadAlertsConfig((k, f = '') => (k === 'ALERTS_SECRET_KEY' && key ? key : f), []);

class FakeAlerts implements AlertsStore {
  evaluateOnce() { return Promise.resolve({ skipped: true, opened: 0, resolved: 0, observed: 0, enqueued: 0, dropped: 0, retired: 0, at: null }); }
  claim() { return Promise.resolve([]); }
  finish() { return Promise.resolve(true); }
  listIncidents() { return Promise.resolve({ items: [], nextBefore: null }); }
  summary() { return Promise.resolve({ active: 0, queue: { queued: 2, sending: 0, sent: 3, failed: 1, unknown: 0, dropped: 0, cancelled: 4 }, lastSentAt: null }); }
}

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

/**
 * App with the routes and a deployment-level config (key). The worker exists but these tests never wait for its
 * 5-second ticks; every Slack request goes to the mock transport.
 */
function setupWithKey(key: string | null = KEY, fetchImpl?: typeof fetch) {
  const auth = new FakeAuthStore();
  const settings = new FakeSettingsStore();
  const logs = captureLogs();
  const sent: { url: string; body: string }[] = [];
  const f = fetchImpl ?? ((url: string, init: RequestInit) => { sent.push({ url, body: init.body as string }); return Promise.resolve(new Response('ok')); }) as unknown as typeof fetch;
  const cfg = config(key);
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createAlertsStore: () => new FakeAlerts(), createSettingsStore: () => settings, alertsFetch: f, alerts: cfg,
      extra: { accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }) },
    },
  });
  const a = app;
  const login = async (role: Role) => {
    await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
    const res = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
    const raw = res.headers['set-cookie'];
    return { cookie: String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '', csrf: res.json<{ csrfToken: string }>().csrfToken };
  };
  return { app: a, settings, logs, sent, login, cfg };
}
type S = { cookie: string; csrf: string };
const h = (s: S) => ({ cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf });

function noSecret(...bodies: string[]) {
  for (const b of bodies) {
    expect(b).not.toContain('hooks.slack.com');
    expect(b).not.toContain('q'.repeat(24));
    expect(b).not.toContain('z'.repeat(24));
    expect(b).not.toContain(KEY);
  }
}

describe('access', () => {
  it('anonymous 401; viewer/operator 403 on every settings route; admin needs Origin + CSRF for mutations', async () => {
    const { app: a, login } = setupWithKey();
    const routes = [
      { method: 'GET' as const, url: '/api/settings/alerts' }, { method: 'PATCH' as const, url: '/api/settings/alerts', payload: { revision: 1, engineEnabled: true } },
      { method: 'PUT' as const, url: '/api/settings/integrations/slack', payload: { generation: 0, webhookUrl: WEBHOOK } },
      { method: 'DELETE' as const, url: '/api/settings/integrations/slack', payload: { generation: 0 } },
      { method: 'POST' as const, url: '/api/settings/integrations/slack/test', payload: { generation: 0 } },
    ];
    for (const r of routes) expect((await a.inject({ ...r, headers: { origin: ORIGIN } })).statusCode).toBe(401);
    for (const role of ['viewer', 'operator'] as const) {
      const s = await login(role);
      for (const r of routes) expect((await a.inject({ ...r, headers: h(s) })).statusCode).toBe(403);
    }
    const admin = await login('admin');
    expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: { cookie: admin.cookie, origin: ORIGIN }, payload: { revision: 1, engineEnabled: true } })).statusCode).toBe(403);
    expect((await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf }, payload: { generation: 0, webhookUrl: WEBHOOK } })).statusCode).toBe(403);
    const view = await a.inject({ method: 'GET', url: '/api/settings/alerts', headers: { cookie: admin.cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({ revision: 1, engineEnabled: false, deliveryEnabled: false, slack: { state: 'not_configured', generation: 0, keyAvailable: true, lastTest: null }, queue: { cancelled: 4 } });
  });
});

describe('PATCH /api/settings/alerts', () => {
  it('strict validation: types, ranges, unknown fields, empty patch, recovery below opening', async () => {
    const { app: a, login, settings } = setupWithKey();
    const s = await login('admin');
    const bad = [
      { revision: 1 }, { engineEnabled: true }, { revision: '1', engineEnabled: true }, { revision: 1, engineEnabled: 'true' },
      { revision: 1, rules: { cpuOpenPercent: '90' } }, { revision: 1, rules: { cpuOpenPercent: 0 } }, { revision: 1, rules: { memoryOpenPercent: 101 } },
      { revision: 1, rules: {} }, { revision: 1, rules: { cpuOpenPercent: 90, x: 1 } }, { revision: 1, webhookUrl: WEBHOOK }, { revision: 1, timing: { intervalSeconds: 5 } },
      { revision: 1, rules: { cpuOpenPercent: 60, cpuClosePercent: 60 } }, { revision: 1, rules: { memoryClosePercent: 95 } },
    ];
    for (const payload of bad) expect({ payload, status: (await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload })).statusCode }).toEqual({ payload, status: 400 });
    expect(settings.settings.revision).toBe(1);
    // PM2 CPU % may exceed 100 (multi-core).
    expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 1, rules: { cpuOpenPercent: 250, cpuClosePercent: 180 } } })).statusCode).toBe(200);
  });

  it('OS memory thresholds are gone (ADR-023): not in the view or ranges; even an in-range value is an unknown field (400, no revision step)', async () => {
    const { app: a, login, settings } = setupWithKey();
    const s = await login('admin');
    const view = await a.inject({ method: 'GET', url: '/api/settings/alerts', headers: { cookie: s.cookie } });
    expect(view.statusCode).toBe(200);
    expect(view.body).not.toMatch(/memory/i);
    expect(Object.keys(view.json<{ rules: object }>().rules).sort()).toEqual(['confirmSamples', 'cpuClosePercent', 'cpuOpenPercent', 'recoverSamples', 'restartsThreshold', 'restartsWindowMinutes', 'statusConfirmSamples']);
    for (const rules of [{ memoryOpenPercent: 90 }, { memoryClosePercent: 80 }, { cpuOpenPercent: 90, memoryOpenPercent: 90 }]) {
      expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 1, rules } })).statusCode).toBe(400);
    }
    expect(settings.settings.revision).toBe(1);
    const status = await a.inject({ method: 'GET', url: '/api/alerts/status', headers: { cookie: s.cookie } });
    expect(status.body).not.toMatch(/memory/i);
  });

  it('applies all groups with one revision step and audits metadata; stale revision → 409 and nothing changes', async () => {
    const { app: a, login, settings } = setupWithKey();
    const s = await login('admin');
    const res = await a.inject({
      method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: {
        revision: 1, engineEnabled: true,
        rules: { cpuOpenPercent: 95, cpuClosePercent: 75, restartsThreshold: 5, restartsWindowMinutes: 20 },
        timing: { intervalSeconds: 60, cooldownMinutes: 30, reminderEnabled: true, reminderMinutes: 120 },
        advanced: { httpTimeoutMs: 8000, maxAttempts: 4, queueMax: 50 },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      revision: 2, engineEnabled: true, rules: { cpuOpenPercent: 95, restartsWindowMinutes: 20 }, timing: { intervalSeconds: 60, cooldownMinutes: 30, reminderEnabled: true, reminderMinutes: 120 },
      advanced: { httpTimeoutMs: 8000, maxAttempts: 4, queueMax: 50 },
    });
    expect(settings.settings.rulesRevision).toBe(2);
    expect(settings.audits.map((x) => x.entry)).toEqual([{ event: 'settings.alerts_changed', outcome: 'success', details: { revision: 2, changed: 'engineEnabled,thresholds,intervalSeconds,cooldownSeconds,reminderEnabled,reminderSeconds,httpTimeoutMs,maxAttempts,queueMax' } }]);
    const stale = await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 1, engineEnabled: false } });
    expect(stale.statusCode).toBe(409);
    expect(settings.settings).toMatchObject({ revision: 2, engineEnabled: true });
  });

  it('delivery needs a configured integration; switching it off cancels pending items; audit failure rolls back; DB failure → 503', async () => {
    const { app: a, login, settings } = setupWithKey();
    const s = await login('admin');
    expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 1, deliveryEnabled: true } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 0, webhookUrl: WEBHOOK } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 1, deliveryEnabled: true } })).json()).toMatchObject({ deliveryEnabled: true, revision: 2 });
    settings.pending = 3;
    settings.failAudit = true;
    expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 2, deliveryEnabled: false } })).statusCode).toBe(503);
    expect(settings.settings).toMatchObject({ revision: 2, deliveryEnabled: true });
    expect(settings.pending).toBe(3);
    settings.failAudit = false;
    expect((await a.inject({ method: 'PATCH', url: '/api/settings/alerts', headers: h(s), payload: { revision: 2, deliveryEnabled: false } })).statusCode).toBe(200);
    expect(settings.cancelled).toEqual(['delivery_disabled:3']);
    expect(settings.audits.at(-1)?.entry).toEqual({ event: 'settings.delivery_disabled', outcome: 'success', details: { revision: 3, cancelledItems: 3 } });
    settings.fail = true;
    expect((await a.inject({ method: 'GET', url: '/api/settings/alerts', headers: { cookie: s.cookie } })).statusCode).toBe(503);
  });
});

describe('Slack integration (write-only, encrypted)', () => {
  it('rejects anything but an official webhook (http, other host, credentials, query/fragment, redirects-by-host)', async () => {
    const { app: a, login, settings } = setupWithKey();
    const s = await login('admin');
    for (const webhookUrl of [
      WEBHOOK.replace('https:', 'http:'), WEBHOOK.replace('hooks.slack.com', 'hooks.slack.com.evil.test'), WEBHOOK.replace('https://', 'https://user:pass@'),
      `${WEBHOOK}?a=1`, `${WEBHOOK}#x`, 'https://evil.test/services/T0SYNTH04/B0SYNTH04/qqqqqqqqqqqqqqqqqqqqqqqq', 'https://127.0.0.1/services/x', '',
    ]) expect((await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 0, webhookUrl } })).statusCode).toBe(400);
    expect(settings.integration.sealed).toBeNull();
  });

  it('stores only AES-GCM ciphertext; the URL is never returned, logged or audited; replace cancels the old queue; stale generation → 409', async () => {
    const { app: a, login, settings, logs, cfg } = setupWithKey();
    const s = await login('admin');
    const put = await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 0, webhookUrl: WEBHOOK } });
    expect(put.json()).toMatchObject({ slack: { state: 'configured', generation: 1, lastTest: null } });
    const sealed = settings.integration.sealed;
    if (!sealed) throw new Error('not sealed');
    expect(sealed.ciphertext.toString('utf8')).not.toContain('hooks.slack');
    expect(open(sealed, 1, cfg.secretKey)).toEqual({ ok: true, value: WEBHOOK });
    expect(open(sealed, 2, cfg.secretKey)).toEqual({ ok: false, error: 'decrypt_failed' }); // bound to its generation
    settings.pending = 5;
    expect((await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 0, webhookUrl: WEBHOOK2 } })).statusCode).toBe(409);
    const replaced = await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 1, webhookUrl: WEBHOOK2 } });
    expect(replaced.json()).toMatchObject({ slack: { state: 'configured', generation: 2 } });
    expect(settings.cancelled).toEqual(['integration_changed:5']);
    const del = await a.inject({ method: 'DELETE', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 2 } });
    expect(del.json()).toMatchObject({ slack: { state: 'not_configured', generation: 3 } });
    expect(settings.audits.map((x) => x.entry.event)).toEqual(['integration.slack_configured', 'integration.slack_configured', 'integration.slack_removed']);
    noSecret(put.body, replaced.body, del.body, logs.text(), JSON.stringify(settings.audits));
  });

  it('no encryption key → configuring is refused (409); a stored secret under another key is "error" (fail-closed)', async () => {
    const { app: a, login, settings } = setupWithKey(null);
    const s = await login('admin');
    expect((await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 0, webhookUrl: WEBHOOK } })).statusCode).toBe(409);
    settings.integration = { generation: 1, sealed: seal(WEBHOOK, 1, { version: 1, key: Buffer.alloc(32, 1) }), configuredAt: '2026-10-15T00:00:00.000Z', lastTest: null };
    expect((await a.inject({ method: 'GET', url: '/api/settings/alerts', headers: { cookie: s.cookie } })).json()).toMatchObject({ slack: { state: 'error', error: 'key_missing', keyAvailable: false } });
    expect((await a.inject({ method: 'POST', url: '/api/settings/integrations/slack/test', headers: h(s), payload: { generation: 1 } })).statusCode).toBe(409);
  });
});

describe('test message', () => {
  const configured = async (fetchImpl?: typeof fetch) => {
    const ctx = setupWithKey(KEY, fetchImpl);
    const s = await ctx.login('admin');
    await ctx.app.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 0, webhookUrl: WEBHOOK } });
    return { ...ctx, s };
  };
  const test = (a: FastifyInstance, s: S, generation = 1) => a.inject({ method: 'POST', url: '/api/settings/integrations/slack/test', headers: h(s), payload: { generation } });

  it('works with delivery and the engine off; clearly a test; no incident; result stored for this generation; audited without URL', async () => {
    const { app: a, s, sent, settings, logs } = await configured();
    const res = await test(a, s);
    expect(res.json()).toMatchObject({ generation: 1, outcome: 'success', code: null, stored: true });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({ text: expect.stringMatching(/^:test_tube: Тестове повідомлення GOIT Node Control[\s\S]*Це не інцидент/) as unknown });
    expect((await a.inject({ method: 'GET', url: '/api/settings/alerts', headers: { cookie: s.cookie } })).json()).toMatchObject({ slack: { lastTest: { outcome: 'success', code: null } } });
    expect(settings.audits.slice(-2).map((x) => [x.entry.event, x.entry.outcome])).toEqual([['integration.slack_test_requested', 'success'], ['integration.slack_test_result', 'success']]);
    noSecret(res.body, logs.text(), JSON.stringify(settings.audits));
  });

  it.each([
    ['invalid payload (permanent)', () => Promise.resolve(new Response('invalid_payload', { status: 400 })), 'failed', 'invalid_payload'],
    ['archived channel', () => Promise.resolve(new Response('channel_is_archived', { status: 410 })), 'failed', 'channel_is_archived'],
    ['rate limited', () => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } })), 'failed', 'rate_limited'],
    ['network error', () => Promise.reject(new Error('fetch failed')), 'failed', 'network'],
  ])('%s → %s with a safe code, never retried', async (_n, reply, outcome, code) => {
    let calls = 0;
    const { app: a, s } = await configured(() => { calls += 1; return reply(); });
    const res = await test(a, s);
    expect(res.json()).toMatchObject({ outcome, code });
    expect(calls).toBe(1);
  });

  it('timeout → unknown (not retried); a concurrent second click → 409; stale generation → 409; rate limit → 429', async () => {
    let calls = 0;
    const hang = ((_u: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('timeout')); }); });
    }) as unknown as typeof fetch;
    const { app: a, s, settings } = await configured(hang);
    settings.settings = { ...settings.settings, httpTimeoutMs: 1000 };
    const first = test(a, s);
    await new Promise((r) => setTimeout(r, 50));
    expect((await test(a, s)).statusCode).toBe(409); // already in flight
    expect((await first).json()).toMatchObject({ outcome: 'unknown', code: 'timeout' });
    expect(calls).toBe(1);
    expect((await test(a, s, 0)).statusCode).toBe(409);
    for (let i = 0; i < 5; i++) await test(a, s);
    const limited = await test(a, s);
    expect(limited.statusCode).toBe(429);
  }, 15_000);

  it('a result of the OLD webhook never marks the NEW one as tested', async () => {
    let release!: (r: Response) => void;
    const slow = (() => new Promise<Response>((r) => { release = r; })) as unknown as typeof fetch;
    const { app: a, s } = await configured(slow);
    const pending = test(a, s);
    await new Promise((r) => setTimeout(r, 50));
    expect((await a.inject({ method: 'PUT', url: '/api/settings/integrations/slack', headers: h(s), payload: { generation: 1, webhookUrl: WEBHOOK2 } })).statusCode).toBe(200);
    release(new Response('ok'));
    expect((await pending).json()).toMatchObject({ outcome: 'success', stored: false, generation: 1 });
    expect((await a.inject({ method: 'GET', url: '/api/settings/alerts', headers: { cookie: s.cookie } })).json()).toMatchObject({ slack: { generation: 2, lastTest: null } });
  });
});
