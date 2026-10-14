import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AlertsStore, ClaimedItem, IncidentView } from '../src/alerts/store.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import type { Role } from '../src/auth/rbac.js';
import { type AlertsConfig, loadAlertsConfig } from '../src/config.js';
import { createLifecycle } from '../src/lifecycle.js';
import { captureLogs, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';

// Alerts API and lifecycle (Task 013, ADR-021): monitoring:read sees safe incident metadata and the on/off state,
// alerts:manage (admin) also delivery state and non-secret configuration; the webhook URL never leaves the server;
// GET never evaluates; shutdown with a hanging Slack request is clean.

const ORIGIN = 'https://nc.example.test';
const PASSWORD = 'synthetic-Alerts-Passw0rd-1';
const WEBHOOK = `https://hooks.slack.com/services/T0SYNTH02/B0SYNTH02/${'w'.repeat(24)}`;
const incident = (over: Partial<IncidentView> = {}): IncidentView => ({
  id: '11111111-1111-4111-8111-111111111111', rule: 'server_offline', severity: 'critical', status: 'firing', resolution: null,
  serverId: '22222222-2222-4222-8222-222222222222', serverName: 'alpha', serverStatus: 'offline', processName: null, pmId: null,
  detail: { lastSeenAt: '2026-10-14T10:00:00.000Z' }, openedAt: '2026-10-14T10:01:00.000Z', lastObservedAt: '2026-10-14T10:01:00.000Z', resolvedAt: null,
  notification: { notify: true, state: 'failed', attempts: 6, lastError: 'http_500' }, ...over,
});

class FakeAlerts implements AlertsStore {
  evaluations = 0;
  claims = 0;
  fail = false;
  pending: ClaimedItem[] = [];
  finished: string[] = [];
  lastList: { withDelivery: boolean } | null = null;
  evaluateOnce() { this.evaluations += 1; return Promise.resolve({ skipped: false, opened: 0, resolved: 0, observed: 0, enqueued: 0, dropped: 0, at: '2026-10-14T10:02:00.000Z' }); }
  claim() { this.claims += 1; return Promise.resolve(this.pending.splice(0)); }
  finish(i: { id: string }, o: { status: string; code?: string }) { this.finished.push(`${i.id}:${o.status}:${o.code ?? ''}`); return Promise.resolve(true); }
  listIncidents(input: { withDelivery: boolean }) {
    if (this.fail) return Promise.reject(new Error(`relation alert_incidents ${WEBHOOK}`));
    this.lastList = input;
    const item = incident();
    return Promise.resolve({ items: [{ ...item, notification: input.withDelivery ? item.notification : null, leakedWebhook: WEBHOOK } as IncidentView], nextBefore: null });
  }
  summary(withQueue: boolean) {
    return Promise.resolve({ active: 1, queue: withQueue ? { queued: 2, sending: 0, sent: 5, failed: 1, unknown: 0, dropped: 0 } : null, lastSentAt: null });
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

function build(alerts: AlertsConfig | undefined, store: FakeAlerts, fetchImpl?: typeof fetch) {
  const auth = new FakeAuthStore();
  const logs = captureLogs();
  app = buildApp({
    logLevel: 'info', readinessTimeoutMs: 200, createDatabase: () => fakeDatabase(), logStream: logs.stream,
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => auth, createAlertsStore: () => store, ...(alerts ? { alerts } : {}), ...(fetchImpl ? { alertsFetch: fetchImpl } : {}),
      extra: { accountLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }), addressLimiter: createRateLimiter({ max: 1000, windowMs: 60_000 }) },
    },
  });
  const a = app;
  const login = async (role: Role) => {
    await auth.addUser({ email: `${role}@example.test`, password: PASSWORD, role });
    const res = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: `${role}@example.test`, password: PASSWORD } });
    const raw = res.headers['set-cookie'];
    return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  };
  return { app: a, logs, login };
}
const enabled = (over: Record<string, string> = {}) => loadAlertsConfig((k, f = '') => ({
  ALERTS_ENABLED: 'true', ALERTS_DELIVERY_ENABLED: 'true', ALERTS_SLACK_WEBHOOK_URL: WEBHOOK, ALERTS_INTERVAL_SECONDS: '600', ...over,
} as Record<string, string>)[k] ?? f, []);

describe('GET /api/alerts and /api/alerts/status', () => {
  it('anonymous → 401 on both', async () => {
    const { app: a } = build(undefined, new FakeAlerts());
    expect((await a.inject({ method: 'GET', url: '/api/alerts' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/alerts/status' })).statusCode).toBe(401);
  });

  it('viewer/operator: safe incidents without delivery state; status without admin block; engine disabled is explicit', async () => {
    const store = new FakeAlerts();
    const { app: a, login } = build(undefined, store);
    for (const role of ['viewer', 'operator'] as const) {
      const cookie = await login(role);
      const list = await a.inject({ method: 'GET', url: '/api/alerts', headers: { cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ items: IncidentView[] }>().items[0]?.notification).toBeNull();
      expect(store.lastList?.withDelivery).toBe(false);
      const status = (await a.inject({ method: 'GET', url: '/api/alerts/status', headers: { cookie } })).json<Record<string, unknown>>();
      expect(status).toEqual({ engine: { enabled: false, running: false, lastEvaluationAt: null, lastEvaluationOk: null }, delivery: { enabled: false }, activeCount: 1, admin: null });
    }
  });

  it('admin: delivery state and non-secret configuration; the webhook URL is never in any response or log', async () => {
    const store = new FakeAlerts();
    const { app: a, login, logs } = build(enabled(), store);
    const cookie = await login('admin');
    const list = await a.inject({ method: 'GET', url: '/api/alerts?state=active&limit=10', headers: { cookie } });
    expect(list.json<{ items: IncidentView[] }>().items[0]?.notification).toEqual({ notify: true, state: 'failed', attempts: 6, lastError: 'http_500' });
    const status = await a.inject({ method: 'GET', url: '/api/alerts/status', headers: { cookie } });
    expect(status.json()).toMatchObject({
      engine: { enabled: true }, delivery: { enabled: true },
      admin: { webhookConfigured: true, publicUrlConfigured: false, queue: { queued: 2, failed: 1 }, thresholds: { cpuOpenPercent: 90, restartsWindowMinutes: 10 } },
    });
    for (const body of [list.body, status.body, logs.text()]) {
      expect(body).not.toContain('hooks.slack.com');
      expect(body).not.toContain('w'.repeat(24));
    }
  });

  it('strict query; DB failure → 503 without details; GET never evaluates or claims', async () => {
    const store = new FakeAlerts();
    const { app: a, login } = build(undefined, store);
    const cookie = await login('viewer');
    for (const q of ['?state=all', '?limit=0', '?limit=101', '?before=x', '?serverId=1']) expect((await a.inject({ method: 'GET', url: `/api/alerts${q}`, headers: { cookie } })).statusCode).toBe(400);
    store.fail = true;
    const res = await a.inject({ method: 'GET', url: '/api/alerts', headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/relation|hooks/);
    expect(store.evaluations).toBe(0);
    expect(store.claims).toBe(0);
  });
});

describe('alerts worker lifecycle', () => {
  it('enabled engine starts on ready; shutdown with a hanging Slack request is clean and prompt; the item is re-queued', async () => {
    const store = new FakeAlerts();
    let inFlight!: () => void;
    const started = new Promise<void>((r) => { inFlight = r; });
    const hang = ((_u: unknown, init?: RequestInit) => { inFlight(); return new Promise<Response>((_r, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); }); }) as unknown as typeof fetch;
    const { app: a, logs } = build(enabled({ ALERTS_HTTP_TIMEOUT_MS: '30000' }), store, hang);
    await a.ready();
    expect(a.alertsEngine?.stats().running).toBe(true);
    store.pending = [{ id: '8', kind: 'firing', attempts: 1, incident: { ...incident(), notification: null } as never }];
    const delivering = a.alertsEngine?.deliverNow();
    await started;
    const lifecycle = createLifecycle(a, { host: '127.0.0.1', port: 0, shutdownTimeoutMs: 3_000 });
    const t0 = Date.now();
    expect(await lifecycle.shutdown('SIGTERM')).toBe(true);
    await delivering;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(store.finished).toContain('8:queued:aborted');
    expect(logs.text()).not.toContain('Shutdown failed');
    app = undefined; // already closed
  }, 15_000);
});
