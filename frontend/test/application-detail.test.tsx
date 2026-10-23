import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useLocation, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { useAuth } from '../src/auth/AuthContext';
import { AuthProvider } from '../src/auth/AuthContext';
import { deferred, installFetch, json, type RecordedRequest, session, setViewportWidth } from './support';

type User = ReturnType<typeof userEvent.setup>;

// Applications workspace (redesign B, stage 2): compact list + details of ONE selected process (overview / inline logs /
// target history), lazy tabs, the same actions; the selection survives filters and pages and is verified against the
// server's current inventory; separate views below 1280 px; the server-side name search. Synthetic API only.

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
  /** GET /api/servers/:id/applications (the selection check); default: the current inventory with every process. */
  serverApps?: (id: string) => Response | Promise<Response>;
  /** Log read result (GET /api/log-requests/:id). */
  logResult?: () => Response | Promise<Response>;
}
let history: (serverId: string, targetKey: string) => unknown[] = () => [];
const inventory = (id: string, items: unknown[], over: Record<string, unknown> = {}, serverStatus = 'online') => json(200, {
  serverId: id, serverStatus, items, freshWindowSeconds: 180,
  inventory: { state: 'current', reason: null, source: 'pm2', capturedAt: null, collectedAt: '2026-10-13T12:00:01.000Z', reportedAt: null, processCount: items.length, ...over },
});
const logOk = (text: string) => json(200, { requestId: REQ, serverId: B, targetKey: 'api-beta', status: 'done', deadlineAt: new Date().toISOString(), result: { outcome: 'ok', reason: null, readAt: new Date().toISOString(), stdout: { state: 'ok', text, lines: text.split('\n').length, truncated: false, sizeBytes: text.length, modifiedAt: '2026-10-13T11:59:00.000Z' }, stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null } } });
function backend(role: 'operator' | 'viewer' | 'admin', { permissions, route = () => undefined, items = () => [app(A), app(B)], controlFor = (id) => control(id), logsFor = (id) => logTargets(id), serverApps = (id) => inventory(id, [app(id)]), logResult = () => logOk('beta line') }: Opts = {}) {
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
      if (req.url === `/api/servers/${id}/applications`) return serverApps(id);
      if (req.method === 'POST' && req.url === `/api/servers/${id}/control-commands`) return json(201, command(id));
      if (req.method === 'POST' && req.url === `/api/servers/${id}/log-requests`) return json(202, { requestId: REQ, deadlineAt: new Date(Date.now() + 15_000).toISOString() });
    }
    const hist = /^\/api\/servers\/([^/]+)\/control-commands\?limit=10&targetKey=([a-z0-9._-]+)$/.exec(req.url);
    if (hist) return json(200, { items: history(hist[1] ?? '', hist[2] ?? '') });
    if (req.url === `/api/control-commands/${CMD}`) return json(200, command(A));
    if (req.url === `/api/log-requests/${REQ}`) return logResult();
    return json(404, {});
  });
}
const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.includes('/control-commands'));
const capReads = (calls: RecordedRequest[]) => calls.filter((c) => /\/api\/servers\/[^/]+\/(control|log-targets)$/.test(c.url)).map((c) => c.url.replace('/api/servers/', '').replace(A, 'A').replace(B, 'B'));
const logReads = (calls: RecordedRequest[]) => calls.filter((c) => c.url.includes('/log-requests'));
const historyReads = (calls: RecordedRequest[]) => calls.filter((c) => c.url.includes('targetKey='));
const checks = (calls: RecordedRequest[]) => calls.filter((c) => /^\/api\/servers\/[^/]+\/applications$/.test(c.url));
const apps = (calls: RecordedRequest[]) => calls.filter((c) => c.url.startsWith('/api/applications?')).map((c) => new URL(c.url, 'http://x').searchParams);

const rowOf = (server: 'alpha' | 'beta', name = 'api') => screen.findByRole('button', { name: new RegExp(`^${name} на ${server}:`) });
const queryRow = (server: 'alpha' | 'beta', name = 'api') => screen.queryByRole('button', { name: new RegExp(`^${name} на ${server}:`) });
const panelOf = (server: 'alpha' | 'beta', name = 'api') => screen.findByRole('region', { name: `Деталі: ${name} на ${server}` });
const anyPanel = () => screen.queryByRole('region', { name: /^Деталі:/ });
async function select(user: User, server: 'alpha' | 'beta', name = 'api') {
  await user.click(await rowOf(server, name));
  return panelOf(server, name);
}

describe('workspace: list and details side by side (≥1280 px)', () => {
  // Design reference 1.0 (APP-01/11): no close control in the split view — a selection is replaced by another one.
  it('no selection → placeholder; one selection marked on its row (aria-current + accent bar); another row replaces it', async () => {
    backend('operator');
    renderAt();
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Оберіть застосунок, щоб переглянути деталі' })).toBeTruthy();
    expect(anyPanel()).toBeNull();
    expect(await screen.findByText('На цій сторінці: 2')).toBeTruthy();
    expect(screen.queryByText(/ із /)).toBeNull(); // no totals the API does not give
    const a = await rowOf('alpha');
    expect(a.getAttribute('aria-current')).toBeNull();
    await select(user, 'alpha');
    expect(a.getAttribute('aria-current')).toBe('true');
    expect(a.className).toContain('app-row--selected');
    expect(document.activeElement).toBe(a); // focus stays in the list in the split view
    await select(user, 'beta');
    expect(screen.getAllByRole('region', { name: /^Деталі:/ })).toHaveLength(1);
    expect(a.getAttribute('aria-current')).toBeNull();
    expect((await rowOf('beta')).getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Закрити деталі' })).toBeNull();
  });

  // Addendum §2: stopped/errored and offline/stale rows show «—» metrics; offline/stale is an unknown CURRENT state.
  it('rows: name + server, state, CPU, RAM, short uptime; «—» for stopped/errored and offline/stale; offline/stale is not «Працює»', async () => {
    backend('viewer', { items: () => [
      app(A, { uptimeSeconds: 90_061, cpuPercent: 12.5, memoryBytes: 150 * 1024 ** 2 }),
      app(B, { status: 'stopped', serverStatus: 'offline', cpuPercent: null, memoryBytes: null, uptimeSeconds: null }),
      app(A, { key: `${A}:pm2:4`, pmId: 4, name: 'worker', status: 'errored', inventoryState: 'stale' }),
    ] });
    renderAt();
    const a = await rowOf('alpha');
    expect(a.getAttribute('aria-label')).toBe('api на alpha: Працює, CPU 12.5 %, RAM 150 МіБ, час роботи 1 д 1 год');
    expect(within(a).getByText('Працює')).toBeTruthy();
    const b = await rowOf('beta');
    expect(b.getAttribute('aria-label')).toBe('api на beta: Невідомо (останній відомий стан: зупинено), CPU —, RAM —, час роботи —');
    expect(within(b).getByText('Невідомо').className).toContain('status--muted');
    expect(within(b).getAllByText('—')).toHaveLength(3);
    const w = await rowOf('alpha', 'worker');
    expect(within(w).getByText('Застаріло').className).toContain('status--muted');
    expect(within(w).queryByText('Помилка')).toBeNull();
    expect(screen.getByText('Є неактуальні дані: 2')).toBeTruthy();
    // No interactive content nested inside a row.
    expect(a.querySelector('a, button, input, select')).toBeNull();
  });

  it('overview is the first tab and reads nothing extra (no log read, no history); PM2 id, mode, restarts total, exact collection time', async () => {
    const calls = backend('operator');
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    expect(within(panel).getByRole('tab', { name: 'Огляд' }).getAttribute('aria-selected')).toBe('true');
    expect(within(panel).getByText('PM2 id')).toBeTruthy();
    expect(within(panel).getByText('Рестарти, усього')).toBeTruthy();
    // Metrics are in the header only (addendum §7), not repeated in the overview.
    expect(within(within(panel).getByRole('tabpanel')).queryByText('CPU')).toBeNull();
    expect(within(panel).getByText('Режим')).toBeTruthy();
    expect(within(panel).getByText('Зібрано')).toBeTruthy();
    expect(await within(panel).findByText(/Доступно: Запустити, Зупинити, Перезапустити/)).toBeTruthy();
    expect(logReads(calls)).toEqual([]);
    expect(historyReads(calls)).toEqual([]);
    expect(checks(calls)).toEqual([]); // the process is on the page: no extra inventory check
  });

  it('history: one request for the confirmed target of that server; scope is stated; reloads after a command', async () => {
    history = (serverId, key) => (serverId === A && key === 'api-alpha' ? [command(A, { status: 'succeeded', after: { status: 'online' }, completedAt: new Date().toISOString() })] : []);
    const calls = backend('operator');
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(await within(panel).findByText(/Виконано й підтверджено/)).toBeTruthy();
    expect(within(panel).getByText(/Команди цілі «api-alpha» з allowlist цього сервера/)).toBeTruthy();
    expect(historyReads(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/control-commands?limit=10&targetKey=api-alpha`]);
    await user.click(await within(panel).findByRole('button', { name: 'Перезапустити' }));
    const dialog = await screen.findByRole('dialog', { name: 'Перезапустити процес?' });
    expect(dialog.textContent).toContain('«api» (api-alpha) на сервері «alpha»');
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    expect(JSON.parse(posts(calls)[0]?.body ?? '{}')).toMatchObject({ targetKey: 'api-alpha', action: 'restart' });
    await waitFor(() => { expect(historyReads(calls).length).toBeGreaterThanOrEqual(2); });
  });

  it('history: no confirmed target → explained, nothing requested; empty history is its own message', async () => {
    const calls = backend('operator', { controlFor: (id) => control(id, { targets: id === A ? [] : [target(id)] }) });
    renderAt();
    const user = userEvent.setup();
    let panel = await select(user, 'alpha');
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(await within(panel).findByText(/немає підтвердженої цілі керування.*Це не означає, що команд не було/)).toBeTruthy();
    expect(historyReads(calls)).toEqual([]);
    panel = await select(user, 'beta');
    // The open tab is kept when another process is selected.
    expect(within(panel).getByRole('tab', { name: 'Історія дій' }).getAttribute('aria-selected')).toBe('true');
    expect(await within(panel).findByText('Команд для цієї цілі ще не було.')).toBeTruthy();
    expect(historyReads(calls).map((c) => c.url)).toEqual([`/api/servers/${B}/control-commands?limit=10&targetKey=api-beta`]);
  });

  it('a late history answer of the previously selected process is ignored', async () => {
    const slowA = deferred<Response>();
    history = (serverId) => (serverId === B ? [] : []);
    const calls = backend('operator', { route: (req) => (req.url.includes(`/servers/${A}/control-commands?`) ? slowA.promise : undefined) });
    renderAt();
    const user = userEvent.setup();
    let panel = await select(user, 'alpha');
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    await waitFor(() => { expect(historyReads(calls)).toHaveLength(1); });
    panel = await select(user, 'beta');
    expect(historyReads(calls)[0]?.signal?.aborted).toBe(true);
    expect(await within(panel).findByText('Команд для цієї цілі ще не було.')).toBeTruthy();
    await act(async () => { slowA.resolve(json(200, { items: [command(A, { status: 'succeeded', after: { status: 'online' } })] })); await Promise.resolve(); });
    expect(screen.queryByText(/Виконано й підтверджено/)).toBeNull();
  });

  it('logs load only on the Logs tab; switching away aborts the read; keyboard moves between tabs', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', { route: (req) => (req.url.endsWith('/log-requests') && req.method === 'POST' ? slow.promise : undefined) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'beta');
    within(panel).getByRole('tab', { name: 'Огляд' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(within(panel).getByRole('tab', { name: 'Логи' }));
    await waitFor(() => { expect(logReads(calls)).toHaveLength(1); });
    expect(logReads(calls)[0]?.url).toBe(`/api/servers/${B}/log-requests`);
    await user.keyboard('{ArrowRight}');
    expect(within(panel).getByRole('tab', { name: 'Історія дій' }).getAttribute('aria-selected')).toBe('true');
    expect(logReads(calls)[0]?.signal?.aborted).toBe(true);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(within(panel).getByRole('tab', { name: 'Огляд' }));
    await user.keyboard('{Escape}'); // Escape never runs anything
    expect(posts(calls)).toEqual([]);
  });

  it('logs: switching to another process stops the read of the previous one', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', { route: (req) => (req.url === `/api/servers/${B}/log-requests` ? slow.promise : undefined) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'beta');
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    await waitFor(() => { expect(logReads(calls)).toHaveLength(1); });
    await select(user, 'alpha');
    expect(logReads(calls)[0]?.signal?.aborted).toBe(true);
    await waitFor(() => { expect(logReads(calls).some((c) => c.url === `/api/servers/${A}/log-requests`)).toBe(true); });
  });

  it('polling refreshes keep the details, the tab and focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = backend('operator');
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      const panel = await select(user, 'alpha');
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

  // APP-10: viewing without control — the command is shown disabled with «Немає дозволу»; logs:read is separate.
  it('viewer: commands disabled with the reason; logs and history explain why, and nothing is requested', async () => {
    const calls = backend('viewer');
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    expect(within(panel).getByText('Режим перегляду')).toBeTruthy();
    expect(within(panel).getByText('Немає дозволу')).toBeTruthy();
    const restart = within(panel).getByRole('button', { name: 'Перезапустити' });
    expect(restart.getAttribute('aria-disabled')).toBe('true');
    await user.click(restart);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: 'Дії: api на alpha' }).disabled).toBe(true);
    expect(within(panel).queryByRole('button', { name: /^(Запустити|Зупинити)$/ })).toBeNull();
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    expect(within(panel).getByText('Немає права на перегляд логів.')).toBeTruthy();
    await user.click(within(panel).getByRole('tab', { name: 'Історія дій' }));
    expect(within(panel).getByText(/доступна користувачам із правом керування/)).toBeTruthy();
    expect(logReads(calls)).toEqual([]);
    expect(historyReads(calls)).toEqual([]);
    expect(capReads(calls)).toEqual([]);
  });

  it('a command started from the details keeps being tracked after another process is selected', async () => {
    let status = 'queued';
    backend('operator', { route: (req) => (req.url === `/api/control-commands/${CMD}` ? json(200, command(A, { status, ...(status === 'succeeded' ? { after: { status: 'online' }, completedAt: new Date().toISOString() } : {}) })) : undefined) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.click(await within(panel).findByRole('button', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    expect(await screen.findByText(/«api-alpha» на сервері «alpha»: У черзі/)).toBeTruthy();
    await select(user, 'beta');
    expect(screen.queryByRole('region', { name: 'Деталі: api на alpha' })).toBeNull();
    status = 'succeeded';
    expect(await screen.findByText(/«api-alpha» на сервері «alpha»: Виконано й підтверджено/, undefined, { timeout: 4000 })).toBeTruthy();
  });
});

describe('selection beyond the rows on screen', () => {
  it('outside the filter: the details stay, verified against the server inventory, commands available; reset clears filters and cursor', async () => {
    const calls = backend('operator', { items: (q) => (q.get('serverId') === B ? [app(B)] : [app(A), app(B)]) });
    renderAt('/applications?cursor=abc');
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.selectOptions(screen.getByLabelText('Сервер'), B);
    await waitFor(() => { expect(nav.search).toBe(`?serverId=${B}`); });
    await waitFor(() => { expect(queryRow('alpha')).toBeNull(); });
    expect(await within(panel).findByText('Вибраний застосунок поза поточним фільтром')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Деталі: api на alpha' })).toBe(panel);
    expect(checks(calls).map((c) => c.url)).toEqual([`/api/servers/${A}/applications`]);
    expect((await within(panel).findByRole('button', { name: 'Перезапустити' })).getAttribute('aria-disabled')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Скинути фільтри' }));
    await waitFor(() => { expect(nav.search).toBe(''); });
    expect((await rowOf('alpha')).getAttribute('aria-current')).toBe('true');
    expect(within(panel).queryByText('Вибраний застосунок поза поточним фільтром')).toBeNull();
  });

  it('on another page: said so; the selection survives page changes', async () => {
    backend('operator', { items: (q) => (q.get('cursor') ? [app(B)] : [app(A)]), route: (req) => (req.url.startsWith('/api/applications?') && !req.url.includes('cursor') ? json(200, { items: [app(A)], nextCursor: 'NEXT', freshWindowSeconds: 180 }) : undefined) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.click(screen.getByRole('button', { name: 'Наступна сторінка' }));
    await rowOf('beta');
    expect(await within(panel).findByText(/не на поточній сторінці списку/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'На першу сторінку' }));
    expect((await rowOf('alpha')).getAttribute('aria-current')).toBe('true');
  });

  it('confirmed gone from a current inventory: message, no metrics, no commands, no logs; nothing substituted', async () => {
    let rows = [app(A), app(B)];
    let inv = () => inventory(A, [app(A)]);
    const calls = backend('operator', { items: () => rows, serverApps: (id) => (id === A ? inv() : inventory(id, [app(id)])) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      const panel = await select(user, 'alpha');
      await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
      await waitFor(() => { expect(logReads(calls).length).toBeGreaterThan(0); });
      // The same key now belongs to another process (PM2 id reused): never shown as the selected one.
      rows = [app(A, { name: 'other' }), app(B)];
      inv = () => inventory(A, [app(A, { name: 'other' })]);
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
      expect(await within(panel).findByText(/Процесу більше немає серед доступних вам процесів сервера «alpha»/)).toBeTruthy();
      expect(within(panel).queryByText('CPU')).toBeNull();
      expect(within(panel).queryByRole('tab')).toBeNull();
      expect(within(panel).queryByRole('button', { name: /Перезапустити|^Дії:/ })).toBeNull();
      expect(within(panel).queryByText('beta line')).toBeNull();
      expect(logReads(calls).filter((c) => c.method === 'GET').every((c) => c.signal?.aborted)).toBe(true);
      expect(screen.getByRole('region', { name: 'Деталі: api на alpha' })).toBe(panel); // no substitution by "other"
      expect((await rowOf('alpha', 'other')).getAttribute('aria-current')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['stale inventory', () => inventory(A, [], { state: 'stale' }), /inventory сервера застарілий/],
    ['unavailable inventory', () => inventory(A, [], { state: 'unavailable', reason: 'timeout' }), /inventory сервера недоступний/],
    ['offline server', () => inventory(A, [], {}, 'offline'), /сервер не онлайн/],
    ['truncated answer', () => inventory(A, Array.from({ length: 500 }, (_, i) => app(A, { key: `${A}:pm2:${String(100 + i)}`, pmId: 100 + i, name: `p${String(i)}` }))), /обмежена 500 процесами/],
  ])('not confirmable (%s): last known data under a warning, commands blocked', async (_n, inv, why) => {
    const calls = backend('operator', { items: (q) => (q.get('status') ? [] : [app(A), app(B)]), serverApps: (id) => (id === A ? inv() : inventory(id, [app(id)])) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await within(panel).findByRole('button', { name: 'Перезапустити' });
    await user.selectOptions(screen.getByLabelText('Статус'), 'errored');
    expect(await within(panel).findByText(why)).toBeTruthy();
    expect(within(panel).getByText(/Не вдалося підтвердити, що процес ще існує/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Перезапустити' }).getAttribute('aria-disabled')).toBe('true');
    expect(within(panel).getByText('Наявність процесу не підтверджено.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Перезапустити' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it('the check itself failed (503): uncertainty, commands blocked', async () => {
    backend('operator', { items: (q) => (q.get('status') ? [] : [app(A)]), serverApps: () => json(503, {}) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.selectOptions(screen.getByLabelText('Статус'), 'errored');
    expect(await within(panel).findByText(/Не вдалося перевірити поточний inventory сервера/)).toBeTruthy();
    expect((await within(panel).findByRole('button', { name: 'Перезапустити' })).getAttribute('aria-disabled')).toBe('true');
  });

  it.each([[403], [404]])('access revoked (%i on the check): details and log text are hidden', async (code) => {
    let revoked = false;
    const calls = backend('operator', { items: () => (revoked ? [app(B)] : [app(A), app(B)]), serverApps: (id) => (id === A && revoked ? json(code, {}) : inventory(id, [app(id)])) });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAt();
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      const panel = await select(user, 'alpha');
      await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
      expect(await within(panel).findByText('beta line')).toBeTruthy();
      revoked = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
      expect(await within(panel).findByText(/Доступ до цього застосунку або його сервера більше не надано/)).toBeTruthy();
      expect(within(panel).queryByText('beta line')).toBeNull();
      expect(within(panel).queryByRole('tab')).toBeNull();
      expect(within(panel).queryByText('CPU')).toBeNull();
      expect(posts(calls)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('same PM2 id and name on two servers: the selection is per server; the check asks only the selected server', async () => {
    const calls = backend('operator', { items: (q) => (q.get('serverId') === B ? [app(B)] : [app(A), app(B)]) });
    renderAt();
    const user = userEvent.setup();
    await select(user, 'beta');
    expect((await rowOf('alpha')).getAttribute('aria-current')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Сервер'), B);
    await waitFor(() => { expect(queryRow('alpha')).toBeNull(); });
    expect((await rowOf('beta')).getAttribute('aria-current')).toBe('true');
    // While the new list loads, only the selected server is checked (never the other one).
    expect(checks(calls).every((c) => c.url === `/api/servers/${B}/applications`)).toBe(true);
  });

  it('a new session starts without a selection', async () => {
    backend('operator');
    const view = renderAt();
    const user = userEvent.setup();
    await select(user, 'alpha');
    await act(async () => { await nav.logout?.(); });
    expect(await screen.findByRole('heading', { name: 'Node Control' })).toBeTruthy();
    view.unmount();
    renderAt();
    await rowOf('alpha');
    expect(anyPanel()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Оберіть застосунок, щоб переглянути деталі' })).toBeTruthy();
  });
});

describe('below 1280 px: separate views', () => {
  // APP-14 / APP-15: the tablet details keep the page header and filters above the panel; the phone details hide both
  // (they come back with the same values through «До списку застосунків»).
  it.each([1279, 1024, 390])('%i px: list full width; selection opens the details view; «До списку застосунків» keeps filters and focuses the row', async (width) => {
    setViewportWidth(width);
    backend('operator');
    renderAt('/applications?status=online');
    const user = userEvent.setup();
    expect(screen.queryByRole('heading', { name: 'Оберіть застосунок, щоб переглянути деталі' })).toBeNull();
    const panel = await select(user, 'beta');
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { name: 'api' }));
    expect(queryRow('alpha')).toBeNull(); // the list is replaced by the details view
    if (width <= 600) {
      expect(screen.queryByLabelText('Пошук за назвою')).toBeNull();
      expect(screen.queryByText('Робочий простір')).toBeNull();
    } else {
      expect(screen.getByLabelText<HTMLSelectElement>('Статус').value).toBe('online');
    }
    expect(screen.queryByRole('button', { name: 'Закрити деталі' })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: '← До списку застосунків' }));
    expect(anyPanel()).toBeNull();
    expect(nav.search).toBe('?status=online');
    expect(screen.getByLabelText<HTMLSelectElement>('Статус').value).toBe('online');
    expect(document.activeElement).toBe(await rowOf('beta'));
    expect((await rowOf('beta')).getAttribute('aria-current')).toBe('true');
  });

  it('1280 px is already the split view', async () => {
    setViewportWidth(1280);
    backend('operator');
    renderAt();
    expect(await screen.findByRole('heading', { name: 'Оберіть застосунок, щоб переглянути деталі' })).toBeTruthy();
  });
});

describe('log tail in the details', () => {
  async function openLogs(user: User) {
    const panel = await select(user, 'beta');
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    return panel;
  }

  // APP-01: the log shows its read time and the file time; the PM2 collection time is in the header («Зібрано …»).
  it('shows the read time and the file time; the PM2 collection time is in the header; limits behind «Подробиці»', async () => {
    backend('operator');
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    await within(panel).findByText('beta line');
    expect(within(panel).getByText(/^Отримано .* · файл змінено /)).toBeTruthy();
    expect(within(panel).getByText(/^Зібрано /)).toBeTruthy();
    const more = within(panel).getByRole('button', { name: 'Подробиці' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const details = document.getElementById(more.getAttribute('aria-controls') ?? '');
    expect(details?.hidden).toBe(true);
    await user.click(more);
    expect(details?.hidden).toBe(false);
    expect(details?.textContent).toMatch(/до 100 рядків на джерело, до 8 КіБ разом.*не повний архів/);
    expect(details?.textContent).toMatch(/не гарантія/);
  });

  it('transient failure: the previous text of the same process stays, explicitly labelled as not refreshed', async () => {
    let fail = false;
    backend('operator', { logResult: () => (fail ? json(503, {}) : logOk('first text')) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('first text')).toBeTruthy();
    fail = true;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    expect(await within(panel).findByText(/^Останній успішний результат: .* · нові дані не отримано$/)).toBeTruthy();
    expect(within(panel).getByText('first text')).toBeTruthy();
  });

  it.each([[403], [409]])('%i: the text is hidden', async (code) => {
    let fail = false;
    backend('operator', { route: (req) => (fail && req.url.endsWith('/log-requests') ? json(code, {}) : undefined), logResult: () => logOk('secret-ish text') });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('secret-ish text')).toBeTruthy();
    fail = true;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    await waitFor(() => { expect(within(panel).queryByText('secret-ish text')).toBeNull(); });
    expect(within(panel).getByRole('alert')).toBeTruthy();
  });

  it('a refusal for another reason (not authorized / target changed) hides the text', async () => {
    let refuse = false;
    backend('operator', { logResult: () => (refuse ? json(200, { requestId: REQ, serverId: B, targetKey: 'api-beta', status: 'done', deadlineAt: new Date().toISOString(), result: { outcome: 'rejected', reason: 'not_authorized', readAt: new Date().toISOString(), stdout: null, stderr: null } }) : logOk('old text')) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('old text')).toBeTruthy();
    refuse = true;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    expect(await within(panel).findByText(/доступ до цього сервісу більше не надано/)).toBeTruthy();
    expect(within(panel).queryByText('old text')).toBeNull();
  });

  it('while text is selected in the log, a newer fragment waits; clearing the selection shows it', async () => {
    let text = 'line one';
    backend('operator', { logResult: () => logOk(text) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    const pre = await within(panel).findByText('line one');
    const range = document.createRange();
    range.selectNodeContents(pre);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    text = 'line two';
    // A plain click: user-event's pointer emulation would itself clear the selection.
    fireEvent.click(within(panel).getByRole('button', { name: 'Оновити' }));
    expect(await within(panel).findByText(/Отримано новіший фрагмент/)).toBeTruthy();
    expect(within(panel).getByText('line one')).toBeTruthy();
    await act(async () => { document.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); await Promise.resolve(); });
    expect(await within(panel).findByText('line two')).toBeTruthy();
  });

  it('follows the end only when the reader was at the end; the stream stays as chosen', async () => {
    let text = Array.from({ length: 50 }, (_, i) => `l${String(i)}`).join('\n');
    backend('operator', { logResult: () => logOk(text) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    const pre = await within(panel).findByText(/^l0/);
    Object.defineProperty(pre, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(pre, 'clientHeight', { configurable: true, get: () => 200 });
    pre.scrollTop = 100; // reading somewhere in the middle
    pre.dispatchEvent(new Event('scroll'));
    text += '\nnew';
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    await within(panel).findByText(/new$/);
    expect(pre.scrollTop).toBe(100);
    pre.scrollTop = 800; // at the end
    pre.dispatchEvent(new Event('scroll'));
    text += '\nnewer';
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    await within(panel).findByText(/newer$/);
    expect(pre.scrollTop).toBe(1000);
    expect(within(panel).getByRole('tab', { name: 'stdout' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('log tail: an ambiguous 404 fails closed (review P1)', () => {
  // GET /api/log-requests/:id answers 404 also after resource access was revoked (also after a long-poll), and the API
  // never says which case it is. Text already on screen must go, and nothing may bring it back.
  const NOT_AVAILABLE = /Запит або ресурс логів недоступний/;
  async function openLogs(user: User) {
    const panel = await select(user, 'beta');
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    return panel;
  }
  const textGone = (text: string) => { expect(document.body.textContent).not.toContain(text); expect(document.querySelector('.log-text')).toBeNull(); };

  it('success, then 404 on the next create → the old text is gone from the DOM; auto-refresh stops; the message names no single cause', async () => {
    let gone = false;
    const calls = backend('operator', { route: (req) => (gone && req.method === 'POST' && req.url.endsWith('/log-requests') ? json(404, {}) : undefined), logResult: () => logOk('secret old text') });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('secret old text')).toBeTruthy();
    gone = true;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    const alert = await within(panel).findByRole('alert');
    textGone('secret old text');
    expect(alert.textContent).toMatch(NOT_AVAILABLE);
    expect(alert.textContent).not.toMatch(/^Запит протерміновано або сервер API перезапускався/);
    expect(within(panel).queryByText(/Останній успішний результат/)).toBeNull();
    expect(within(panel).getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    const before = logReads(calls).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(logReads(calls)).toHaveLength(before); // no automatic retry, no extra probing
  });

  it('success, then 404 on GET of the result → the old text is gone', async () => {
    let gone = false;
    backend('operator', { logResult: () => (gone ? json(404, {}) : logOk('secret old text')) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('secret old text')).toBeTruthy();
    gone = true;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    const alert = await within(panel).findByRole('alert');
    textGone('secret old text');
    expect(alert.textContent).toMatch(NOT_AVAILABLE);
  });

  it('a long-poll GET that ends in 404: the text stays while waiting, then is cleared', async () => {
    let slow: ReturnType<typeof deferred<Response>> | null = null;
    backend('operator', { logResult: () => (slow ? slow.promise : logOk('secret old text')) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('secret old text')).toBeTruthy();
    const pending = deferred<Response>();
    slow = pending;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    expect(within(panel).getByText('secret old text')).toBeTruthy(); // still the last answer while the read is pending
    await act(async () => { pending.resolve(json(404, {})); await Promise.resolve(); });
    const alert = await within(panel).findByRole('alert');
    textGone('secret old text');
    expect(alert.textContent).toMatch(NOT_AVAILABLE);
  });

  it('a newer fragment held back by a selection is dropped with the visible one; neither selectionchange nor «Показати зараз» brings text back', async () => {
    let step = 0;
    backend('operator', { logResult: () => (step === 0 ? logOk('visible old') : step === 1 ? logOk('pending newer') : json(404, {})) });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    const pre = await within(panel).findByText('visible old');
    const range = document.createRange();
    range.selectNodeContents(pre);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    step = 1;
    fireEvent.click(within(panel).getByRole('button', { name: 'Оновити' }));
    expect(await within(panel).findByText(/Отримано новіший фрагмент/)).toBeTruthy();
    step = 2;
    fireEvent.click(within(panel).getByRole('button', { name: 'Оновити' }));
    const alert = await within(panel).findByRole('alert');
    textGone('visible old');
    expect(within(panel).queryByRole('button', { name: 'Показати зараз' })).toBeNull();
    await act(async () => { document.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); await Promise.resolve(); });
    textGone('visible old');
    textGone('pending newer');
    expect(alert.textContent).toMatch(NOT_AVAILABLE);
  });

  it('a transient 503 still keeps only the labelled previous result of the same process', async () => {
    let fail = false;
    backend('operator', { route: (req) => (fail && req.method === 'POST' && req.url.endsWith('/log-requests') ? json(503, {}) : undefined), logResult: () => logOk('kept text') });
    renderAt();
    const user = userEvent.setup();
    const panel = await openLogs(user);
    expect(await within(panel).findByText('kept text')).toBeTruthy();
    fail = true;
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    expect(await within(panel).findByText(/^Останній успішний результат: .* · нові дані не отримано$/)).toBeTruthy();
    expect(within(panel).getByText('kept text')).toBeTruthy();
    expect(within(panel).getByRole('alert').textContent).not.toMatch(NOT_AVAILABLE);
  });

  it('after a 404, switching the process and coming back or a new session never restores the cleared text', async () => {
    let mode: 'ok' | 'gone' | 'slow' = 'ok';
    const slow = deferred<Response>();
    backend('operator', { logResult: () => (mode === 'ok' ? logOk('secret old text') : mode === 'gone' ? json(404, {}) : slow.promise) });
    const view = renderAt();
    const user = userEvent.setup();
    let panel = await openLogs(user);
    expect(await within(panel).findByText('secret old text')).toBeTruthy();
    mode = 'gone';
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    await within(panel).findByRole('alert');
    textGone('secret old text');
    mode = 'slow';
    await select(user, 'alpha');
    panel = await select(user, 'beta');
    expect(within(panel).getByRole('tab', { name: 'Логи' }).getAttribute('aria-selected')).toBe('true');
    expect(await within(panel).findByText('Завантаження логів…')).toBeTruthy();
    textGone('secret old text');
    await act(async () => { await nav.logout?.(); });
    view.unmount();
    renderAt();
    await rowOf('beta');
    textGone('secret old text');
  });
});

describe('design reference 1.0: states of the selected process (APP-04…APP-10)', () => {
  const recent = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  it('APP-04 stopped: «Запустити» is the visible command, CPU/RAM/uptime «—», the stop is not called an incident', async () => {
    backend('operator', { items: () => [app(A, { status: 'stopped', cpuPercent: 0, memoryBytes: 1024, uptimeSeconds: 0, collectedAt: recent(18) })] });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    expect(await within(panel).findByRole('button', { name: 'Запустити' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Перезапустити' })).toBeNull(); // in the «⋯» menu
    expect(within(panel).getByText('Процес зупинено')).toBeTruthy();
    expect(within(panel).getByText(/Це не обов’язково інцидент/)).toBeTruthy();
    const metrics = panel.querySelector('.app-metrics');
    expect([...(metrics?.querySelectorAll('dd') ?? [])].map((d) => d.textContent)).toEqual(['—', '—', '—']); // not 0
    expect(within(panel).getByText(/^Зібрано 18 с тому · /)).toBeTruthy();
  });

  it('APP-05 errored: an error notice and «—» metrics; restart stays the visible command', async () => {
    backend('operator', { items: () => [app(A, { status: 'errored', collectedAt: recent(18) })] });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    expect(within(panel).getByText('Помилка').className).toContain('status--bad');
    expect(within(panel).getByText('PM2 повідомляє про помилку').closest('.notice')?.className).toContain('notice--error');
    expect(await within(panel).findByRole('button', { name: 'Перезапустити' })).toBeTruthy();
  });

  it('APP-06 agent offline: unknown current state, last signal, last known values labelled stale, commands blocked', async () => {
    const offline = { ...serverPage, items: serverPage.items.map((s) => (s.id === A ? { ...s, status: 'offline', lastSeenAt: recent(240) } : s)) };
    const calls = backend('operator', {
      route: (req) => (req.url.startsWith('/api/servers?') ? json(200, offline) : undefined),
      items: () => [app(A, { serverStatus: 'offline', cpuPercent: 2.1, collectedAt: recent(240) }), app(B)],
      controlFor: (id) => control(id, id === A ? { serverStatus: 'offline', broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: recent(240), fresh: false } } : {}),
    });
    renderAt();
    const user = userEvent.setup();
    const row = await rowOf('alpha');
    expect(within(row).getByText('Невідомо')).toBeTruthy();
    expect(within(row).getAllByText('—')).toHaveLength(3);
    const panel = await select(user, 'alpha');
    expect(within(panel).queryByText('Працює')).toBeNull(); // the current state is not confirmed
    expect(await within(panel).findByText('Агент не звітує · останній сигнал 4 хв тому')).toBeTruthy();
    expect(within(panel).getByText('Останній відомий стан: працює. Поточний стан невідомий.')).toBeTruthy();
    expect(within(panel).getByText('2.1 %')).toBeTruthy(); // the actually received last value…
    expect(within(panel).getByText(/^Останні відомі значення · дані застарілі · зібрано /)).toBeTruthy(); // …labelled
    expect((await within(panel).findByRole('button', { name: 'Перезапустити' })).getAttribute('aria-disabled')).toBe('true');
    expect(within(panel).getByText('Керування недоступне', { selector: '.app-detail__hint' })).toBeTruthy();
    expect(posts(calls)).toEqual([]);
  });

  it('APP-07 PM2 data stale with the agent online: «Застаріло», separate agent signal, commands blocked', async () => {
    backend('operator', { items: () => [app(A, { inventoryState: 'stale', collectedAt: recent(240) })] });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    expect(within(panel).getByText('Застаріло')).toBeTruthy();
    expect(within(panel).getByText('Дані PM2 застарілі · останній збір 4 хв тому')).toBeTruthy();
    expect(within(panel).getByText(/^Агент онлайн · сигнал .* тому\. Поточний стан процесу невідомий \(останній відомий: працює\)\.$/)).toBeTruthy();
    expect((await within(panel).findByRole('button', { name: 'Перезапустити' })).getAttribute('aria-disabled')).toBe('true');
  });

  it('every process of an offline server is projected the same way (not only the selected one)', async () => {
    backend('viewer', { items: () => [
      app(A, { serverStatus: 'offline' }), app(A, { key: `${A}:pm2:4`, pmId: 4, name: 'worker', serverStatus: 'offline', status: 'stopped' }), app(B),
    ] });
    renderAt();
    expect(within(await rowOf('alpha')).getByText('Невідомо')).toBeTruthy();
    expect(within(await rowOf('alpha', 'worker')).getByText('Невідомо')).toBeTruthy();
    expect(within(await rowOf('beta')).getByText('Працює')).toBeTruthy();
  });

  it('APP-08 loading: skeleton rows and a loading pane; no process is invented', async () => {
    const slow = deferred<Response>();
    backend('operator', { route: (req) => (req.url.startsWith('/api/applications?') ? slow.promise : undefined) });
    renderAt();
    expect(await screen.findByRole('heading', { name: 'Завантаження застосунків' })).toBeTruthy();
    expect(anyPanel()).toBeNull();
    expect(queryRow('alpha')).toBeNull();
    expect(document.querySelectorAll('.app-row--skeleton').length).toBeGreaterThan(0);
    await act(async () => { slow.resolve(json(200, { items: [app(A)], nextCursor: null, freshWindowSeconds: 180 })); await Promise.resolve(); });
    expect(await rowOf('alpha')).toBeTruthy();
  });

  it('APP-09 empty result: the reset is inside the empty list; a selection outside the filter is kept', async () => {
    backend('operator', { items: (q) => (q.get('q') ? [] : [app(A), app(B)]) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.type(screen.getByLabelText('Пошук за назвою'), 'payment-archive');
    expect(await screen.findByRole('heading', { name: 'Нічого не знайдено' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Деталі: api на alpha' })).toBe(panel); // the selection stays
    expect(screen.getAllByRole('button', { name: 'Скинути фільтри' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Скинути фільтри' }));
    await waitFor(() => { expect(nav.search).toBe(''); });
    expect((await rowOf('alpha')).getAttribute('aria-current')).toBe('true');
  });

  it('APP-10 metrics without control and without logs:read: no log is requested through the visible tab', async () => {
    const calls = backend('viewer');
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'alpha');
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    expect(within(panel).getByText('Немає права на перегляд логів.')).toBeTruthy();
    expect(logReads(calls)).toEqual([]);
  });

  it('log refusal (403) is «Логи недоступні» without the request-error note; a transient error says it is not a process failure', async () => {
    let mode: 'ok' | 'denied' | 'down' = 'ok';
    backend('operator', { route: (req) => (mode !== 'ok' && req.method === 'POST' && req.url.endsWith('/log-requests') ? json(mode === 'denied' ? 403 : 503, {}) : undefined) });
    renderAt();
    const user = userEvent.setup();
    const panel = await select(user, 'beta');
    await user.click(within(panel).getByRole('tab', { name: 'Логи' }));
    expect(await within(panel).findByText('beta line')).toBeTruthy();
    mode = 'down';
    await user.click(within(panel).getByRole('button', { name: 'Оновити' }));
    const transient = await within(panel).findByRole('alert');
    expect(transient.textContent).toMatch(/^Не вдалося отримати логи.*Помилка запиту не означає зупинку процесу\.$/);
    expect(within(panel).getByText('beta line')).toBeTruthy();
    mode = 'denied';
    await user.click(within(panel).getByRole('button', { name: 'Повторити запит' }));
    await waitFor(() => { expect(within(panel).queryByText('beta line')).toBeNull(); });
    const denied = within(panel).getByRole('alert');
    expect(denied.textContent).toMatch(/^Логи недоступні/);
    expect(denied.textContent).not.toMatch(/не означає зупинку/);
  });
});

describe('name search', () => {
  it('debounced: one request after typing stops; q in the URL; cursor reset; clear; Back restores the box', async () => {
    const calls = backend('operator', { items: (q) => (q.get('q') ? [app(B)] : [app(A), app(B)]) });
    renderAt('/applications?cursor=abc');
    const user = userEvent.setup();
    const box = await screen.findByLabelText('Пошук за назвою');
    await rowOf('alpha');
    const before = apps(calls).length;
    await user.type(box, 'API');
    expect(apps(calls).length).toBe(before); // nothing per keystroke
    await waitFor(() => { expect(nav.search).toBe('?q=API'); }, { timeout: 2000 });
    await waitFor(() => { expect(apps(calls).at(-1)?.get('q')).toBe('API'); });
    expect(apps(calls).slice(before).filter((p) => p.get('q') !== null)).toHaveLength(1);
    expect(apps(calls).at(-1)?.get('cursor')).toBeNull();
    await waitFor(() => { expect(queryRow('alpha')).toBeNull(); });
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
    expect(queryRow('alpha')).toBeNull();
  });
});
