import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { useAuth } from '../src/auth/AuthContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { CSRF, deferred, installFetch, json, type RecordedRequest, session } from './support';

// Process actions in the all-applications list: same rules as the server page, addressed by serverId + confirmed
// targetKey, capabilities loaded lazily per server (no polling per row).

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

afterEach(() => { vi.unstubAllGlobals(); });

const nav: { current: NavigateFunction | null; logout: (() => Promise<unknown>) | null } = { current: null, logout: null };
function Probe() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  useEffect(() => { nav.current = navigate; nav.logout = logout; }, [navigate, logout]);
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
    if (req.url === `/api/control-commands/${CMD}`) return json(200, command(A));
    if (req.url === `/api/log-requests/${REQ}`) return json(200, { requestId: REQ, serverId: B, targetKey: 'api-beta', status: 'done', deadlineAt: new Date().toISOString(), result: { outcome: 'ok', reason: null, readAt: new Date().toISOString(), stdout: { state: 'ok', text: 'beta line', lines: 1, truncated: false, sizeBytes: 9, modifiedAt: null }, stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null } } });
    return json(404, {});
  });
}
const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.includes('/control-commands'));
const capReads = (calls: RecordedRequest[]) => calls.filter((c) => /\/api\/servers\/[^/]+\/(control|log-targets)$/.test(c.url)).map((c) => c.url.replace('/api/servers/', '').replace(A, 'A').replace(B, 'B'));
const menuOf = (server: 'alpha' | 'beta') => screen.findByRole('button', { name: `Дії: api на ${server}` });

describe('applications list: row actions', () => {
  it('viewer: no "Дії" column, no capability requests', async () => {
    const calls = backend('viewer');
    renderAt();
    await screen.findAllByText('api');
    expect(screen.queryByRole('columnheader', { name: 'Дії' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Дії:/ })).toBeNull();
    expect(capReads(calls)).toEqual([]);
  });

  it('operator: capabilities are loaded only when a menu opens, once per server (cached), never polled per row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = backend('operator');
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      expect(await screen.findByText('PM2-процеси всіх серверів.')).toBeTruthy();
      await menuOf('alpha');
      expect(capReads(calls)).toEqual([]);
      await user.click(await menuOf('alpha'));
      expect(await screen.findByRole('menuitem', { name: 'Перезапустити' })).toBeTruthy();
      expect(capReads(calls).sort()).toEqual(['A/control', 'A/log-targets']);
      // Same order and names as on the server page; "Зупинити" has the danger style.
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Запустити', 'Зупинити', 'Перезапустити', 'Переглянути логи']);
      expect(screen.getByRole('menuitem', { name: 'Зупинити' }).className).toContain('action-menu__item--danger');
      await user.keyboard('{Escape}');
      await user.click(await menuOf('alpha'));
      await screen.findByRole('menuitem', { name: 'Перезапустити' });
      expect(capReads(calls)).toHaveLength(2); // reused within the cache window
      await user.keyboard('{Escape}');
      // Polling of the list (several intervals) does not load capabilities of any server.
      await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
      expect(capReads(calls)).toHaveLength(2);
      expect(calls.filter((c) => c.url.startsWith('/api/applications?')).length).toBeGreaterThan(2);
      await user.click(await menuOf('beta'));
      await screen.findByRole('menuitem', { name: 'Перезапустити' });
      expect(capReads(calls).filter((u) => u.startsWith('B/')).sort()).toEqual(['B/control', 'B/log-targets']);
      expect(posts(calls)).toEqual([]); // opening menus sends no command
    } finally {
      vi.useRealTimers();
    }
  });

  it('concurrent openings of the same server share one load (dedup)', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', { items: () => [app(A), app(A, { key: `${A}:pm2:4`, pmId: 4, name: 'worker' })], route: (req) => (req.url === `/api/servers/${A}/control` ? slow.promise : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Дії: api на alpha' }));
    expect(screen.getByText('Завантаження…')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Дії: worker на alpha' }));
    expect(capReads(calls).filter((u) => u === 'A/control')).toHaveLength(1);
    await act(async () => { slow.resolve(json(200, control(A))); await Promise.resolve(); });
    expect(await screen.findByText(/Не дозволено керування/)).toBeTruthy(); // worker is not allowlisted
    expect(capReads(calls).filter((u) => u === 'A/control')).toHaveLength(1);
  });

  it('same name and PM2 id on two servers: confirmation names app, server and operation; one POST to the right server with its targetKey, CSRF and idempotency key', async () => {
    const calls = backend('operator');
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('beta'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    let dialog = await screen.findByRole('dialog', { name: 'Перезапустити процес?' });
    expect(dialog.textContent).toContain('Підтвердьте перезапуск процесу «api» (api-beta) на сервері «beta».');
    await user.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    expect(posts(calls)).toEqual([]);
    expect(document.activeElement).toBe(await menuOf('beta')); // focus back on the row trigger
    await user.click(await menuOf('beta'));
    await user.click(await screen.findByRole('menuitem', { name: 'Зупинити' }));
    dialog = await screen.findByRole('dialog', { name: 'Зупинити процес?' });
    expect(within(dialog).getByRole('button', { name: 'Зупинити' }).className).toContain('button--danger');
    await user.click(within(dialog).getByRole('button', { name: 'Зупинити' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    const req = posts(calls)[0];
    expect(req?.url).toBe(`/api/servers/${B}/control-commands`);
    expect(req?.headers.get('x-csrf-token')).toBe(CSRF);
    const body = JSON.parse(req?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['action', 'idempotencyKey', 'targetKey']);
    expect(body).toMatchObject({ targetKey: 'api-beta', action: 'stop' });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // Capabilities were re-checked right before the POST (a fresh control read after the menu's one).
    const beforePost = calls.slice(0, calls.indexOf(req as RecordedRequest));
    expect(beforePost.filter((c) => c.url === `/api/servers/${B}/control`)).toHaveLength(2);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes(A))).toBe(false);
  });

  it('lifecycle: accepted is shown as queued, success only after the confirmed status; the row of that target is locked, the other server stays usable', async () => {
    let status = 'queued';
    const calls = backend('operator', { route: (req) => (req.url === `/api/control-commands/${CMD}` ? json(200, command(A, { status, ...(status === 'succeeded' ? { after: { status: 'online' }, completedAt: new Date().toISOString() } : {}) })) : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    expect(await screen.findByText('Перезапустити «api-alpha» на сервері «alpha»: У черзі — очікує агента.')).toBeTruthy();
    expect(screen.queryByText(/Виконано/)).toBeNull();
    await user.click(await menuOf('alpha'));
    expect((await screen.findByRole('menuitem', { name: 'Перезапустити' })).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Команда для цього процесу ще виконується/)).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(await menuOf('beta'));
    expect((await screen.findByRole('menuitem', { name: 'Перезапустити' })).getAttribute('aria-disabled')).toBeNull();
    await user.keyboard('{Escape}');
    status = 'succeeded';
    expect(await screen.findByText(/alpha»: Виконано й підтверджено \(стан після: online\)/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(posts(calls)).toHaveLength(1);
  });

  it('unknown result is explained honestly', async () => {
    backend('operator', { route: (req) => (req.url === `/api/control-commands/${CMD}` ? json(200, command(A, { status: 'unknown', reason: 'timeout', completedAt: new Date().toISOString() })) : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    expect(await screen.findByText(/Результат невідомий .*дія могла виконатися/, undefined, { timeout: 4000 })).toBeTruthy();
  });

  it('a lost response is never retried automatically; an explicit retry reuses the same idempotency key', async () => {
    let down = true;
    const calls = backend('operator', { route: (req) => (req.method === 'POST' && req.url === `/api/servers/${A}/control-commands` && down ? json(503, {}) : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    expect(await within(dialog).findByText(/команда могла бути створена/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(calls)).toHaveLength(1);
    down = false;
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    const keys = posts(calls).map((c) => (JSON.parse(c.body ?? '{}') as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('capabilities changed between opening and confirming (fingerprint mismatch): nothing is sent', async () => {
    let mismatch = false;
    const calls = backend('operator', { controlFor: (id) => control(id, mismatch ? { targets: [target(id, { matchStatus: 'fingerprint_mismatch' })] } : {}) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    const dialog = await screen.findByRole('dialog');
    mismatch = true;
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/змінився — дію не надіслано/);
    expect(posts(calls)).toEqual([]);
  });

  it.each([
    ['server offline (row)', { items: () => [app(A, { serverStatus: 'offline' })] }, /Потрібні актуальні дані/],
    ['stale inventory', { items: () => [app(A, { inventoryState: 'stale' })] }, /Потрібні актуальні дані/],
    ['control disabled in the API', { controlFor: (id: string) => control(id, { enabled: false }) }, /Керування зараз недоступне/],
    ['broker report stale', { controlFor: (id: string) => control(id, { broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: new Date().toISOString(), fresh: false } }) }, /Керування зараз недоступне/],
    ['fingerprint mismatch', { controlFor: (id: string) => control(id, { targets: [target(id, { matchStatus: 'fingerprint_mismatch' })] }) }, /fingerprint/],
  ] as [string, Opts, RegExp][])('%s → control items disabled with the reason, no POST', async (_n, opts, reason) => {
    const calls = backend('operator', { ...opts, logsFor: (id) => logTargets(id, { state: 'not_connected', targets: [] }) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    expect(await screen.findByText(reason)).toBeTruthy();
    for (const m of screen.getAllByRole('menuitem')) expect(m.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Логи: агент не на зв’язку/)).toBeTruthy();
    await user.click(screen.getAllByRole('menuitem')[0] as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it.each([
    ['not allowlisted', []],
    ['another PM2 id under the same name', [{ targetKey: 'api-alpha', name: 'api', pmId: 9, actions: ['restart'], matchStatus: 'ok' }]],
    ['ambiguous mapping', [{ targetKey: 'one', name: 'api', pmId: 3, actions: ['restart'], matchStatus: 'ok' }, { targetKey: 'two', name: 'api', pmId: 3, actions: ['restart'], matchStatus: 'ok' }]],
  ])('%s → no control items at all, only the reason', async (_n, targets) => {
    backend('operator', { controlFor: (id) => control(id, { targets }), logsFor: (id) => logTargets(id, { targets: [] }) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    expect(await screen.findByText(/Не дозволено керування|Ідентичність процесу не підтверджена/)).toBeTruthy();
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('control and logs permissions are independent', async () => {
    const onlyLogs = backend('viewer', { permissions: ['monitoring:read', 'logs:read'] });
    const view = renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await screen.findByRole('menuitem', { name: 'Переглянути логи' });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Переглянути логи']);
    expect(capReads(onlyLogs)).toEqual(['A/log-targets']);
    view.unmount();
    vi.unstubAllGlobals();
    const onlyControl = backend('viewer', { permissions: ['monitoring:read', 'processes:control'] });
    renderAt();
    await user.click(await menuOf('alpha'));
    await screen.findByRole('menuitem', { name: 'Перезапустити' });
    expect(screen.queryByRole('menuitem', { name: 'Переглянути логи' })).toBeNull();
    expect(capReads(onlyControl)).toEqual(['A/control']);
  });

  it('logs open in the protected viewer for the row’s server and target', async () => {
    const calls = backend('operator');
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('beta'));
    await user.click(await screen.findByRole('menuitem', { name: 'Переглянути логи' }));
    const dialog = await screen.findByRole('dialog', { name: 'Логи: api' });
    expect(await within(dialog).findByText('beta line')).toBeTruthy();
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/log-requests'));
    expect(create?.url).toBe(`/api/servers/${B}/log-requests`);
    expect(JSON.parse(create?.body ?? '{}')).toEqual({ targetKey: 'api-beta' });
    expect(create?.headers.get('x-csrf-token')).toBe(CSRF);
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(document.activeElement).toBe(await menuOf('beta'));
  });

  it('filter change while capabilities load: the old row and its menu are gone, the late answer shows nothing', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', {
      items: (q) => (q.get('serverId') === B ? [app(B)] : [app(A), app(B)]),
      route: (req) => (req.url === `/api/servers/${A}/control` ? slow.promise : undefined),
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await act(async () => { await nav.current?.(`/applications?serverId=${B}`); });
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Дії: api на alpha' })).toBeNull(); });
    expect(document.querySelector('.action-menu__popup')).toBeNull();
    expect(calls.find((c) => c.url === `/api/servers/${A}/control`)?.signal?.aborted).toBe(true);
    await act(async () => { slow.resolve(json(200, control(A))); await Promise.resolve(); });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it('a filter change while a POST is pending keeps it addressed to the confirmed target; its status names that server', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', {
      items: (q) => (q.get('serverId') === B ? [app(B)] : [app(A), app(B)]),
      route: (req) => (req.method === 'POST' && req.url === `/api/servers/${A}/control-commands` ? slow.promise : undefined),
    });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    await act(async () => { await nav.current?.(`/applications?serverId=${B}`); });
    await act(async () => { slow.resolve(json(201, command(A))); await Promise.resolve(); });
    expect(await screen.findByText('Перезапустити «api-alpha» на сервері «alpha»: У черзі — очікує агента.')).toBeTruthy();
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/control-commands`]);
  });

  it('logout while a POST is pending: the late answer of the old session changes nothing', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', { route: (req) => (req.method === 'POST' && req.url === `/api/servers/${A}/control-commands` ? slow.promise : undefined) });
    renderAt();
    const user = userEvent.setup();
    await user.click(await menuOf('alpha'));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    await act(async () => { await nav.logout?.(); });
    expect(await screen.findByRole('heading', { name: 'GOIT Node Control' })).toBeTruthy();
    expect(posts(calls)[0]?.signal?.aborted).toBe(true);
    await act(async () => { slow.resolve(json(201, command(A))); await Promise.resolve(); });
    expect(screen.queryByText(/У черзі/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
