import { describe, expect, it, vi } from 'vitest';
import { AlertsEngine, backoffSeconds } from '../src/alerts/engine.js';
import { isSlackWebhookUrl, type MessageIncident, renderMessage, sendToSlack, slackSafe } from '../src/alerts/slack.js';
import type { AlertsStore, ClaimedItem } from '../src/alerts/store.js';
import { type AlertsConfig, loadAlertsConfig } from '../src/config.js';

// Slack formatting/delivery and the delivery loop (Task 013, ADR-021). Only a local mock transport — never Slack.

const WEBHOOK = `https://hooks.slack.com/services/T0SYNTH01/B0SYNTH01/${'s'.repeat(24)}`;
const incident = (over: Partial<MessageIncident> = {}): MessageIncident => ({
  id: '11111111-1111-4111-8111-111111111111', rule: 'process_down', severity: 'critical', serverId: '22222222-2222-4222-8222-222222222222',
  serverName: 'alpha', processName: 'api', pmId: 3, detail: { status: 'errored' }, openedAt: '2026-10-14T10:00:00.000Z',
  lastObservedAt: '2026-10-14T10:01:00.000Z', resolvedAt: null, resolution: null, ...over,
});
const env = (over: Record<string, string> = {}) => (key: string, fallback = '') => over[key] ?? fallback;
function config(over: Record<string, string> = {}): AlertsConfig {
  const issues: string[] = [];
  const c = loadAlertsConfig(env({ ALERTS_ENABLED: 'true', ALERTS_DELIVERY_ENABLED: 'true', ALERTS_SLACK_WEBHOOK_URL: WEBHOOK, ALERTS_PUBLIC_URL: 'https://nc.example.test', ...over }), issues);
  expect(issues).toEqual([]);
  return c;
}
const reply = (status: number, body: string, headers: Record<string, string> = {}) => () => Promise.resolve(new Response(body, { status, headers }));

describe('configuration (ALERTS_*)', () => {
  it('everything is off by default; delivery needs the engine and a valid webhook; issues never contain the URL', () => {
    const off = loadAlertsConfig(env(), []);
    expect(off).toMatchObject({ enabled: false, deliveryEnabled: false, webhookUrl: null });
    const issues: string[] = [];
    loadAlertsConfig(env({ ALERTS_DELIVERY_ENABLED: 'true', ALERTS_SLACK_WEBHOOK_URL: 'https://evil.example/services/T1/B1/secretvalue123456' }), issues);
    expect(issues.join('\n')).toMatch(/requires ALERTS_ENABLED=true/);
    expect(issues.join('\n')).toMatch(/must be a Slack Incoming Webhook URL/);
    expect(issues.join('\n')).not.toContain('secretvalue');
    const bad: string[] = [];
    loadAlertsConfig(env({ ALERTS_CPU_OPEN_PERCENT: '50', ALERTS_CPU_CLOSE_PERCENT: '60', ALERTS_PUBLIC_URL: 'http://x', ALERTS_INTERVAL_SECONDS: '1' }), bad);
    expect(bad).toEqual(expect.arrayContaining([
      'ALERTS_CPU_CLOSE_PERCENT must be lower than ALERTS_CPU_OPEN_PERCENT', expect.stringMatching(/ALERTS_PUBLIC_URL/), expect.stringMatching(/ALERTS_INTERVAL_SECONDS/),
    ]));
  });

  it('only the official Slack webhook host/path is accepted', () => {
    expect(isSlackWebhookUrl(WEBHOOK)).toBe(true);
    for (const u of ['http://hooks.slack.com/services/T0SYNTH01/B0SYNTH01/ssssssssssssssssssssssss', 'https://hooks.slack.com.evil.test/services/T0SYNTH01/B0SYNTH01/ssssssssssssssssssssssss',
      'https://hooks.slack.com/other/T0SYNTH01/B0SYNTH01/ssssssssssssssssssssssss', `${WEBHOOK}?x=1`, `${WEBHOOK}#a`]) expect(isSlackWebhookUrl(u)).toBe(false);
  });
});

describe('message text', () => {
  it('untrusted names cannot create mentions, links or markup; the only link comes from configuration', () => {
    expect(slackSafe('<!channel> @here @everyone <https://evil.test|click> & *bold*')).not.toMatch(/<|>|@here|@everyone|https:\/\/|(^|[^\u200b])\*/);
    const text = renderMessage('firing', incident({ serverName: '<!everyone> https://phish.test', processName: '@channel' }), 'https://nc.example.test');
    expect(text).not.toMatch(/<!everyone>|<!channel>|@channel(?!\u200b)|https:\/\/phish/);
    expect(text).toContain('<https://nc.example.test/servers/22222222-2222-4222-8222-222222222222|Відкрити в Node Control>');
    expect(text.match(/</g)).toHaveLength(1);
  });

  it('wording: errored vs stopped (maybe intentional), CPU by PM2, OS memory, restarts delta; resolution kinds', () => {
    expect(renderMessage('firing', incident(), null)).toMatch(/Проблема: PM2-процес не працює[\s\S]*errored/);
    expect(renderMessage('firing', incident({ severity: 'warning', detail: { status: 'stopped' } }), null)).toMatch(/можливо, навмисна зупинка/);
    expect(renderMessage('firing', incident({ rule: 'server_memory', processName: null, pmId: null, detail: { value: 93.2, threshold: 90 } }), null)).toMatch(/пам’яті ОС: 93\.2 % \(поріг 90 %\)/);
    expect(renderMessage('firing', incident({ rule: 'process_restarts', detail: { delta: 5, spanSeconds: 420, threshold: 3, windowSeconds: 600 } }), null)).toMatch(/\+5 рестартів PM2 за 7 хв \(поріг 3 за 10 хв\)/);
    expect(renderMessage('resolved', incident({ resolution: 'recovered', resolvedAt: '2026-10-14T10:31:00.000Z' }), null)).toMatch(/Відновлено[\s\S]*тривалість 31 хв/);
    expect(renderMessage('resolved', incident({ resolution: 'process_gone', resolvedAt: '2026-10-14T10:05:00.000Z' }), null)).toMatch(/без підтвердження відновлення[\s\S]*більше не відображається/);
    expect(renderMessage('firing', incident(), null)).not.toContain(WEBHOOK);
  });
});

describe('sendToSlack (mock transport)', () => {
  const send = (fetchImpl: () => Promise<Response>, timeoutMs = 1000, signal = new AbortController().signal) =>
    sendToSlack(WEBHOOK, 'x', { timeoutMs, signal, fetchImpl });

  it('only 200 "ok" is success; 429 → retry with Retry-After; 5xx → retry; documented 4xx codes → permanent', async () => {
    expect(await send(reply(200, 'ok'))).toEqual({ kind: 'sent' });
    expect(await send(reply(200, 'something else'))).toEqual({ kind: 'permanent', code: 'unexpected_response' });
    expect(await send(reply(429, 'rate_limited', { 'retry-after': '30' }))).toEqual({ kind: 'retry', code: 'rate_limited', retryAfterSeconds: 30 });
    expect(await send(reply(503, 'oops'))).toEqual({ kind: 'retry', code: 'http_503', retryAfterSeconds: null });
    expect(await send(reply(400, 'invalid_payload'))).toEqual({ kind: 'permanent', code: 'invalid_payload' });
    expect(await send(reply(404, 'no_service'))).toEqual({ kind: 'permanent', code: 'no_service' });
    expect(await send(reply(403, `secret ${WEBHOOK}`))).toEqual({ kind: 'permanent', code: 'http_403' }); // response text never reflected
  });

  it('network error → retry; timeout or abort after sending → unknown; oversized bodies are bounded; no redirects; no URL in outcomes', async () => {
    expect(await send(() => Promise.reject(new TypeError(`fetch failed ${WEBHOOK}`)))).toEqual({ kind: 'retry', code: 'network', retryAfterSeconds: null });
    const hang = (_u: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); });
    expect(await send(hang as never, 50)).toEqual({ kind: 'unknown', code: 'timeout' });
    const ac = new AbortController();
    const pending = send(hang as never, 5000, ac.signal);
    ac.abort();
    expect(await pending).toEqual({ kind: 'unknown', code: 'aborted' });
    expect(await send(reply(200, `ok${'x'.repeat(10_000)}`))).toMatchObject({ kind: 'permanent' });
    const seen: RequestInit[] = [];
    await send(((_u: unknown, init: RequestInit) => { seen.push(init); return Promise.resolve(new Response('ok')); }) as never);
    expect(seen[0]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(seen[0]?.body as string)).toEqual({ text: 'x' }); // top-level text only: no blocks, no link_names
  });
});

class FakeStore implements AlertsStore {
  items: ClaimedItem[] = [];
  finished: { id: string; status: string; code?: string; delaySeconds?: number }[] = [];
  evaluations = 0;
  failEvaluate = false;
  evaluateOnce() {
    this.evaluations += 1;
    if (this.failEvaluate) return Promise.reject(Object.assign(new Error(`relation secret ${WEBHOOK}`), { code: '57P01' }));
    return Promise.resolve({ skipped: false, opened: 0, resolved: 0, observed: 0, enqueued: 0, dropped: 0, at: '2026-10-14T10:00:00.000Z' });
  }
  claim(limit: number) { return Promise.resolve(this.items.splice(0, limit)); }
  finish(item: { id: string }, outcome: { status: string; code?: string; delaySeconds?: number }) {
    this.finished.push({ id: item.id, ...outcome });
    return Promise.resolve(true);
  }
  listIncidents() { return Promise.resolve({ items: [], nextBefore: null }); }
  summary() { return Promise.resolve({ active: 0, queue: null, lastSentAt: null }); }
}
const item = (id: string, attempts = 1): ClaimedItem => ({ id, kind: 'firing', attempts, incident: incident() });
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('delivery loop', () => {
  it('sent / 429 backoff ≥ Retry-After / permanent → failed / transient at max attempts → failed / unknown at max → unknown', async () => {
    const store = new FakeStore();
    store.items = [item('1'), item('2'), item('3'), item('4', 6), item('5', 6), item('6')];
    const responses = [reply(200, 'ok'), reply(429, '', { 'retry-after': '120' }), reply(400, 'invalid_payload'), reply(500, ''), () => Promise.reject(new Error('x')), reply(500, '')];
    let n = 0;
    const timeoutFetch = (_u: unknown, init?: RequestInit) => new Promise<Response>((_r, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('t')); }); });
    const fetchImpl = ((u: unknown, init?: RequestInit) => { const i = n++; return i === 4 ? timeoutFetch(u, init) : (responses[i] ?? reply(200, 'ok'))(); }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const engine = new AlertsEngine(store, config({ ALERTS_HTTP_TIMEOUT_MS: '1000' }), quiet, { fetchImpl, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
    await engine.deliverNow();
    await engine.deliverNow();
    expect(store.finished.map((f) => [f.id, f.status, f.code])).toEqual([
      ['1', 'sent', undefined], ['2', 'queued', 'rate_limited'], ['3', 'failed', 'invalid_payload'], ['4', 'failed', 'http_500'], ['5', 'unknown', 'timeout'], ['6', 'queued', 'http_500'],
    ]);
    expect(store.finished[1]?.delaySeconds).toBeGreaterThanOrEqual(120);
    expect(sleeps.every((ms) => ms >= 1000)).toBe(true); // ~1 message per second per webhook
    expect(engine.stats().lastDeliveryAt).not.toBeNull();
  }, 15_000);

  it('backoff: exponential with jitter, capped at 30 min, never below Retry-After', () => {
    expect(backoffSeconds(1, null, () => 0.5)).toBe(30);
    expect(backoffSeconds(3, null, () => 0.5)).toBe(120);
    expect(backoffSeconds(20, null, () => 1)).toBe(2160);
    expect(backoffSeconds(1, 600, () => 0)).toBe(600);
  });

  it('a failing evaluation is recorded as metadata and never throws; the URL is never logged', async () => {
    const store = new FakeStore();
    store.failEvaluate = true;
    const logged: string[] = [];
    const engine = new AlertsEngine(store, config(), { info: (o) => logged.push(JSON.stringify(o)), warn: (o) => logged.push(JSON.stringify(o)), error: (o) => logged.push(JSON.stringify(o)) });
    await expect(engine.evaluateNow()).resolves.toBeUndefined();
    expect(engine.stats()).toMatchObject({ lastEvaluationOk: false, lastEvaluationError: 'internal' }); // a category, never the message
    expect(logged.join('\n')).not.toContain('hooks.slack.com');
  });

  it('stop() during a hanging Slack request: aborts it promptly, re-queues the item (at-least-once), stops scheduling', async () => {
    vi.useRealTimers();
    const store = new FakeStore();
    store.items = [item('9')];
    let started!: () => void;
    const inFlight = new Promise<void>((r) => { started = r; });
    const hang = ((_u: unknown, init?: RequestInit) => { started(); return new Promise<Response>((_r, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); }); }) as unknown as typeof fetch;
    const engine = new AlertsEngine(store, config({ ALERTS_HTTP_TIMEOUT_MS: '30000' }), quiet, { fetchImpl: hang });
    const delivering = engine.deliverNow();
    await inFlight;
    const t0 = Date.now();
    await engine.stop();
    await delivering;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(store.finished).toEqual([{ id: '9', status: 'queued', code: 'aborted', delaySeconds: 1 }]);
    expect(engine.stats().running).toBe(false);
  });
});
