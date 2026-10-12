// Regression tests for the Task 002 review findings (Codex):
//  1) the 500 handler logged the raw Error (message/stack with secrets);
//  2) the 4xx handler reflected arbitrary error.name/error.message to clients.
// Test-only routes throw synthetic secrets; nothing is read from the real .env.
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { describeError, formatErrorMeta, TimeoutError, toErrorResponse } from '../src/errors.js';
import { fakeDatabase, testApp } from './helpers.js';

const SECRET = 'synthetic-secret-7f3a9c';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function setup() {
  const result = testApp(fakeDatabase());
  apps.push(result.app);
  return result;
}

function secretError(statusCode?: number): Error {
  const error = new Error(`token=${SECRET} SELECT * FROM users WHERE pass='${SECRET}'`);
  error.name = `Name${SECRET}`;
  error.stack = `Error: ${SECRET}\n    at secret (/srv/${SECRET}.ts:1:1)`;
  Object.assign(error, { cause: new Error(`cause ${SECRET}`), detail: SECRET });
  if (statusCode !== undefined) Object.assign(error, { statusCode });
  return error;
}

function expectNoLeak(...texts: string[]) {
  for (const text of texts) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/SELECT|\/srv\/|"stack"|\bat secret\b/);
  }
}

describe('internal errors (finding 1)', () => {
  it('500: response and logs carry no secret; event, category and reqId are logged', async () => {
    const { app, logs } = setup();
    app.get('/t/internal', () => { throw secretError(); });
    const res = await app.inject('/t/internal');

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
    expectNoLeak(res.body, logs.text());

    const record = logs.records().find((r) => r.msg === 'Unhandled error');
    expect(record).toMatchObject({ level: 50, error: { category: 'internal' } });
    expect(record?.reqId).toBe(res.headers['x-request-id']);
    expect(record?.reqId).toMatch(UUID_RE);
  });

  it('secret only in stack or a nested cause chain does not leak', async () => {
    const { app, logs } = setup();
    app.get('/t/stack', () => {
      const error = new Error('plain');
      error.stack = `Error: plain\n    at ${SECRET}`;
      throw error;
    });
    app.get('/t/cause', () => {
      throw new Error('outer', { cause: new Error('middle', { cause: Object.assign(new Error(SECRET), { code: SECRET }) }) });
    });
    for (const url of ['/t/stack', '/t/cause']) {
      const res = await app.inject(url);
      expect(res.statusCode).toBe(500);
      expectNoLeak(res.body);
    }
    expectNoLeak(logs.text());
  });

  it('5xx statusCode other than 500 is masked as a generic 500', async () => {
    const { app, logs } = setup();
    app.get('/t/502', () => { throw secretError(502); });
    const res = await app.inject('/t/502');
    expect(res.statusCode).toBe(500);
    expectNoLeak(res.body, logs.text());
  });
});

describe('client errors (finding 2)', () => {
  it.each([400, 403, 409, 422])('%i with secret in message/name/cause keeps status, uses a fixed text', async (status) => {
    const { app, logs } = setup();
    app.get('/t/client', () => { throw secretError(status); });
    const res = await app.inject('/t/client');
    expect(res.statusCode).toBe(status);
    const body = res.json<{ statusCode: number; error: string; message: string }>();
    expect(body.statusCode).toBe(status);
    expect(body.error).toBe(body.message);
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
    expectNoLeak(res.body, logs.text());
    expect(logs.records().find((r) => r.msg === 'Client error')).toMatchObject({ level: 30, statusCode: status, error: { category: 'client' } });
  });

  it('non-standard 4xx gets a generic client text', async () => {
    const { app } = setup();
    app.get('/t/499', () => { throw secretError(499); });
    const res = await app.inject('/t/499');
    expect(res.statusCode).toBe(499);
    expect(res.json()).toEqual({ statusCode: 499, error: 'Client Error', message: 'Client Error' });
  });

  it('Fastify parser errors keep their status with standard text (malformed JSON, wrong media type)', async () => {
    const { app } = setup();
    app.post('/t/body', () => ({ ok: true }));
    const bad = await app.inject({ method: 'POST', url: '/t/body', headers: { 'content-type': 'application/json' }, payload: `{"x":"${SECRET}"` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ statusCode: 400, error: 'Bad Request', message: 'Bad Request' });
    const media = await app.inject({ method: 'POST', url: '/t/body', headers: { 'content-type': 'text/x-secret' }, payload: SECRET });
    expect(media.statusCode).toBe(415);
    expect(media.json()).toEqual({ statusCode: 415, error: 'Unsupported Media Type', message: 'Unsupported Media Type' });
    expectNoLeak(bad.body, media.body);
  });
});

describe('validation errors', () => {
  it('400 lists location/path/rule from the schema and never the received values', async () => {
    const { app, logs } = setup();
    app.post('/t/validate', {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'port'],
          properties: { port: { type: 'integer', maximum: 65535 }, mode: { type: 'string', enum: ['a', 'b'] } },
        },
        querystring: { type: 'object', properties: { limit: { type: 'integer' } } },
      },
    }, () => ({ ok: true }));

    const res = await app.inject({ method: 'POST', url: '/t/validate', payload: { port: 70000, mode: SECRET, extra: SECRET } });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ validation: { location: string; path: string; rule: string }[] }>();
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request', message: 'Request validation failed' });
    expect(body.validation.length).toBeGreaterThan(0);
    for (const issue of body.validation) {
      expect(issue.location).toBe('body');
      expect(['/name', '/port', '/mode']).toContain(issue.path);
    }
    expectNoLeak(res.body, logs.text());

    const query = await app.inject({ method: 'POST', url: `/t/validate?limit=${SECRET}`, payload: { name: 'x', port: 1 } });
    expect(query.statusCode).toBe(400);
    expect(query.json()).toMatchObject({ validation: [{ location: 'querystring', path: '/limit', rule: 'type' }] });
    expectNoLeak(query.body, logs.text());
  });
});

describe('non-Error thrown values', () => {
  it.each([
    ['string', SECRET],
    ['object', { secret: SECRET, statusCode: 400, message: SECRET }],
    ['null', null],
  ])('%s → generic 500, nothing reflected or logged', async (_kind, value) => {
    const { app, logs } = setup();
    app.get('/t/throw', () => { throw value as unknown as Error; });
    const res = await app.inject('/t/throw');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' });
    expectNoLeak(res.body, logs.text());
  });
});

describe('describeError contract', () => {
  it('keeps only allowlisted codes', () => {
    expect(describeError(Object.assign(new Error(SECRET), { code: 'EADDRINUSE' }))).toEqual({ category: 'system', code: 'EADDRINUSE' });
    expect(describeError(Object.assign(new Error('x'), { code: `E${SECRET.toUpperCase()}` }))).toEqual({ category: 'internal' });
    expect(describeError(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 })))
      .toEqual({ category: 'client', code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 });
    expect(describeError(Object.assign(new pg.DatabaseError(SECRET, 0, 'error'), { code: '28P01' }))).toEqual({ category: 'database', code: '28P01' });
    expect(describeError(Object.assign(new pg.DatabaseError('x', 0, 'error'), { code: 'not-sqlstate' }))).toEqual({ category: 'database' });
    expect(describeError(new TimeoutError(5))).toEqual({ category: 'timeout', code: 'ETIMEDOUT' });
    expect(describeError({ message: SECRET })).toEqual({ category: 'non-error' });
    expect(describeError(Object.assign(new Error('x'), { statusCode: 777 }))).toEqual({ category: 'internal' });
  });

  it('formatErrorMeta and toErrorResponse output never contain the error text', () => {
    const error = secretError(400);
    expect(formatErrorMeta(describeError(error))).toBe('category=client status=400');
    expect(formatErrorMeta({ category: 'system', code: 'EPERM' })).toBe('category=system code=EPERM');
    expect(JSON.stringify(toErrorResponse(error))).not.toContain(SECRET);
    expect(toErrorResponse(undefined)).toEqual({
      statusCode: 500,
      body: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    });
  });
});
