import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SessionBinding, AuthProvider, useAuth } from '../src/auth/AuthContext';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp } from './support';

// Review 217af0b: the silent expiry re-check (review 73bfd84) must accept the answer as the SAME session only when it
// is the same server session — user id, CSRF token (an HMAC of the session token, unique per session) and the
// absolute expiry. Another session (another user, or a new session of the same user) is a session change: the old
// epoch ends (pending auth operations and bindings of the old session are void), the private area remounts empty.
// Late answers of older operations never change a newer session. Synthetic values only.

const PAST = new Date(Date.now() - 90 * 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();
const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const VIEWER_ID = '00000000-0000-4000-8000-0000000000b2';
const sessionOf = (id: string, email: string, role: 'admin' | 'viewer', csrf: string, expiresAt: string) => ({
  user: { id, email, role }, csrfToken: csrf.repeat(43), expiresAt,
  permissions: role === 'admin' ? ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] : ['monitoring:read'],
});
const A = sessionOf(ADMIN_ID, 'admin@example.test', 'admin', 'a', PAST); // past due by this browser's clock
const B = sessionOf(VIEWER_ID, 'viewer@example.test', 'viewer', 'b', FUTURE); // another user
const A2 = sessionOf(ADMIN_ID, 'admin@example.test', 'admin', 'c', FUTURE); // a new session of the same user

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/alerts/status') return json(200, { engine: { enabled: true, running: true, lastEvaluationAt: FUTURE, lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: 0, admin: null });
    if (req.url.startsWith('/api/alerts?')) return json(200, { items: [], nextBefore: null });
    if (req.url.startsWith('/api/dashboard')) return json(503, {});
    return json(404, {});
  });
}
const meCalls = (calls: RecordedRequest[]) => calls.filter((c) => c.url === '/api/auth/me').length;
const fake = () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('silent re-check changes the session', () => {
  it('another user (B): a late 204 of A\'s logout does not end B (Codex reproducer)', async () => {
    const user = fake();
    const logout = deferred<Response>();
    let me = 0;
    backend((req) => {
      if (req.url === '/api/auth/logout') return logout.promise;
      if (req.url === '/api/auth/me') { me += 1; return json(200, me === 1 ? A : B); }
      return undefined;
    });
    renderApp('/alerts');
    expect(await screen.findByText('admin@example.test')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Вийти' }));
    await tick(1_100); // A's expiry is due: the re-check answers with B
    expect(me).toBe(2);
    await waitFor(() => { expect(screen.getByText('viewer@example.test')).toBeTruthy(); });
    await act(async () => { logout.resolve(noContent()); await Promise.resolve(); });
    await tick(50);
    expect(screen.getByText('viewer@example.test')).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('a new session of the same user (A → A2) remounts the private area: A\'s unsaved page state is gone', async () => {
    const user = fake();
    let me = 0;
    backend((req) => (req.url === '/api/auth/me' ? (me += 1, json(200, me === 1 ? A : A2)) : undefined));
    renderApp('/alerts');
    const search = await screen.findByLabelText('Пошук на цій сторінці');
    await user.type(search, 'draft of A');
    await tick(1_100);
    await waitFor(() => { expect(me).toBe(2); });
    await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe(''); });
  });

  it('the same session confirmed again keeps the page (draft) and is re-checked once a minute, not every second', async () => {
    const user = fake();
    const calls = backend((req) => (req.url === '/api/auth/me' ? json(200, A) : undefined));
    renderApp('/alerts');
    await user.type(await screen.findByLabelText('Пошук на цій сторінці'), 'kept');
    const before = meCalls(calls);
    await tick(10_000);
    expect(meCalls(calls) - before).toBe(1);
    expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe('kept');
    await tick(61_000);
    expect(meCalls(calls) - before).toBe(2);
    expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe('kept');
  });

  it('a transient re-check failure keeps the session and does not loop', async () => {
    const user = fake();
    let me = 0;
    const calls = backend((req) => (req.url === '/api/auth/me' ? (me += 1, me === 1 ? json(200, A) : json(503, {})) : undefined));
    renderApp('/alerts');
    await user.type(await screen.findByLabelText('Пошук на цій сторінці'), 'kept');
    await tick(10_000);
    expect(meCalls(calls)).toBe(2); // initial + one failed re-check, no retry every second
    expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe('kept');
    await tick(61_000);
    expect(meCalls(calls)).toBe(3);
  });

  it('401 of the current session\'s re-check ends it (sign-in, «session expired»)', async () => {
    fake();
    let me = 0;
    backend((req) => (req.url === '/api/auth/me' ? (me += 1, me === 1 ? json(200, A) : json(401, {})) : undefined));
    renderApp('/alerts');
    await screen.findByText('admin@example.test');
    await tick(1_100);
    expect(await screen.findByLabelText('Email')).toBeTruthy();
  });
});

// Bindings and late answers, observed directly on the auth context.
let probe: ReturnType<typeof useAuth> | null = null;
function Probe() {
  const value = useAuth();
  useEffect(() => { probe = value; });
  const s = value.state;
  return <p data-testid="auth">{s.status === 'authenticated' ? `${s.session.user.email}|${s.session.csrfToken.slice(0, 1)}` : s.status}</p>;
}
const shown = () => screen.getByTestId('auth').textContent;
const auth = () => { if (!probe) throw new Error('no auth context'); return probe; };

describe('bindings and late answers', () => {
  it('a binding of A is void once the re-check confirms another session of the same user; A\'s passwordChanged does nothing', async () => {
    fake();
    let me = 0;
    backend((req) => (req.url === '/api/auth/me' ? (me += 1, json(200, me === 1 ? A : A2)) : undefined));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => { expect(shown()).toBe('admin@example.test|a'); });
    let binding: SessionBinding | null = null;
    act(() => { binding = auth().bindSession(); });
    await tick(1_100);
    await waitFor(() => { expect(shown()).toBe('admin@example.test|c'); });
    expect(binding).not.toBeNull();
    expect((binding as SessionBinding | null)?.current()).toBe(false);
    act(() => { auth().passwordChanged(binding as unknown as SessionBinding); });
    expect(shown()).toBe('admin@example.test|c');
  });

  it('a binding survives a re-check that confirms the same session', async () => {
    fake();
    backend((req) => (req.url === '/api/auth/me' ? json(200, A) : undefined));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => { expect(shown()).toBe('admin@example.test|a'); });
    let binding: SessionBinding | null = null;
    act(() => { binding = auth().bindSession(); });
    await tick(1_100);
    expect((binding as SessionBinding | null)?.current()).toBe(true);
  });

  it('a re-check answered after logout does not bring the old session back', async () => {
    fake();
    const late = deferred<Response>();
    let me = 0;
    backend((req) => {
      if (req.url === '/api/auth/logout') return noContent();
      if (req.url === '/api/auth/me') { me += 1; return me === 1 ? json(200, A) : late.promise; }
      return undefined;
    });
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => { expect(shown()).toBe('admin@example.test|a'); });
    await tick(1_100); // re-check is now pending
    expect(me).toBe(2);
    await act(async () => { await auth().logout(); });
    expect(shown()).toBe('anonymous');
    await act(async () => { late.resolve(json(200, A)); await Promise.resolve(); });
    await tick(10);
    expect(shown()).toBe('anonymous');
  });

  it('a re-check answered after a new login (success or 401) does not overwrite or end the new session', async () => {
    for (const lateAnswer of [() => json(200, A), () => json(401, {})]) {
      fake();
      const late = deferred<Response>();
      let me = 0;
      backend((req) => {
        if (req.url === '/api/auth/login') return json(200, B);
        if (req.url === '/api/auth/me') { me += 1; return me === 1 ? json(200, A) : late.promise; }
        return undefined;
      });
      const view = render(<AuthProvider><Probe /></AuthProvider>);
      await waitFor(() => { expect(shown()).toBe('admin@example.test|a'); });
      await tick(1_100);
      expect(me).toBe(2);
      await act(async () => { await auth().login('viewer@example.test', 'synthetic-password'); });
      expect(shown()).toBe('viewer@example.test|b');
      await act(async () => { late.resolve(lateAnswer()); await Promise.resolve(); });
      await tick(10);
      expect(shown()).toBe('viewer@example.test|b');
      view.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
