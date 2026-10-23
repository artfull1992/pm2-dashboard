import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import { deferred, installFetch, json, type RecordedRequest, renderApp, session } from './support';

// Read-only PM2 inventory UI (Task 008, ADR-016).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const XSS = '<img src=x onerror="window.__pwned=1">';

const app = (serverId: string, name: string, overrides: Record<string, unknown> = {}) => ({
  key: `${serverId}:pm2:0`, serverId, serverName: serverId === A ? 'alpha' : 'beta', serverStatus: 'online', source: 'pm2', pmId: 0, name,
  status: 'online', uptimeSeconds: 90_061, restarts: 2, cpuPercent: 12.5, memoryBytes: 150 * 1024 ** 2, execMode: 'fork',
  firstSeenAt: '2026-10-13T10:00:00.000Z', inventoryState: 'current', capturedAt: '2026-10-13T12:00:00.000Z', collectedAt: '2026-10-13T12:00:01.000Z',
  ...overrides,
});
const page = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor, freshWindowSeconds: 180 });
const serverPage = { items: [
  { id: A, name: 'alpha', isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: '2026-10-13T12:00:00.000Z', hasActiveCredential: true },
  { id: B, name: 'beta', isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'offline', lastSeenAt: '2026-10-13T10:00:00.000Z', hasActiveCredential: true },
], nextAfterId: null, onlineWindowSeconds: 90 };
const inventory = (overrides: Record<string, unknown> = {}) => ({
  state: 'current', reason: null, source: 'pm2', capturedAt: '2026-10-13T12:00:00.000Z', collectedAt: '2026-10-13T12:00:01.000Z',
  reportedAt: '2026-10-13T12:00:01.000Z', processCount: 1, ...overrides,
});
const serverDetail = (id: string, name: string) => ({
  id, name, isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: '2026-10-13T12:00:00.000Z', hasActiveCredential: true, snapshot: null,
});

afterEach(() => { vi.unstubAllGlobals(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route, role: 'admin' | 'viewer' = 'viewer') {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url.startsWith('/api/servers?')) return json(200, serverPage);
    return json(404, {});
  });
}

const nav: { current: NavigateFunction | null; search: string } = { current: null, search: '' };
function Probe() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => { nav.current = navigate; nav.search = location.search; }, [navigate, location.search]);
  return null;
}
function renderAt(path: string) {
  return render(<AuthProvider><MemoryRouter initialEntries={[path]}><Probe /><AppRoutes /></MemoryRouter></AuthProvider>);
}
const go = async (path: string) => { await act(async () => { await nav.current?.(path); }); };

describe('applications page', () => {
  it('shows validated processes with freshness; names render as text; no control buttons', async () => {
    backend((req) => req.url.startsWith('/api/applications?') ? json(200, page([
      app(A, XSS),
      app(B, 'worker', { key: `${B}:pm2:1`, pmId: 1, serverStatus: 'offline', status: 'stopped', uptimeSeconds: null, cpuPercent: null, memoryBytes: null, execMode: null }),
      app(A, 'old', { key: `${A}:pm2:2`, pmId: 2, inventoryState: 'stale' }),
      app(A, 'down', { key: `${A}:pm2:3`, pmId: 3, inventoryState: 'unavailable' }),
    ])) : undefined);
    renderApp('/applications');
    const table = await screen.findByRole('list', { name: 'PM2-процеси' });
    expect(within(table).getByText(XSS)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(within(table).getAllByText('1 д 1 год').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('12.5 %').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('150 МіБ').length).toBeGreaterThan(0);
    expect(within(table).getByText(/⚠ сервер офлайн/)).toBeTruthy();
    expect(within(table).getByText(/⚠ дані застарілі/)).toBeTruthy();
    expect(within(table).getByText(/⚠ exporter недоступний/)).toBeTruthy();
    expect(within(table).getAllByText('—').length).toBeGreaterThanOrEqual(3); // unknown metrics are not 0
    expect(screen.getByText('неактуальні дані: 3')).toBeTruthy();
    expect(screen.getByText('На цій сторінці: 4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(restart|stop|start|перезапустити|зупинити|запустити|видалити)$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Дії:/ })).toBeNull();
  });

  it('empty, filtered-empty, error (503 with retry), 403 and 401 states', async () => {
    let mode: 'empty' | 'error' = 'empty';
    backend((req) => req.url.startsWith('/api/applications?') ? (mode === 'empty' ? json(200, page([])) : json(503, {}, { 'retry-after': '7' })) : undefined);
    const view = renderApp('/applications');
    expect(await screen.findByRole('heading', { name: 'Ще немає даних про процеси' })).toBeTruthy();
    view.unmount();
    renderAt('/applications?status=errored');
    expect(await screen.findByRole('heading', { name: 'Нічого не знайдено' })).toBeTruthy();
    mode = 'error';
    await go('/applications?status=stopped');
    expect(await screen.findByText(/Сервіс тимчасово недоступний/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /спробувати/i })).toBeTruthy();
  });

  it('403 → forbidden view; 401 → session ends', async () => {
    backend((req) => req.url.startsWith('/api/applications?') ? json(403, {}) : undefined);
    renderApp('/applications');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    vi.unstubAllGlobals();
    let expired = false;
    backend((req) => {
      if (req.url === '/api/auth/me' && expired) return json(401, {});
      if (req.url.startsWith('/api/applications?')) { expired = true; return json(401, {}); }
      return undefined;
    });
    renderApp('/applications');
    expect(await screen.findByRole('heading', { name: 'Node Control' })).toBeTruthy();
  });

  it('filters live in the URL, reset the cursor and never show rows of the previous filter while loading', async () => {
    const slow = deferred<Response>();
    const calls = backend((req) => {
      if (!req.url.startsWith('/api/applications?')) return undefined;
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.get('serverId') === B) return slow.promise;
      if (q.get('cursor') === 'CUR2') return json(200, page([app(A, 'second-page', { key: `${A}:pm2:9`, pmId: 9 })]));
      return json(200, page([app(A, 'first-page')], 'CUR2'));
    });
    renderAt('/applications');
    expect(await screen.findByText('first-page')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Наступна сторінка' }));
    expect(await screen.findByText('second-page')).toBeTruthy();
    expect(nav.search).toContain('cursor=CUR2');
    await user.selectOptions(screen.getByLabelText('Сервер'), B);
    await waitFor(() => { expect(nav.search).toBe(`?serverId=${B}`); });
    expect(screen.queryByText('second-page')).toBeNull();
    expect(screen.queryByText('first-page')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Завантаження');
    await act(async () => { slow.resolve(json(200, page([app(B, 'beta-app')]))); await Promise.resolve(); });
    expect(await screen.findByText('beta-app')).toBeTruthy();
    const listCalls = calls.filter((c) => c.url.startsWith('/api/applications?')).map((c) => new URL(c.url, 'http://x').searchParams.get('cursor'));
    expect(listCalls.at(-1)).toBeNull();
  });

  it('invalid URL parameters are ignored instead of being sent', async () => {
    const calls = backend((req) => req.url.startsWith('/api/applications?') ? json(200, page([])) : undefined);
    renderAt('/applications?serverId=nope&status=hacked&cursor=%3Cscript%3E');
    await screen.findByRole('heading', { name: 'Ще немає даних про процеси' });
    expect(calls.find((c) => c.url.startsWith('/api/applications?'))?.url).toBe('/api/applications?limit=50');
  });
});

describe('server detail: applications section', () => {
  function serverBackend(apps: (id: string) => Response | Promise<Response>) {
    return backend((req) => {
      for (const [id, name] of [[A, 'alpha'], [B, 'beta']] as const) {
        if (req.url === `/api/servers/${id}`) return json(200, serverDetail(id, name));
        if (req.url === `/api/servers/${id}/applications`) return apps(id);
      }
      return undefined;
    });
  }
  const apps = (id: string, inv: Record<string, unknown>, items: unknown[], serverStatus = 'online') =>
    json(200, { serverId: id, serverStatus, inventory: inventory(inv), items, freshWindowSeconds: 180 });

  it.each([
    [{ state: 'not_reported', source: null, capturedAt: null, collectedAt: null, reportedAt: null, processCount: null }, [], /ще не передавав inventory/],
    [{ state: 'current', processCount: 0 }, [], /PM2 не має процесів/],
    [{ state: 'stale' }, [app(A, 'api', { inventoryState: 'stale' })], /Дані застарілі/],
    [{ state: 'unavailable', reason: 'daemon_not_running' }, [app(A, 'api', { inventoryState: 'unavailable' })], /PM2 daemon не запущено.*можуть бути неактуальні/],
  ])('inventory state %#', async (inv, items, text) => {
    serverBackend((id) => apps(id, inv, items));
    renderApp(`/servers/${A}`);
    expect(await screen.findByText(text)).toBeTruthy();
    if (items.length > 0) expect(screen.getByRole('table', { name: 'PM2-процеси сервера' })).toBeTruthy();
  });

  it('offline server: data is explicitly not current', async () => {
    serverBackend((id) => apps(id, {}, [app(A, 'api', { serverStatus: 'offline' })], 'offline'));
    renderApp(`/servers/${A}`);
    expect(await screen.findByText(/Сервер зараз не онлайн/)).toBeTruthy();
    expect(screen.getByText('Сервер офлайн')).toBeTruthy();
  });

  it('A → B: A’s applications are gone while B loads and when B fails', async () => {
    const slowB = deferred<Response>();
    serverBackend((id) => (id === A ? apps(A, {}, [app(A, 'alpha-app')]) : slowB.promise));
    renderAt(`/servers/${A}`);
    expect(await screen.findByText('alpha-app')).toBeTruthy();
    await go(`/servers/${B}`);
    expect(screen.queryByText('alpha-app')).toBeNull();
    await act(async () => { slowB.resolve(json(503, {})); await Promise.resolve(); });
    expect(await screen.findByText('Не вдалося оновити застосунки')).toBeTruthy();
    expect(screen.queryByText('alpha-app')).toBeNull();
  });

  it('a response for another server is rejected by the parser (never shown)', async () => {
    serverBackend(() => apps(B, {}, [app(B, 'foreign')]));
    renderApp(`/servers/${A}`);
    expect(await screen.findByText('Не вдалося оновити застосунки')).toBeTruthy();
    expect(screen.queryByText('foreign')).toBeNull();
  });
});
