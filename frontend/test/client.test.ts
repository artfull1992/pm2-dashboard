import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, authApi, fetchAuditPage, parseRetryAfter } from '../src/api/client';
import { ContractError, parseAuditPage, parseControlView, parseServiceOptionList, parseSessionInfo, parseUserAccess } from '../src/api/types';
import { CSRF, installFetch, json, noContent, session } from './support';

afterEach(() => { vi.unstubAllGlobals(); });

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected ApiError');
}

describe('request shape', () => {
  it('login: relative URL, POST JSON, same-origin credentials, no CSRF header, validated response', async () => {
    const calls = installFetch(() => json(200, session()));
    await expect(authApi.login('a@b.c', 'secret-password-1')).resolves.toMatchObject({ user: { role: 'admin' } });
    expect(calls[0]).toMatchObject({ url: '/api/auth/login', method: 'POST', credentials: 'same-origin' });
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.get('x-csrf-token')).toBeNull();
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ email: 'a@b.c', password: 'secret-password-1' });
  });

  it('logout: sends x-csrf-token, no body, accepts 204', async () => {
    const calls = installFetch(() => noContent());
    await expect(authApi.logout(CSRF)).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ url: '/api/auth/logout', method: 'POST', body: undefined });
    expect(calls[0]?.headers.get('x-csrf-token')).toBe(CSRF);
  });

  it('a body where 204 is expected is a contract violation', async () => {
    installFetch(() => json(200, {}));
    expect((await errorOf(authApi.logout(CSRF))).kind).toBe('unexpected');
  });

  it('audit: bounded limit and keyset parameter; malformed beforeId is never sent', async () => {
    const calls = installFetch(() => json(200, { items: [], nextBeforeId: null }));
    await fetchAuditPage(null);
    await fetchAuditPage('42');
    expect(calls.map((c) => c.url)).toEqual(['/api/audit?limit=25', '/api/audit?limit=25&beforeId=42']);
    expect((await errorOf(fetchAuditPage('1&limit=1000'))).kind).toBe('invalid_request');
    expect(calls).toHaveLength(2);
  });
});

describe('error mapping (no server text is ever surfaced)', () => {
  it.each([
    [400, 'invalid_request'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'],
    [429, 'rate_limited'], [500, 'unexpected'], [502, 'unavailable'], [503, 'unavailable'], [504, 'unavailable'],
  ])('%i → %s', async (status, kind) => {
    installFetch(() => json(status, { statusCode: status, message: '<script>server text</script>' }));
    const error = await errorOf(authApi.me());
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.message).toBe(kind);
  });

  it('Retry-After is parsed (seconds and HTTP date) and bounded', async () => {
    installFetch(() => json(429, {}, { 'retry-after': '30' }));
    expect((await errorOf(authApi.me())).retryAfterSeconds).toBe(30);
    expect(parseRetryAfter(new Date(Date.UTC(2030, 0, 1, 0, 1)).toUTCString(), Date.UTC(2030, 0, 1))).toBe(60);
    expect(parseRetryAfter('99999999')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('network failure, timeout and caller abort are distinguished', async () => {
    installFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect((await errorOf(authApi.me())).kind).toBe('network');

    installFetch((req) => new Promise<Response>((_, reject) => {
      req.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
    }));
    expect((await errorOf(apiRequest('/api/auth/me', { timeoutMs: 20, parse: parseSessionInfo }))).kind).toBe('timeout');
    const controller = new AbortController();
    const pending = authApi.me(controller.signal);
    controller.abort();
    expect((await errorOf(pending)).kind).toBe('aborted');
  });

  it('invalid JSON and contract violations → unexpected', async () => {
    installFetch(() => new Response('not json', { status: 200 }));
    expect((await errorOf(authApi.me())).kind).toBe('unexpected');
    installFetch(() => json(200, { ...session(), user: { id: 'x', email: 'a@b', role: 'root' } }));
    expect((await errorOf(authApi.me())).kind).toBe('unexpected');
  });
});

describe('runtime validation', () => {
  it('session: rejects unknown permissions, malformed CSRF token, bad dates', () => {
    expect(() => parseSessionInfo({ ...session(), permissions: ['everything'] })).toThrow();
    expect(() => parseSessionInfo({ ...session(), csrfToken: 'short' })).toThrow();
    expect(() => parseSessionInfo({ ...session(), expiresAt: 'tomorrow' })).toThrow();
    expect(parseSessionInfo({ ...session(), extra: 'ignored' })).not.toHaveProperty('extra');
  });

  it('audit: keeps only allowlisted detail keys; rejects malformed items', () => {
    const page = parseAuditPage({
      items: [{ id: '7', occurredAt: '2026-10-12T10:00:00.000Z', event: 'auth.login', outcome: 'failure', actorUserId: null, requestId: null, details: { reason: 'invalid_credentials', html: '<b>x</b>' } }],
      nextBeforeId: null,
    });
    expect(page.items[0]?.details).toEqual({ reason: 'invalid_credentials' });
    expect(() => parseAuditPage({ items: [{ id: 'x' }], nextBeforeId: null })).toThrow();
    expect(() => parseAuditPage({ items: Array.from({ length: 101 }, () => ({})), nextBeforeId: null })).toThrow();
  });
});

// Task 011.1: a transport that completes AFTER cancellation must not yield a result — the caller has moved on.
describe('cancellation on the success path', () => {
  function lateTransport(response: () => Response) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { await gate; return response(); }));
    return release;
  }

  it('a 204 that arrives after the caller aborted → aborted, not success', async () => {
    const release = lateTransport(() => noContent());
    const controller = new AbortController();
    const pending = errorOf(authApi.changePassword('synthetic-Current-1', 'synthetic-Next-Pass-2', CSRF, controller.signal));
    controller.abort();
    release();
    expect((await pending).kind).toBe('aborted');
  });

  it('a valid JSON body that arrives after the caller aborted → aborted, not parsed data', async () => {
    const release = lateTransport(() => json(200, session()));
    const controller = new AbortController();
    const pending = errorOf(authApi.me(controller.signal));
    controller.abort();
    release();
    expect((await pending).kind).toBe('aborted');
  });

  it('a success that arrives after the timeout → timeout', async () => {
    const release = lateTransport(() => noContent());
    const pending = errorOf(apiRequest('/api/auth/logout', { method: 'POST', csrfToken: CSRF, timeoutMs: 10 }));
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect((await pending).kind).toBe('timeout');
  });
});

describe('ADR-028 contracts', () => {
  const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const target = (i: number) => ({ targetKey: `n-${String(i).padStart(24, '0')}`, name: `svc-${String(i)}`, pmId: i, actions: ['restart'], matchStatus: 'ok' });
  const view = (over: Record<string, unknown> = {}) => ({
    serverId: SID, enabled: true, serverStatus: 'online', targetFreshSeconds: 60, targets: Array.from({ length: 500 }, (_, i) => target(i)),
    broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: '2026-10-21T10:00:00.000Z', fresh: true, mode: 'auto', protocol: 2, total: 640 }, ...over,
  });

  it('control view: up to 500 targets of an auto broker, mode/protocol/total parsed; an old API without them still parses', () => {
    expect(parseControlView(view()).broker).toMatchObject({ mode: 'auto', protocol: 2, total: 640 });
    expect(() => parseControlView(view({ targets: Array.from({ length: 501 }, (_, i) => target(i)) }))).toThrow(ContractError);
    expect(() => parseControlView(view({ broker: { ...view().broker, mode: 'open' } }))).toThrow(ContractError);
    const old = view({ broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: '2026-10-21T10:00:00.000Z', fresh: true } });
    expect(parseControlView(old).broker).toMatchObject({ mode: null, protocol: 1, total: null });
  });

  it('user access: strict shape; unknown mode or wrong user id is a contract violation', () => {
    const ok = { userId: SID, email: 'x@example.test', role: 'viewer', isActive: true, global: false, revision: 2,
      servers: [{ serverId: SID, serverName: 'alpha', serverActive: true, mode: 'selected', grantedAt: '2026-10-21T10:00:00.000Z', services: [{ name: 'api', available: false }] }] };
    expect(parseUserAccess(ok).servers[0]?.services).toEqual([{ name: 'api', available: false }]);
    expect(() => parseUserAccess({ ...ok, servers: [{ ...ok.servers[0], mode: 'some' }] })).toThrow(ContractError);
    expect(() => parseUserAccess({ ...ok, revision: -1 })).toThrow(ContractError);
    expect(() => parseServiceOptionList({ serverId: 'other', items: [], truncated: false }, SID)).toThrow(ContractError);
  });
});
