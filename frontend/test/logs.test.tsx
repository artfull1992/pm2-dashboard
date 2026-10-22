import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import { CSRF, deferred, installFetch, json, type RecordedRequest, session } from './support';

// Bounded log viewing UI (Task 010, ADR-018).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const XSS = '<img src=x onerror="window.__pwned=1">';
const detail = (id: string, name: string) => ({ id, name, isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: new Date().toISOString(), hasActiveCredential: true, snapshot: null });
const app = (id: string) => ({ key: `${id}:pm2:3`, serverId: id, serverName: id === A ? 'alpha' : 'beta', serverStatus: 'online', source: 'pm2', pmId: 3, name: 'api', status: 'online', uptimeSeconds: 100, restarts: 0, cpuPercent: 1, memoryBytes: 1024, execMode: 'fork', firstSeenAt: '2026-10-13T10:00:00.000Z', inventoryState: 'current', capturedAt: null, collectedAt: null });
const apps = (id: string) => ({ serverId: id, serverStatus: 'online', inventory: { state: 'current', reason: null, source: 'pm2', capturedAt: null, collectedAt: null, reportedAt: null, processCount: 1 }, items: [app(id)], freshWindowSeconds: 180 });
const control = (id: string) => ({ serverId: id, enabled: false, serverStatus: 'online', broker: null, targets: [], targetFreshSeconds: 60 });
const logTargets = (id: string, over: Record<string, unknown> = {}) => ({ serverId: id, state: 'supported', reportedAt: new Date().toISOString(), targets: [{ targetKey: 'api', name: 'api', pmId: 3, matchStatus: 'ok' }], ...over });
const stream = (text: string, over: Record<string, unknown> = {}) => ({ state: 'ok', text, lines: text.split('\n').length, truncated: true, sizeBytes: 999, modifiedAt: new Date().toISOString(), ...over });
const done = (id: string, out: string, err = 'err line') => ({
  requestId: REQ, serverId: id, targetKey: 'api', status: 'done', deadlineAt: new Date(Date.now() + 15_000).toISOString(),
  result: { outcome: 'ok', reason: null, readAt: new Date().toISOString(), stdout: stream(out), stderr: stream(err) },
});

let storageWrites: string[];
beforeEach(() => {
  storageWrites = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) { storageWrites.push(key); });
});
afterEach(() => { vi.unstubAllGlobals(); expect(storageWrites).toEqual([]); });

const nav: { current: NavigateFunction | null } = { current: null };
function Probe() { const n = useNavigate(); useEffect(() => { nav.current = n; }, [n]); return null; }
const renderAt = (path: string) => render(<AuthProvider><MemoryRouter initialEntries={[path]}><Probe /><AppRoutes /></MemoryRouter></AuthProvider>);

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'operator' | 'viewer' | 'admin', route: Route = () => undefined, targetsFor: (id: string) => unknown = (id) => logTargets(id)) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    for (const [id, name] of [[A, 'alpha'], [B, 'beta']] as const) {
      if (req.url === `/api/servers/${id}`) return json(200, detail(id, name));
      if (req.url === `/api/servers/${id}/applications`) return json(200, apps(id));
      if (req.url === `/api/servers/${id}/control`) return json(200, control(id));
      if (req.url.startsWith(`/api/servers/${id}/control-commands?`)) return json(200, { items: [] });
      if (req.url === `/api/servers/${id}/log-targets`) return json(200, targetsFor(id));
      if (req.url === `/api/servers/${id}/log-requests`) return json(202, { requestId: REQ, deadlineAt: new Date(Date.now() + 15_000).toISOString() });
    }
    if (req.url === `/api/log-requests/${REQ}`) return json(200, done(A, `first\n${XSS}`));
    return json(404, {});
  });
}
const creates = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/log-requests'));
// The row menu exists once the server page has loaded the server, its inventory and log targets and rendered. The
// first test of this file also pays the worker's cold first render of the whole app (≈250 ms alone, >1 s under a
// parallel suite — measured), which exceeds findBy's 1 s default; the wait itself is for the right state.
const PAGE_READY = { timeout: 5_000 };
async function openLogs() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Дії: api' }, PAGE_READY));
  await user.click(await screen.findByRole('menuitem', { name: 'Переглянути логи' }));
  return { user, dialog: await screen.findByRole('dialog', { name: 'Логи: api' }) };
}

describe('log viewer', () => {
  it('operator opens stdout/stderr from the row menu; text is plain text; CSRF on the request; no control actions shown', async () => {
    const calls = backend('operator');
    renderAt(`/servers/${A}`);
    const { user, dialog } = await openLogs();
    expect(dialog.textContent).toContain('Сервер «alpha», сервіс «api» (api)');
    expect(await within(dialog).findByText(/first/)).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(XSS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(within(dialog).getByText(/старіші рядки не показано/)).toBeTruthy();
    const req = creates(calls)[0];
    expect(req?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ targetKey: 'api' });
    await user.click(within(dialog).getByRole('tab', { name: 'stderr' }));
    expect(within(dialog).getByText('err line')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Оновити' }));
    await waitFor(() => { expect(creates(calls)).toHaveLength(2); });
    expect(calls.some((c) => c.url.includes('/control-commands') && c.method === 'POST')).toBe(false);
  });

  it('auto-refresh: one read every 5 s while open; switching it off stops; closing stops everything', async () => {
    const calls = backend('operator');
    renderAt(`/servers/${A}`);
    const { user, dialog } = await openLogs();
    await within(dialog).findByText(/first/);
    await waitFor(() => { expect(creates(calls)).toHaveLength(2); }, { timeout: 6_500 });
    await user.click(within(dialog).getByRole('checkbox', { name: /Оновлювати кожні 5 с/ }));
    const after = creates(calls).length;
    await new Promise((r) => setTimeout(r, 5_600));
    expect(creates(calls)).toHaveLength(after);
    await user.click(within(dialog).getByRole('button', { name: 'Закрити' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 20_000);

  it('viewer has no logs:read → no actions column at all', async () => {
    backend('viewer');
    renderAt(`/servers/${A}`);
    expect(await screen.findByRole('rowheader', { name: 'api' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Дії:/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Дії' })).toBeNull();
  });

  it.each([
    ['target not allowed', (id: string) => logTargets(id, { targets: [] })],
    ['different PM2 id', (id: string) => logTargets(id, { targets: [{ targetKey: 'api', name: 'api', pmId: 9, matchStatus: 'ok' }] })],
    ['identity mismatch', (id: string) => logTargets(id, { targets: [{ targetKey: 'api', name: 'api', pmId: null, matchStatus: 'fingerprint_mismatch' }] })],
  ])('%s → no logs item; this process\'s cause is in its row menu', async (_n, targets) => {
    backend('operator', undefined, targets);
    renderAt(`/servers/${A}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Чому недоступно: api' }));
    expect(await screen.findByText(/Логи не дозволені allowlist сервера/)).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Переглянути логи' })).toBeNull();
  });

  it.each([
    ['old agent/broker', (id: string) => logTargets(id, { state: 'unsupported', targets: [] }), /Перегляд логів не підтримується: потрібні оновлені Agent і broker/],
    ['agent offline', (id: string) => logTargets(id, { state: 'not_connected', targets: [] }), /Логи: агент не на зв’язку/],
  ])('%s → no logs item; the server-wide cause is said once above the table', async (_n, targets, hint) => {
    backend('operator', undefined, targets);
    renderAt(`/servers/${A}`);
    expect(await screen.findAllByText(hint)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Дії: api' })).toBeNull();
  });

  it('409 is explained; auto-refresh stops; no retry', async () => {
    const calls = backend('operator', (req) => (req.url.endsWith('/log-requests') ? json(409, {}) : undefined));
    renderAt(`/servers/${A}`);
    const { dialog } = await openLogs();
    expect(await within(dialog).findByText(/Перегляд логів недоступний/)).toBeTruthy();
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(creates(calls)).toHaveLength(1);
  });

  it('closing during a request aborts it and the late answer never appears', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', (req) => (req.url === `/api/log-requests/${REQ}` ? slow.promise : undefined));
    renderAt(`/servers/${A}`);
    const { user, dialog } = await openLogs();
    await user.click(within(dialog).getByRole('button', { name: 'Закрити' }));
    const get = calls.find((c) => c.url === `/api/log-requests/${REQ}`);
    expect(get?.signal?.aborted).toBe(true);
    await act(async () => { slow.resolve(json(200, done(A, 'LATE TEXT'))); await Promise.resolve(); });
    expect(screen.queryByText(/LATE TEXT/)).toBeNull();
    expect(document.body.textContent).not.toContain('LATE TEXT');
  });

  it('navigating to another server closes the viewer and drops its text', async () => {
    backend('operator');
    renderAt(`/servers/${A}`);
    const { dialog } = await openLogs();
    await within(dialog).findByText(/first/);
    await act(async () => { await nav.current?.(`/servers/${B}`); });
    expect(await screen.findByRole('heading', { name: 'beta' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('first');
  });

  it('session end while open: viewer gone, text gone', async () => {
    let expired = false;
    backend('operator', (req) => {
      if (req.url === '/api/auth/me' && expired) return json(401, {});
      if (req.url.endsWith('/log-requests') && expired) return json(401, {});
      return undefined;
    });
    renderAt(`/servers/${A}`);
    const { user, dialog } = await openLogs();
    await within(dialog).findByText(/first/);
    expired = true;
    await user.click(within(dialog).getByRole('button', { name: 'Оновити' }));
    expect(await screen.findByRole('heading', { name: 'Node Control' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('first');
  });
});
