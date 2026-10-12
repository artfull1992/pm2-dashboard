// Regression for review P1 (Task 006.1): behind Nginx the socket peer is always the proxy, so the login
// address limiter must key on the client address that the TRUSTED proxy reports — and nothing else.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createRateLimiter } from '../src/auth/rate-limit.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { FAKE_SECRET, fakeDatabase } from './helpers.js';
import { FakeAuthStore } from './support/fake-auth-store.js';

const ORIGIN = 'https://nc.example.test';
const NGINX = '127.0.0.1';
let app: FastifyInstance;
let store: FakeAuthStore;
afterEach(async () => { await app.close(); });

function build(options: { trustedProxies?: string[]; addressMax?: number; accountMax?: number } = {}) {
  store = new FakeAuthStore();
  app = buildApp({
    logLevel: 'silent',
    readinessTimeoutMs: 200,
    createDatabase: () => fakeDatabase(),
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
    auth: {
      config: { allowedOrigins: [ORIGIN], cookieSecure: true, sessionTtlSeconds: 3600 },
      createStore: () => store,
      extra: {
        addressLimiter: createRateLimiter({ max: options.addressMax ?? 1000, windowMs: 60_000 }),
        accountLimiter: createRateLimiter({ max: options.accountMax ?? 1000, windowMs: 60_000 }),
      },
    },
  });
  // Test-only probe route (not part of the API): shows how Fastify resolved the client address.
  app.get('/whoami', (request) => ({ ip: request.ip }));
  return app;
}

async function ipSeen(remoteAddress: string, headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: '/whoami', remoteAddress, headers });
  return res.json<{ ip: string }>().ip;
}

/** One login attempt with an unknown account (fails with 401 unless rate limited → 429). */
async function attempt(remoteAddress: string, headers: Record<string, string> = {}, email = `u${String(Math.random()).slice(2)}@example.test`) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', remoteAddress,
    headers: { origin: ORIGIN, ...headers }, payload: { email, password: 'synthetic-wrong-password' },
  });
  return res.statusCode;
}

describe('client address resolution', () => {
  it('default (no trusted proxy): forwarded headers are ignored, even from loopback', async () => {
    build();
    expect(await ipSeen(NGINX, { 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '203.0.113.6' })).toBe(NGINX);
  });

  it('trusted local proxy: the address in X-Forwarded-For becomes request.ip', async () => {
    build({ trustedProxies: [NGINX] });
    expect(await ipSeen(NGINX, { 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
    expect(await ipSeen(NGINX, { 'x-forwarded-for': '2001:db8::7' })).toBe('2001:db8::7');
  });

  it('untrusted peer: its forwarded headers do not change the client address', async () => {
    build({ trustedProxies: [NGINX] });
    expect(await ipSeen('198.51.100.7', { 'x-forwarded-for': '203.0.113.5' })).toBe('198.51.100.7');
    expect(await ipSeen('127.0.0.2', { 'x-forwarded-for': '203.0.113.5' })).toBe('127.0.0.2');
  });

  it('X-Real-IP is never a source of the client address', async () => {
    build({ trustedProxies: [NGINX] });
    expect(await ipSeen(NGINX, { 'x-real-ip': '203.0.113.9' })).toBe(NGINX);
    expect(await ipSeen(NGINX, { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
  });

  it('a client-forged chain cannot pick its address: only the hop appended by the trusted proxy counts', async () => {
    build({ trustedProxies: [NGINX] });
    // If a proxy appended instead of replacing, the rightmost (proxy-observed) address still wins.
    expect(await ipSeen(NGINX, { 'x-forwarded-for': '10.9.9.9, 203.0.113.5' })).toBe('203.0.113.5');
  });

  it('missing or malformed X-Forwarded-For from the proxy: defined, safe results', async () => {
    build({ trustedProxies: [NGINX] });
    expect(await ipSeen(NGINX)).toBe(NGINX);
    expect(await ipSeen(NGINX, { 'x-forwarded-for': '' })).toBe(NGINX);
    expect(await ipSeen(NGINX, { 'x-forwarded-for': 'not-an-ip' })).toBe('not-an-ip'); // → 'unresolved' bucket below
  });
});

describe('login address limiter behind the trusted proxy', () => {
  it('different clients behind Nginx have independent limits; one client hitting it does not block another', async () => {
    build({ trustedProxies: [NGINX], addressMax: 2 });
    const a = { 'x-forwarded-for': '203.0.113.10' };
    const b = { 'x-forwarded-for': '203.0.113.20' };
    expect([await attempt(NGINX, a), await attempt(NGINX, a), await attempt(NGINX, a)]).toEqual([401, 401, 429]);
    expect([await attempt(NGINX, b), await attempt(NGINX, b)]).toEqual([401, 401]);
  });

  it('without trust (default), everything behind the proxy shares the peer bucket — the reported P1', async () => {
    build({ addressMax: 2 });
    expect([
      await attempt(NGINX, { 'x-forwarded-for': '203.0.113.10' }),
      await attempt(NGINX, { 'x-forwarded-for': '203.0.113.20' }),
      await attempt(NGINX, { 'x-forwarded-for': '203.0.113.30' }),
    ]).toEqual([401, 401, 429]);
  });

  it('spoofed forwarded headers from an untrusted peer do not escape the limit', async () => {
    build({ trustedProxies: [NGINX], addressMax: 2 });
    const peer = '198.51.100.7';
    const statuses = [];
    for (const forged of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      statuses.push(await attempt(peer, { 'x-forwarded-for': forged, 'x-real-ip': forged }));
    }
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('spoofed X-Real-IP through the trusted proxy does not escape the limit', async () => {
    build({ trustedProxies: [NGINX], addressMax: 2 });
    const realClient = { 'x-forwarded-for': '203.0.113.10' };
    const statuses = [];
    for (const forged of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) statuses.push(await attempt(NGINX, { ...realClient, 'x-real-ip': forged }));
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('malformed proxy-reported addresses share one "unresolved" bucket instead of minting new keys', async () => {
    build({ trustedProxies: [NGINX], addressMax: 2 });
    expect([
      await attempt(NGINX, { 'x-forwarded-for': 'garbage-1' }),
      await attempt(NGINX, { 'x-forwarded-for': 'garbage-2' }),
      await attempt(NGINX, { 'x-forwarded-for': 'garbage-3' }),
    ]).toEqual([401, 401, 429]);
  });

  it('per-account limit still applies across different client addresses', async () => {
    build({ trustedProxies: [NGINX], accountMax: 2 });
    const email = 'victim@example.test';
    expect([
      await attempt(NGINX, { 'x-forwarded-for': '203.0.113.1' }, email),
      await attempt(NGINX, { 'x-forwarded-for': '203.0.113.2' }, email),
      await attempt(NGINX, { 'x-forwarded-for': '203.0.113.3' }, email),
    ]).toEqual([401, 401, 429]);
  });

  it('Origin/CSRF checks are unchanged behind the proxy', async () => {
    build({ trustedProxies: [NGINX] });
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: NGINX,
      headers: { origin: 'https://evil.example', 'x-forwarded-for': '203.0.113.10' }, payload: { email: 'a@b.c', password: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(store.calls.findLoginUser).toBeUndefined();
  });
});

describe('API_TRUSTED_PROXIES configuration', () => {
  const base = { DB_NAME: 'n', DB_USER: 'u', DB_PASS: FAKE_SECRET };
  const issues = (value: string) => {
    try { loadConfig({ ...base, API_TRUSTED_PROXIES: value }); } catch (error) { if (error instanceof ConfigError) return error.issues; throw error; }
    return [];
  };

  it('default: no trusted proxies (trustProxy off)', () => {
    expect(loadConfig(base).api.trustedProxies).toEqual([]);
    expect(loadConfig({ ...base, API_TRUSTED_PROXIES: '' }).api.trustedProxies).toEqual([]);
  });

  it('accepts exact loopback addresses, de-duplicated', () => {
    expect(loadConfig({ ...base, API_TRUSTED_PROXIES: '127.0.0.1, ::1,127.0.0.1' }).api.trustedProxies).toEqual(['127.0.0.1', '::1']);
  });

  it.each(['0.0.0.0/0', '127.0.0.0/8', 'localhost', 'nginx.internal', '10.0.0.5', '203.0.113.5', '*', 'true', '::'])('rejects %s without echoing it', (value) => {
    const found = issues(value);
    expect(found).toEqual(['API_TRUSTED_PROXIES must list loopback IP addresses only (e.g. 127.0.0.1); no hostnames or ranges']);
    expect(found.join(' ')).not.toContain(value === '::' ? ':::' : value);
  });

  it('caps the list length', () => {
    expect(issues('127.0.0.1,127.0.0.2,127.0.0.3,127.0.0.4,127.0.0.5')).toEqual(['API_TRUSTED_PROXIES allows at most 4 addresses']);
  });
});
