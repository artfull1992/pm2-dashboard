import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { useAuth } from '../src/auth/AuthContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { deferred, installFetch, json, type RecordedRequest, session } from './support';

// Applications: one expandable panel (overview / inline logs / target history), lazy tabs, the same actions; and the
// server-side name search (debounced, in the URL). Synthetic API only.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CMD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NAME = { [A]: 'alpha', [B]: 'beta' } as const;

// The same process name AND the same PM2 id on two servers; their target keys differ.
const app = (serverId: string, over: Record<string, unknown> = {}) => ({
  key: `${serverId}:pm2:3`, serverId, serverName: NAME[serverId as keyof typeof NAME], serverStatus: 'online', source: 'pm2', pmId: 3, name: 'api',
  status: 'online', uptimeSeconds: 100, restarts: 0, cpuPercent: 1, memoryBytes: 1024, execMode: 'fork', firstSeenAt: '2026-10-13T10:00:00.000Z',
  inventoryState: 'current', capturedAt: null, collectedAt: '2026-10-13T12:00:01.000Z', ...over,
});
const keyOf = (id: string) => (id === A ? 'api-alpha' : 'api-beta');
const target = (id: string, over: Record<string, unknown> = {}) => ({ targetKey: keyOf(id), name: 'api', pmId: 3, actions: ['restart', 'stop', 'start'], matchStatus: 'ok', ...over });
const control = (id: string, over: Record<string, unknown> = {}) => ({
  serverId: id, enabled: true, serverStatus: 'online', broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: new Date().toISOString(), fresh: true },
  targets: [target(id)], targetFreshSeconds: 60, ...over,
});
const logTargets = (id: string, over: Record<string, unknown> = {}) => ({ serverId: id, state: 'supported', reportedAt: new Date().toISOString(), targets: [{ targetKey: keyOf(id), name: 'api', pmId: 3, matchStatus: 'ok' }], ...over });
const command = (serverId: string, over: Record<string, unknown> = {}) => ({
  id: CMD, serverId, targetKey: keyOf(serverId), action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
  requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0,
  before: null, after: null, ...over,
});
const serverPage = { items: [A, B].map((id) => ({ id, name: NAME[id as keyof typeof NAME], isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: new Date().toISOString(), hasActiveCredential: true })), nextAfterId: null, onlineWindowSeconds: 90 };

afterEach(() => { vi.unstubAllGlobals(); history = () => []; });

const nav: { current: NavigateFunction | null; logout: (() => Promise<unknown>) | null; search: string } = { current: null, logout: null, search: '' };
function Probe() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useAuth();
  useEffect(() => { nav.current = navigate; nav.logout = logout; nav.search = location.search; }, [navigate, logout, location.search]);
  return null;
}
const renderAt = (path = '/applications') => render(<AuthProvider><MemoryRouter initialEntries={[path]}><Probe /><AppRoutes /></MemoryRouter></AuthProvider>);

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
interface Opts {
  permissions?: string[];
  route?: Route;
  items?: (filter: URLSearchParams) => unknown[];
  controlFor?: (id: string) => unknown;
  logsFor?: (id: string) => unknown;
}
let history: (serverId: string, targetKey: string) => unknown[] = () => [];
function backend(role: 'operator' | 'viewer' | 'admin', { permissions, route = () => undefined, items = () => [app(A), app(B)], controlFor = (id) => control(id), logsFor = (id) => logTargets(id) }: Opts = {}) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, permissions ? { ...session(role), permissions } : session(role));
    if (req.url === '/api/auth/logout') return new Response(null, { status: 204 });
    if (req.url.startsWith('/api/servers?')) return json(200, serverPage);
    if (req.url.startsWith('/api/applications?')) return json(200, { items: items(new URL(req.url, 'http://x').searchParams), nextCursor: null, freshWindowSeconds: 180 });
    for (const id of [A, B]) {
      if (req.url === `/api/servers/${id}/control`) return json(200, controlFor(id));
      if (req.url === `/api/servers/${id}/log-targets`) return json(200, logsFor(id));
      if (req.method === 'POST' && req.url === `/api/servers/${id}/control-commands`) return json(201, command(id));
      if (req.method === 'POST' && req.url === `/api/servers/${id}/log-requests`) return json(202, { requestId: REQ, deadlineAt: new Date(Date.now() + 15_000).toISOString() });
    }
    const hist = /^\/api\/servers\/([^/]+)\/control-commands\?limit=10&targetKey=([a-z0-9._-]+)$/.exec(req.url);
    if (hist) return json(200, { items: history(hist[1] ?? '', hist[2] ?? '') });
    if (req.url === `/api/control-commands/${CMD}`) return json(200, command(A));
    if (req.url === `/api/log-requests/${REQ}`) return json(200, { requestId: REQ, serverId: B, targetKey: 'api-beta', status: 'done', deadlineAt: new Date().toISOString(), result: { outcome: 'ok', reason: null, readAt: new Date().toISOString(), stdout: { state: 'ok', text: 'beta line', lines: 1, truncated: false, sizeBytes: 9, modifiedAt: null }, stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null } } });
    return json(404, {});
  });
}
const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.includes('/control-commands'));
const capReads = (calls: RecordedRequest[]) => calls.filter((c) => /\/api\/servers\/[^/]+\/(control|log-targets)$/.test(c.url)).map((c) => c.url.replace('/api/servers/', '').replace(A, 'A').replace(B, 'B'));
const menuOf = (server: 'alpha' | 'beta') => screen.findByRole('button', { name: `Дії: api на ${server}` });

const toggle = (server: 'alpha' | 'beta', open = false) => screen.findByRole('button', { name: `${open ? 'Згорнути' : 'Розгорнути'} деталі: api на ${server}` });
const panelOf = (server: 'alpha' | 'beta') => screen.findByRole('region', { name: `Деталі: api на ${server}` });
const logReads = (calls: RecordedRequest[]) => calls.filter((c) => c.url.includes('/log-requests'));
const historyReads = (calls: RecordedRequest[]) => calls.filter((c) => c.url.includes('targetKey='));
const apps = (calls: RecordedRequest[]) => calls.filter((c) => c.url.startsWith('/api/applications?')).map((c) => new URL(c.url, 'http://x').searchParams);

describe('expandable application panel', () => {
  it('collapsed by default; one panel at a time; the same toggle collapses; aria wiring; the table row stays one row', async () => {
    backend('operator');
    renderAt();
    const user = userEvent.setup();
    const a = await toggle('alpha');
    expect(a.getAttribute('aria-expanded')).toBe('false');
    expect(a.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByRole('region', { name: /^Деталі:/ })).toBeNull();
    await user.click(a);
    const panel = await panelOf('alpha');
    expect(a.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(a.getAttribute('aria-controls') ?? '')?.contains(panel)).toBe(true);
    expect(panel.closest('td')?.colSpan).toBe(screen.getAllByRole('columnheader').length); // spans the whole table
    await user.click(await toggle('beta'));
    await panelOf('beta');
    expect(screen.queryByRole('region', { name: 'Деталі: api на alpha' })).toBeNull();
    expect(screen.getAllByRole('region', { name: /^Деталі:/ })).toHaveLength(1);
    await user.click(await toggle('beta', true));
    expect(screen.queryByRole('region', { name: /^Деталі:/ })).toBeNull();
  });

  it('overview is the default and reads nothing extra: no log read, no history; the menu still works independently', async () => {
    const calls = backend('operator');
    renderAt();
    const user = userEvent.setup();
    await user.click(await toggle('alpha'));
    const panel = await panelOf('alpha');
    expect(within(panel).getByRole('tab', { name: 'Огляд' }).getAttribute('aria-selected')).toBe('true');
    expect(within(panel).getByText('PM2 id')).toBeTruthy();
    expect(await within(panel).findByText(/Доступно: Запустити, Зупинити, Перезапустити/)).toBeTruthy();
    expect(logReads(calls)).toEqual([]);
    expect(historyReads(calls)).toEqual([]);
    await user.click(await menuOf('beta')); // the other row's menu is independent of the panel
    expect(await screen.findByRole('menuitem', { name: 'Перезапустити' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: /^Деталі:/ })).toHaveLength(1);
  });

  it('history: one request for the confirmed target of that server (filtered by the API); scope is stated; reloads after a command', async () => {
    history = (serverId, key) => (serverId === A && key === 'api-alpha' ? [command(A, { status: 'succeeded', after: { status: 'online' }, completedAt: new Date().toISOString() })] : []);
    const calls = backend('operator');
    renderAt();
    const user = userEvent.setup();
    await user.click(await toggle('alpha'));
    const panel = await panelOf('alpha');
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(await within(panel).findByText(/Виконано й підтверджено/)).toBeTruthy();
    expect(within(panel).getByText(/Команди цілі «api-alpha» з allowlist цього сервера/)).toBeTruthy();
    expect(historyReads(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/control-commands?limit=10&targetKey=api-alpha`]);
    // A command from the panel: the same confirmation and POST; the history reloads after it was accepted.
    await user.click(within(panel).getByRole('button', { name: 'Перезапустити' }));
    const dialog = await screen.findByRole('dialog', { name: 'Перезапустити процес?' });
    expect(dialog.textContent).toContain('«api» (api-alpha) на сервері «alpha»');
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    expect(posts(calls)[0]?.url).toBe(`/api/servers/${A}/control-commands`);
    expect(JSON.parse(posts(calls)[0]?.body ?? '{}')).toMatchObject({ targetKey: 'api-alpha', action: 'restart' });
    await waitFor(() => { expect(historyReads(calls).length).toBeGreaterThanOrEqual(2); });
  });

  it('history: no confirmed target → explained, nothing requested (not shown as an empty history); empty history is its own message', async () => {
    const calls = backend('operator', { controlFor: (id) => control(id, { targets: id === A ? [] : [target(id)] }) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await toggle('alpha'));
    let panel = await panelOf('alpha');
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(await within(panel).findByText(/немає підтвердженої цілі керування.*Це не означає, що команд не було/)).toBeTruthy();
    expect(historyReads(calls)).toEqual([]);
    await user.click(await toggle('beta'));
    panel = await panelOf('beta');
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(await within(panel).findByText('Команд для цієї цілі ще не було.')).toBeTruthy();
    expect(historyReads(calls).map((c) => c.url)).toEqual([`/api/servers/${B}/control-commands?limit=10&targetKey=api-beta`]);
  });

  it('logs load only on the Logs tab; switching away aborts the read; keyboard moves between tabs', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', { route: (req) => (req.url.endsWith('/log-requests') && req.method === 'POST' ? slow.promise : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await toggle('beta'));
    const panel = await panelOf('beta');
    within(panel).getByRole('tab', { name: 'Огляд' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(within(panel).getByRole('tab', { name: 'Логи' }));
    expect(within(panel).getByRole('tab', { name: 'Логи' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => { expect(logReads(calls)).toHaveLength(1); });
    expect(logReads(calls)[0]?.url).toBe(`/api/servers/${B}/log-requests`);
    await user.keyboard('{ArrowRight}');
    expect(within(panel).getByRole('tab', { name: 'Історія дій' }).getAttribute('aria-selected')).toBe('true');
    expect(logReads(calls)[0]?.signal?.aborted).toBe(true);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(within(panel).getByRole('tab', { name: 'Огляд' }));
  });

  it('polling refreshes keep the panel, its tab and focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = backend('operator');
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      await user.click(await toggle('alpha'));
      const panel = await panelOf('alpha');
      await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
      const tab = within(panel).getByRole('tab', { name: 'Історія дій' });
      const before = apps(calls).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(apps(calls).length).toBeGreaterThan(before);
      expect(screen.getByRole('region', { name: 'Деталі: api на alpha' })).toBe(panel);
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tab);
      expect(historyReads(calls)).toHaveLength(1); // no history polling
    } finally {
      vi.useRealTimers();
    }
  });

  it('a filter change closes the panel and aborts its open read; a vanished or renamed row closes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let rows = [app(A), app(B)];
      const slow = deferred<Response>();
      const calls = backend('operator', { items: (q) => (q.get('serverId') === B ? [app(B)] : rows), route: (req) => (req.url.includes('targetKey=') ? slow.promise : undefined) });
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      await user.click(await toggle('alpha'));
      let panel = await panelOf('alpha');
      await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
      await waitFor(() => { expect(historyReads(calls)).toHaveLength(1); });
      await act(async () => { await nav.current?.(`/applications?serverId=${B}`); });
      await waitFor(() => { expect(screen.queryByRole('region', { name: /^Деталі:/ })).toBeNull(); });
      expect(historyReads(calls)[0]?.signal?.aborted).toBe(true);
      await act(async () => { slow.resolve(json(200, { items: [] })); await Promise.resolve(); });
      expect(screen.queryByRole('region', { name: /^Деталі:/ })).toBeNull();
      // Back to all servers: the same row identity renamed on the next poll → closed (never shows another process).
      await act(async () => { await nav.current?.('/applications'); });
      await user.click(await toggle('alpha'));
      panel = await panelOf('alpha');
      rows = [app(A, { name: 'api-renamed' }), app(B)];
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
      await waitFor(() => { expect(screen.queryByRole('region', { name: /^Деталі:/ })).toBeNull(); });
      await user.click(await toggle('beta'));
      await panelOf('beta');
      rows = [app(A, { name: 'api-renamed' })];
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
      await waitFor(() => { expect(screen.queryByRole('region', { name: /^Деталі:/ })).toBeNull(); });
    } finally {
      vi.useRealTimers();
    }
  });

  it('viewer: overview only; logs and history explain why, and nothing is requested', async () => {
    const calls = backend('viewer');
    renderAt();
    const user = userEvent.setup();
    await user.click(await toggle('alpha'));
    const panel = await panelOf('alpha');
    expect(within(panel).getByText('Немає права керування процесами.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Запустити|Зупинити|Перезапустити/ })).toBeNull();
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    expect(within(panel).getByText('Немає права на перегляд логів.')).toBeTruthy();
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(within(panel).getByText(/доступна користувачам із правом керування/)).toBeTruthy();
    expect(logReads(calls)).toEqual([]);
    expect(historyReads(calls)).toEqual([]);
    expect(capReads(calls)).toEqual([]);
  });

  it('a command started from the panel keeps being tracked after the panel is collapsed', async () => {
    let status = 'queued';
    backend('operator', { route: (req) => (req.url === `/api/control-commands/${CMD}` ? json(200, command(A, { status, ...(status === 'succeeded' ? { after: { status: 'online' }, completedAt: new Date().toISOString() } : {}) })) : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await toggle('alpha'));
    const panel = await panelOf('alpha');
    await user.click(await within(panel).findByRole('button', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    expect(await screen.findByText(/«api-alpha» на сервері «alpha»: У черзі/)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Згорнути' }));
    status = 'succeeded';
    expect(await screen.findByText(/«api-alpha» на сервері «alpha»: Виконано й підтверджено/, undefined, { timeout: 4000 })).toBeTruthy();
  });
});

describe('name search', () => {
  it('debounced: one request after typing stops; q in the URL; cursor reset; clear; Back restores the box', async () => {
    const calls = backend('operator', { items: (q) => (q.get('q') ? [app(B)] : [app(A), app(B)]) });
    renderAt('/applications?cursor=abc');
    const user = userEvent.setup();
    const box = await screen.findByLabelText('Пошук за назвою');
    await screen.findByRole('button', { name: 'Розгорнути деталі: api на alpha' });
    const before = apps(calls).length;
    await user.type(box, 'API');
    expect(apps(calls).length).toBe(before); // nothing per keystroke
    await waitFor(() => { expect(nav.search).toBe('?q=API'); }, { timeout: 2000 });
    await waitFor(() => { expect(apps(calls).at(-1)?.get('q')).toBe('API'); });
    expect(apps(calls).slice(before).filter((p) => p.get('q') !== null)).toHaveLength(1);
    expect(apps(calls).at(-1)?.get('cursor')).toBeNull();
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Розгорнути деталі: api на alpha' })).toBeNull(); });
    await user.click(screen.getByRole('button', { name: 'Очистити' }));
    await waitFor(() => { expect(nav.search).toBe(''); });
    expect((box as HTMLInputElement).value).toBe('');
    await act(async () => { await nav.current?.(-1); });
    await waitFor(() => { expect(nav.search).toBe('?q=API'); });
    expect((box as HTMLInputElement).value).toBe('API');
  });

  it('a late answer of an older search never replaces the current one; empty result explains the search', async () => {
    const slow = deferred<Response>();
    backend('operator', {
      route: (req) => (req.url.includes('q=old') ? slow.promise : undefined),
      items: (q) => (q.get('q') === 'none' ? [] : [app(A)]),
    });
    renderAt('/applications?q=old');
    const user = userEvent.setup();
    const box = await screen.findByLabelText('Пошук за назвою');
    expect((box as HTMLInputElement).value).toBe('old');
    await user.clear(box);
    await user.type(box, 'none');
    await waitFor(() => { expect(nav.search).toBe('?q=none'); }, { timeout: 2000 });
    expect(await screen.findByText('Немає застосунків, у назві яких є «none».')).toBeTruthy();
    await act(async () => { slow.resolve(json(200, { items: [app(A), app(B)], nextCursor: null, freshWindowSeconds: 180 })); await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: /^Розгорнути деталі/ })).toBeNull();
  });
});
