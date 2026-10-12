import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FAKE_SECRET, fakeDatabase, testApp } from './helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function setup(...args: Parameters<typeof testApp>) {
  const result = testApp(...args);
  apps.push(result.app);
  return result;
}

const failingCheck = () => Promise.reject(Object.assign(
  new Error(`password authentication failed for user "node_control_user" pass=${FAKE_SECRET} at 10.0.0.5`),
  { code: '28P01' },
));

describe('GET /health/live', () => {
  it('returns 200 {status:"ok"} with no-store and a request id', async () => {
    const { app } = setup(fakeDatabase());
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  it('stays 200 and never touches the database when it is down', async () => {
    const database = fakeDatabase(failingCheck);
    const { app } = setup(database);
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(database.check).not.toHaveBeenCalled();
  });
});

describe('GET /health/ready', () => {
  it('returns 200 {status:"ready"} after a successful check', async () => {
    const database = fakeDatabase();
    const { app } = setup(database);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(database.check).toHaveBeenCalledOnce();
  });

  it('returns 503 {status:"unavailable"} on DB error without internal details', async () => {
    const { app, logs } = setup(fakeDatabase(failingCheck));
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    expect(res.headers['cache-control']).toBe('no-store');
    for (const leak of [FAKE_SECRET, 'node_control', '28P01', '10.0.0.5', 'stack']) expect(res.body).not.toContain(leak);
    expect(logs.text()).toContain('Readiness check failed');
  });

  it('returns 503 when the check exceeds the readiness timeout', async () => {
    const { app } = setup(fakeDatabase(() => new Promise(() => undefined)), { readinessTimeoutMs: 50 });
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('recovers to 200 once the database is back', async () => {
    let healthy = false;
    const { app } = setup(fakeDatabase(() => (healthy ? Promise.resolve() : Promise.reject(new Error('down')))));
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
    healthy = true;
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
  });
});

describe('routing and errors', () => {
  it('unknown route returns a minimal 404 that does not echo the path', async () => {
    const { app } = setup(fakeDatabase());
    const res = await app.inject({ method: 'GET', url: '/admin/secret-path?token=abc' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
    expect(res.body).not.toContain('secret-path');
  });

  it('wrong method on a health path is 404, not handled', async () => {
    const { app } = setup(fakeDatabase());
    expect((await app.inject({ method: 'POST', url: '/health/live' })).statusCode).toBe(404);
  });

  it('internal errors return a generic 500 without stack, SQL or secrets, and are logged', async () => {
    const { app, logs } = setup(fakeDatabase());
    app.get('/boom', () => { throw new Error(`SELECT * FROM secret_table WHERE pass='${FAKE_SECRET}'`); });
    const res = await app.inject('/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
    expect(res.body).not.toMatch(/SELECT|secret_table|at .*\.ts/);
    expect(res.body).not.toContain(FAKE_SECRET);
    expect(logs.records().some((r) => r.msg === 'Unhandled error' && r.level === 50)).toBe(true);
  });

  it('errors with a 5xx statusCode are also masked', async () => {
    const { app } = setup(fakeDatabase());
    app.get('/bad-gateway', () => { throw Object.assign(new Error('upstream db host 10.1.1.1'), { statusCode: 502 }); });
    const res = await app.inject('/bad-gateway');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('10.1.1.1');
  });

  it('validation errors return 400 with schema-derived issues', async () => {
    const { app } = setup(fakeDatabase());
    app.post('/echo', { schema: { body: { type: 'object', required: ['name'] } } }, () => ({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/echo', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Request validation failed',
      validation: [{ location: 'body', path: '/name', rule: 'required' }],
    });
  });

  it('does not add permissive CORS headers', async () => {
    const { app } = setup(fakeDatabase());
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('logging', () => {
  it('ignores client-supplied request ids', async () => {
    const { app } = setup(fakeDatabase());
    const res = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'injected\nid' } });
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
  });

  it('does not log credentials, cookies, query strings, bodies or DB secrets', async () => {
    const { app, logs } = setup(fakeDatabase(failingCheck));
    await app.inject({
      method: 'GET',
      url: '/health/ready?token=query-secret',
      headers: { authorization: 'Bearer auth-secret', cookie: 'session=cookie-secret', 'x-api-key': 'api-secret' },
    });
    await app.inject({ method: 'POST', url: '/nowhere', payload: { password: 'body-secret' } });
    const text = logs.text();
    expect(text.length).toBeGreaterThan(0);
    for (const leak of ['auth-secret', 'cookie-secret', 'api-secret', 'query-secret', 'body-secret']) expect(text).not.toContain(leak);
    const request = logs.records().find((r) => r.msg === 'incoming request');
    expect(request?.req).toMatchObject({ method: 'GET', path: '/health/ready' });
    expect(typeof request?.reqId).toBe('string');
  });

  it('redacts credential-bearing headers if they are ever logged', async () => {
    const { app, logs } = setup(fakeDatabase());
    app.get('/log-headers', (request) => {
      request.log.info({ req: { headers: request.headers } }, 'headers');
      return {};
    });
    await app.inject({ url: '/log-headers', headers: { authorization: 'Bearer auth-secret', cookie: 'c=cookie-secret' } });
    expect(logs.text()).not.toMatch(/auth-secret|cookie-secret/);
  });
});

describe('factory', () => {
  it('does not open a listener and creates the database exactly once', async () => {
    let created = 0;
    const app = buildApp({ logLevel: 'silent', readinessTimeoutMs: 100, createDatabase: () => { created += 1; return fakeDatabase(); } });
    apps.push(app);
    await app.ready();
    expect(app.server.listening).toBe(false);
    expect(app.addresses()).toEqual([]);
    expect(created).toBe(1);
  });

  it('closing the app closes the database once, even when closed twice', async () => {
    const database = fakeDatabase();
    const { app } = testApp(database);
    await app.close();
    await app.close();
    expect(database.close).toHaveBeenCalledOnce();
  });
});
