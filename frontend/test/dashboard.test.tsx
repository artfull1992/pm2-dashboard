import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// Dashboard UI (Task 012, ADR-020): honest labels, unknown metrics as "—", stale data never looks live, role-aware
// recent actions, polling only while visible, late answers ignored.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const empty = () => ({
  generatedAt: new Date().toISOString(), windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
  servers: { total: 0, inactive: 0, active: 0, online: 0, offline: 0, neverConnected: 0 },
  inventory: { current: 0, stale: 0, unavailable: 0, notReported: 0 },
  processes: { live: { total: 0, online: 0, problem: 0, transitional: 0 }, notLive: 0 },
  attentionServers: { items: [], total: 0, limit: 20 }, attentionProcesses: { items: [], total: 0, limit: 20 },
  serverList: { items: [], total: 0, limit: 50 }, recentActions: null,
});
function full(withActions: boolean) {
  return {
    ...empty(),
    servers: { total: 4, inactive: 1, active: 3, online: 2, offline: 1, neverConnected: 0 },
    inventory: { current: 1, stale: 1, unavailable: 0, notReported: 1 },
    processes: { live: { total: 5, online: 3, problem: 2, transitional: 0 }, notLive: 4 },
    attentionServers: {
      items: [
        { id: B, name: 'beta', status: 'offline', reason: 'offline', lastSeenAt: '2026-10-14T10:00:00.000Z', inventoryCollectedAt: null },
        { id: C, name: 'gamma', status: 'online', reason: 'inventory_stale', lastSeenAt: new Date().toISOString(), inventoryCollectedAt: '2026-10-14T09:00:00.000Z' },
      ],
      total: 60, limit: 20,
    },
    attentionProcesses: { items: [{ serverId: A, serverName: 'alpha', pmId: 4, name: 'worker', status: 'errored', restarts: 17, uptimeSeconds: null }], total: 2, limit: 20 },
    serverList: {
      items: [
        { id: A, name: 'alpha', status: 'online', lastSeenAt: new Date().toISOString(), metrics: { hostname: 'alpha.local', loadAverage: [1.5, 0.75, 0.25] }, inventory: { state: 'current', collectedAt: new Date().toISOString() }, processes: { total: 5, online: 3, problem: 2 } },
        { id: B, name: 'beta', status: 'offline', lastSeenAt: '2026-10-14T10:00:00.000Z', metrics: null, inventory: { state: 'current', collectedAt: new Date().toISOString() }, processes: null },
        { id: C, name: 'gamma', status: 'online', lastSeenAt: new Date().toISOString(), metrics: { hostname: 'gamma.local', loadAverage: [0, 0, 0] }, inventory: { state: 'stale', collectedAt: null }, processes: null },
      ],
      total: 3, limit: 50,
    },
    recentActions: withActions ? {
      limit: 10,
      items: [
        { id: '11111111-1111-4111-8111-111111111111', serverId: A, serverName: 'alpha', targetKey: 'api', action: 'restart', status: 'queued', reason: null, requestedAt: '2026-10-14T11:00:00.000Z', completedAt: null, requestedByMe: true, overdue: true },
        { id: '22222222-2222-4222-8222-222222222222', serverId: A, serverName: 'alpha', targetKey: 'web', action: 'stop', status: 'succeeded', reason: null, requestedAt: '2026-10-14T10:00:00.000Z', completedAt: '2026-10-14T10:00:05.000Z', requestedByMe: false, overdue: false },
      ],
    } : null,
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'admin' | 'operator' | 'viewer', dashboard: Route = () => json(200, full(role !== 'viewer'))) {
  return installFetch((req) => {
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url === '/api/dashboard') { const r = dashboard(req); if (r) return r; }
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url === '/api/auth/login') return json(200, session(role));
    return json(404, {});
  });
}
const dashCalls = (calls: RecordedRequest[]) => calls.filter((c) => c.url === '/api/dashboard').length;
const stat = (label: string) => screen.getByText(label).closest('.metric') as HTMLElement;

describe('dashboard', () => {
  it('summary cards, attention lists, server table: exact values, honest labels, unknown as "—"', async () => {
    backend('admin');
    renderApp('/');
    expect(await screen.findByText('Потребують уваги')).toBeTruthy();
    expect(within(stat('Сервери онлайн')).getByText('2 з 3')).toBeTruthy();
    expect(within(stat('Сервери онлайн')).getByText(/ще 1 неактивних не враховано/)).toBeTruthy();
    expect(within(stat('Не звітують')).getByText('офлайн 1 · без першого звіту 0')).toBeTruthy();
    expect(within(stat('PM2-процеси зараз')).getByText('5')).toBeTruthy();
    expect(within(stat('Проблемні сервіси')).getByText('2')).toBeTruthy();
    expect(within(stat('Неактуальні дані')).getByText('4')).toBeTruthy();
    // Attention: reasons in words, links, partial-list notice, cumulative restarts wording.
    expect(screen.getByText(/Агент не звітує \(офлайн\)/)).toBeTruthy();
    expect(screen.getByText('Показано 2 з 60 серверів.')).toBeTruthy();
    expect(screen.getByText(/рестартів усього 17/)).toBeTruthy();
    // Table: load average is labelled as a queue length, not CPU %; no host memory/uptime/CPU-count columns (Zabbix); unknown → "—".
    expect(screen.getByText(/Load avg — довжина черги процесів.*не відсоток CPU/)).toBeTruthy(); // visible text, not a hover title
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    const alpha = rows.find((r) => r.textContent.includes('alpha.local')) as HTMLElement;
    expect(alpha.textContent).toContain('1.50 / 0.75 / 0.25');
    expect(alpha.textContent).toContain('3 з 5 працюють');
    const beta = rows.find((r) => r.textContent.includes('beta')) as HTMLElement;
    expect(within(beta).getAllByText('—').length).toBe(1); // offline: no current load
    expect(within(beta).getByText('Сервер офлайн')).toBeTruthy(); // fresh inventory of an offline server is not "Актуально"
    const gamma = rows.find((r) => r.textContent.includes('gamma.local')) as HTMLElement;
    expect(gamma.textContent).toContain('0.00 / 0.00 / 0.00'); // a real zero load is shown as zero, not as unknown
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Сервер', 'Стан', 'Останній сигнал', 'Load avg 1/5/15', 'Сервіси PM2']);
    expect(document.body.textContent).not.toMatch(/Пам['’]ять ОС|Uptime|ядер/);
  });

  it('empty system: exact zeros and an honest empty state — no "everything is fine"', async () => {
    backend('admin', () => json(200, empty()));
    renderApp('/');
    expect(await screen.findByText('Ще немає активних серверів')).toBeTruthy();
    expect(within(stat('Сервери онлайн')).getByText('0 з 0')).toBeTruthy();
    expect(within(stat('Проблемні сервіси')).getByText('0')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.body.textContent).not.toMatch(/усе працює|все працює/i);
  });

  it('attention shows only non-empty categories: no empty half, and one calm line when nothing needs attention', async () => {
    backend('admin', () => json(200, { ...full(false), attentionServers: { items: [], total: 0, limit: 20 } }));
    const { unmount } = renderApp('/');
    expect(await screen.findByRole('heading', { name: /Сервіси з проблемним статусом/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Сервери \(/ })).toBeNull();
    unmount();
    backend('admin', () => json(200, { ...full(false), attentionServers: { items: [], total: 0, limit: 20 }, attentionProcesses: { items: [], total: 0, limit: 20 } }));
    renderApp('/');
    expect(await screen.findByText('Проблем немає')).toBeTruthy();
    expect(screen.getByText(/4 процесів мають неактуальний стан/)).toBeTruthy(); // stale data is not counted as healthy
    expect(screen.queryByRole('heading', { name: /Сервіси з проблемним статусом/ })).toBeNull();
  });

  it('hostname is shown under the name only when it differs', async () => {
    backend('admin', () => json(200, { ...full(false), serverList: { ...full(false).serverList, items: full(false).serverList.items.map((i) => (i.id === A ? { ...i, metrics: { hostname: 'alpha', loadAverage: [1, 1, 1] } } : i)) } }));
    renderApp('/');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'alpha' }).querySelector('.cell-meta')).toBeNull();
    expect(within(table).getByText('gamma.local')).toBeTruthy();
  });

  it('viewer: no recent actions block; operator sees them with "ви" and an honest overdue label', async () => {
    backend('viewer');
    const { unmount } = renderApp('/');
    expect(await screen.findByText('Потребують уваги')).toBeTruthy();
    expect(screen.queryByText('Останні керуючі дії')).toBeNull();
    unmount();
    backend('operator');
    renderApp('/');
    const block = (await screen.findByText('Останні керуючі дії')).closest('section') as HTMLElement;
    expect(within(block).getByText(/Дедлайн минув, остаточний статус ще не зафіксовано.* · ви/)).toBeTruthy();
    expect(within(block).getByText(/Виконано/)).toBeTruthy();
    expect(within(block).queryByText(/У черзі/)).toBeNull(); // the overdue queued command is not shown as simply queued
  });

  it('initial error → retry; error after data keeps the last data, labelled as such and dimmed', async () => {
    let mode: 'fail' | 'ok' | 'fail-later' = 'fail';
    backend('admin', () => (mode === 'ok' ? json(200, full(true)) : json(503, {}, { 'retry-after': '5' })));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Не вдалося завантажити огляд' })).toBeTruthy();
    mode = 'ok';
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    expect(await screen.findByText('Потребують уваги')).toBeTruthy();
    mode = 'fail-later';
    await userEvent.setup().click(screen.getByRole('button', { name: /Оновити/ }));
    expect(await screen.findByRole('heading', { name: 'Не вдалося оновити огляд' })).toBeTruthy();
    expect(screen.getByText(/Нижче — останні відомі дані станом на/)).toBeTruthy();
    expect(screen.getByText('Потребують уваги')).toBeTruthy();
    expect(document.querySelector('.dash-stats.dash--outdated')).not.toBeNull();
  });

  it('manual refresh shows progress and keeps the data; one request at a time', async () => {
    let gate: ReturnType<typeof deferred<Response>> | null = null;
    const calls = backend('admin', () => (gate ? gate.promise : json(200, full(true))));
    renderApp('/');
    expect(await screen.findByText('Потребують уваги')).toBeTruthy();
    gate = deferred<Response>();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /Оновити/ }));
    expect(await screen.findByRole('button', { name: 'Оновлення…' })).toBeTruthy();
    expect(screen.getByText('Потребують уваги')).toBeTruthy();
    const before = dashCalls(calls);
    const pending = gate;
    gate = null;
    await act(async () => { pending.resolve(json(200, full(true))); await Promise.resolve(); });
    expect(await screen.findByRole('button', { name: /^Оновити$/ })).toBeTruthy();
    expect(dashCalls(calls)).toBe(before);
  });

  it('polls every 15 s only while the tab is visible; data older than the online window is flagged even without an error', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    let hang = false;
    const calls = backend('admin', () => (hang ? new Promise<Response>(() => undefined) : json(200, full(true))));
    renderApp('/');
    expect(await screen.findByText('Потребують уваги')).toBeTruthy();
    const first = dashCalls(calls);
    await act(async () => { vi.advanceTimersByTime(15_000); await Promise.resolve(); });
    await waitFor(() => { expect(dashCalls(calls)).toBe(first + 1); });
    visibility = 'hidden';
    await act(async () => { vi.advanceTimersByTime(45_000); await Promise.resolve(); });
    expect(dashCalls(calls)).toBe(first + 1);
    visibility = 'visible';
    hang = true; // the API stops answering: the page must not keep looking live
    await act(async () => { vi.advanceTimersByTime(100_000); await Promise.resolve(); });
    await waitFor(() => { expect(screen.getByText(/статуси нижче можуть бути неактуальними/)).toBeTruthy(); });
    expect(document.querySelector('.dash-stats.dash--outdated')).not.toBeNull();
  });

  it('a late answer after logout and a new login is never shown; links open servers and applications', async () => {
    const late = deferred<Response>();
    let first = true;
    backend('admin', () => { if (first) { first = false; return late.promise; } return json(200, empty()); });
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Вийти' }));
    await u.type(await screen.findByLabelText('Email'), 'admin@example.test');
    await u.type(screen.getByLabelText('Пароль'), 'synthetic-Admin-Passw0rd');
    await u.click(screen.getByRole('button', { name: 'Увійти' }));
    expect(await screen.findByText('Ще немає активних серверів')).toBeTruthy();
    await act(async () => { late.resolve(json(200, full(true))); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('Потребують уваги')).toBeTruthy();
    expect(screen.queryByText(/Агент не звітує/)).toBeNull();
  });

  it('links lead to the server page and to all applications', async () => {
    backend('admin');
    renderApp('/');
    await screen.findByText('Потребують уваги');
    const links = screen.getAllByRole('link', { name: 'beta' });
    expect(links[0]?.getAttribute('href')).toBe(`/servers/${B}`);
    expect(screen.getByRole('link', { name: 'Усі застосунки →' }).getAttribute('href')).toBe('/applications');
    expect(screen.getByRole('link', { name: 'Усі сервери →' }).getAttribute('href')).toBe('/servers');
  });
});
