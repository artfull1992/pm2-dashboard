import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { type NavigateFunction, MemoryRouter, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import { deferred, installFetch, json, type RecordedRequest, session } from './support';

// Regression for review finding P1 (Task 007.1): server detail state and credential controls are bound to the
// server id in the URL. Navigation /servers/A → /servers/B happens inside one real router (same route, new param),
// without a reload, exactly as a link click does.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = `ncag_${'A'.repeat(43)}`;
const TOKEN_B = `ncag_${'B'.repeat(43)}`;
const detail = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id, name, isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: '2026-10-12T10:05:00.000Z',
  hasActiveCredential: false, snapshot: null, ...overrides,
});
const issued = (id: string, token: string) => ({ serverId: id, token, issuedAt: '2026-10-12T11:00:00.000Z', rotated: false });

afterEach(() => { vi.unstubAllGlobals(); });

const nav: { current: NavigateFunction | null } = { current: null };
function Navigator() {
  const navigate = useNavigate();
  useEffect(() => { nav.current = navigate; }, [navigate]);
  return null;
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Navigator />
        <AppRoutes />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const go = async (path: string) => { await act(async () => { await nav.current?.(path); }); };
const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/servers/'));
const credentialButtons = () => screen.queryAllByRole('button', { name: /ключ/i });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route) {
  return installFetch((req) => route(req) ?? (req.url === '/api/auth/me' ? json(200, session('admin')) : json(404, {})));
}

async function openA() {
  expect(await screen.findByRole('heading', { name: 'server-a' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Видати ключ' })).toBeTruthy();
}

describe('server detail is bound to the server id in the URL', () => {
  it('A → B while B is still loading: no data and no controls of A', async () => {
    const slowB = deferred<Response>();
    backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a'));
      if (req.url === `/api/servers/${B}`) return slowB.promise;
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await go(`/servers/${B}`);
    expect(screen.queryByText('server-a')).toBeNull();
    expect(credentialButtons()).toEqual([]);
    expect(screen.getByRole('status').textContent).toContain('Завантаження');
    await act(async () => { slowB.resolve(json(200, detail(B, 'server-b'))); await Promise.resolve(); });
    expect(await screen.findByRole('heading', { name: 'server-b' })).toBeTruthy();
  });

  it('A → B with 503: A is not shown and nothing can be sent for A from the page of B', async () => {
    const calls = backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a', { snapshot: null }));
      if (req.url === `/api/servers/${B}`) return json(503, {}, { 'retry-after': '5' });
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await go(`/servers/${B}`);
    expect(await screen.findByText(/Сервіс тимчасово недоступний/)).toBeTruthy();
    expect(screen.queryByText('server-a')).toBeNull();
    expect(credentialButtons()).toEqual([]);
    expect(posts(calls)).toEqual([]);
  });

  it.each([
    [404, 'Сервер не знайдено'],
    [403, 'Недостатньо прав'],
  ])('A → B with %i shows the state of B, not A', async (status, heading) => {
    backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a'));
      if (req.url === `/api/servers/${B}`) return json(status, {});
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await go(`/servers/${B}`);
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.queryByText('server-a')).toBeNull();
    expect(credentialButtons()).toEqual([]);
  });

  it('after B has loaded, issue and revoke go to B only', async () => {
    const active = { [A]: false, [B]: false };
    const calls = backend((req) => {
      for (const [id, name] of [[A, 'server-a'], [B, 'server-b']] as const) {
        if (req.url === `/api/servers/${id}`) return json(200, detail(id, name, { hasActiveCredential: active[id] }));
        if (req.url === `/api/servers/${id}/agent-credentials`) { active[id] = true; return json(201, issued(id, id === A ? TOKEN_A : TOKEN_B)); }
        if (req.url === `/api/servers/${id}/agent-credentials/revoke`) { active[id] = false; return json(200, { serverId: id, revoked: true }); }
      }
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await go(`/servers/${B}`);
    expect(await screen.findByRole('heading', { name: 'server-b' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Видати ключ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ключ агента видано' });
    expect(within(dialog).getByDisplayValue(TOKEN_B)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /закрити/ }));
    await user.click(await screen.findByRole('button', { name: 'Відкликати ключ' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Відкликати' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Видати ключ' })).toBeTruthy(); });
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/servers/${B}/agent-credentials`, `/api/servers/${B}/agent-credentials/revoke`]);
  });

  it('a failed refresh of the same server keeps its last snapshot (with the error shown)', async () => {
    let fail = false;
    backend((req) => {
      if (req.url === `/api/servers/${A}`) return fail ? json(503, {}) : json(200, detail(A, 'server-a'));
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    fail = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(await screen.findByText(/Не вдалося оновити дані/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'server-a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Видати ключ' })).toBeTruthy();
  });

  it('pending issue for A, then navigation to B: the request is aborted and its token never reaches B', async () => {
    const pendingIssue = deferred<Response>();
    const calls = backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a'));
      if (req.url === `/api/servers/${B}`) return json(200, detail(B, 'server-b'));
      if (req.url === `/api/servers/${A}/agent-credentials`) return pendingIssue.promise;
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Видати ключ' }));
    await go(`/servers/${B}`);
    expect(await screen.findByRole('heading', { name: 'server-b' })).toBeTruthy();
    const issueA = posts(calls).find((c) => c.url === `/api/servers/${A}/agent-credentials`);
    expect(issueA?.signal?.aborted).toBe(true);
    await act(async () => { pendingIssue.resolve(json(201, issued(A, TOKEN_A))); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN_A);
    // B's controls are fresh: not stuck in "pending" from A's request.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Видати ключ' }).disabled).toBe(false);
    expect(posts(calls).filter((c) => c.url.includes(B))).toEqual([]);
  });

  it('pending revoke for A, then navigation to B: the result does not change B', async () => {
    const pendingRevoke = deferred<Response>();
    const calls = backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a', { hasActiveCredential: true }));
      if (req.url === `/api/servers/${B}`) return json(200, detail(B, 'server-b', { hasActiveCredential: true }));
      if (req.url === `/api/servers/${A}/agent-credentials/revoke`) return pendingRevoke.promise;
      return undefined;
    });
    renderAt(`/servers/${A}`);
    expect(await screen.findByRole('heading', { name: 'server-a' })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Відкликати ключ' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Відкликати' }));
    await go(`/servers/${B}`);
    expect(await screen.findByRole('heading', { name: 'server-b' })).toBeTruthy();
    const gets = calls.filter((c) => c.url === `/api/servers/${B}`).length;
    await act(async () => { pendingRevoke.resolve(json(200, { serverId: A, revoked: true })); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Відкликати ключ' })).toBeTruthy();
    expect(calls.filter((c) => c.url === `/api/servers/${B}`).length).toBe(gets); // no reload triggered by A's result
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/agent-credentials/revoke`]);
  });

  it('a confirmation dialog of A does not survive the change of id', async () => {
    backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a', { hasActiveCredential: true }));
      if (req.url === `/api/servers/${B}`) return json(200, detail(B, 'server-b', { hasActiveCredential: true }));
      return undefined;
    });
    renderAt(`/servers/${A}`);
    expect(await screen.findByRole('heading', { name: 'server-a' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Відкликати ключ' }));
    expect(await screen.findByRole('dialog', { name: 'Відкликати ключ агента?' })).toBeTruthy();
    await go(`/servers/${B}`);
    expect(await screen.findByRole('heading', { name: 'server-b' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('server-a');
  });

  it('the token dialog of A does not survive the change of id', async () => {
    backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a'));
      if (req.url === `/api/servers/${B}`) return json(200, detail(B, 'server-b'));
      if (req.url === `/api/servers/${A}/agent-credentials`) return json(201, issued(A, TOKEN_A));
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Видати ключ' }));
    expect(await screen.findByRole('dialog', { name: 'Ключ агента видано' })).toBeTruthy();
    await go(`/servers/${B}`);
    expect(await screen.findByRole('heading', { name: 'server-b' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN_A);
    // Going back to A does not bring the token back either.
    await go(`/servers/${A}`);
    expect(await screen.findByRole('heading', { name: 'server-a' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TOKEN_A);
  });

  it('an issue response for another server id is not shown', async () => {
    backend((req) => {
      if (req.url === `/api/servers/${A}`) return json(200, detail(A, 'server-a'));
      if (req.url === `/api/servers/${A}/agent-credentials`) return json(201, issued(B, TOKEN_B));
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Видати ключ' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN_B);
  });

  it('session end with a pending issue and an open token dialog: nothing private is restored', async () => {
    const pendingIssue = deferred<Response>();
    let expired = false;
    backend((req) => {
      if (req.url === '/api/auth/me' && expired) return json(401, {});
      if (req.url === `/api/servers/${A}`) return expired ? json(401, {}) : json(200, detail(A, 'server-a'));
      if (req.url === `/api/servers/${A}/agent-credentials`) return pendingIssue.promise;
      return undefined;
    });
    renderAt(`/servers/${A}`);
    await openA();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Видати ключ' }));
    expired = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
    expect(await screen.findByRole('heading', { name: 'Node Control' })).toBeTruthy();
    await act(async () => { pendingIssue.resolve(json(201, issued(A, TOKEN_A))); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN_A);
    expect(document.body.textContent).not.toContain('server-a');
  });
});
