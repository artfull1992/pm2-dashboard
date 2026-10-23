import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import { deferred, installFetch, json, type RecordedRequest, session } from './support';

// Stage 3.1 (overview, servers, server detail on the shared design system, ТЗ §11 / DS-01): the UI projection of the
// process state on the server page, honest unknowns, no extra per-server requests, roles, and command protection.
// Synthetic API only.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CMD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now = () => new Date().toISOString();
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const detail = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id === A ? 'alpha' : 'beta', isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: ago(18), hasActiveCredential: true,
  snapshot: { agentVersion: '0.6.0', hostname: id === A ? 'alpha' : 'beta.internal', platform: 'linux', arch: 'x64', loadAverage: [0.5, 0.25, 0.1] }, ...over,
});
const proc = (id: string, pmId: number, name: string, over: Record<string, unknown> = {}) => ({
  key: `${id}:pm2:${String(pmId)}`, serverId: id, serverName: id === A ? 'alpha' : 'beta', serverStatus: 'online', source: 'pm2', pmId, name, status: 'online',
  uptimeSeconds: 43_200, restarts: 2, cpuPercent: 0, memoryBytes: 96 * 1024 ** 2, execMode: 'fork', firstSeenAt: '2026-10-13T10:00:00.000Z',
  inventoryState: 'current', capturedAt: now(), collectedAt: now(), ...over,
});
const inventory = (id: string, items: unknown[], state = 'current', serverStatus = 'online') => ({
  serverId: id, serverStatus, freshWindowSeconds: 180, items,
  inventory: { state, reason: state === 'unavailable' ? 'daemon_not_running' : null, source: 'pm2', capturedAt: ago(30), collectedAt: ago(state === 'current' ? 5 : 400), reportedAt: ago(5), processCount: items.length },
});
const target = (name: string, pmId: number) => ({ targetKey: name, name, pmId, actions: ['restart', 'stop', 'start'], matchStatus: 'ok' });
const control = (id: string, names: [string, number][]) => ({
  serverId: id, enabled: true, serverStatus: 'online', broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now(), fresh: true, mode: 'allowlist' },
  targets: names.map(([n, p]) => target(n, p)), targetFreshSeconds: 60,
});
const command = (over: Record<string, unknown> = {}) => ({
  id: CMD, serverId: A, targetKey: 'api', action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
  requestedAt: now(), deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: null, ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

const nav: { current: NavigateFunction | null } = { current: null };
function Probe() { const n = useNavigate(); useEffect(() => { nav.current = n; }, [n]); return null; }
const renderAt = (path: string) => render(<AuthProvider><MemoryRouter initialEntries={[path]}><Probe /><AppRoutes /></MemoryRouter></AuthProvider>);

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'admin' | 'operator' | 'viewer', route: Route = () => undefined) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url.startsWith('/api/servers?')) return json(200, { items: [detail(A), detail(B, { status: 'offline', lastSeenAt: ago(600) })].map(({ snapshot: _s, ...s }) => s), nextAfterId: null, onlineWindowSeconds: 90 });
    for (const id of [A, B]) {
      if (req.url === `/api/servers/${id}`) return json(200, detail(id));
      if (req.url === `/api/servers/${id}/applications`) return json(200, inventory(id, [proc(id, 3, 'api')]));
      if (req.url === `/api/servers/${id}/control`) return json(200, control(id, [['api', 3]]));
      if (req.url === `/api/servers/${id}/log-targets`) return json(200, { serverId: id, state: 'supported', reportedAt: now(), targets: [] });
      if (req.url.startsWith(`/api/servers/${id}/control-commands?`)) return json(200, { items: [] });
    }
    return json(404, {});
  });
}
const table = () => screen.findByRole('table', { name: 'PM2-процеси сервера' });
const rowOf = async (name: string) => (await within(await table()).findByRole('rowheader', { name })).closest('tr') as HTMLElement;
const cells = (row: HTMLElement) => [...row.querySelectorAll('td')].map((c) => c.textContent);

describe('server page: processes on the shared projection', () => {
  it('running with current data: real values, a real zero stays zero; stopped and errored show «—», not 0', async () => {
    backend('viewer', (req) => (req.url === `/api/servers/${A}/applications` ? json(200, inventory(A, [
      proc(A, 1, 'api'), proc(A, 2, 'mailer', { status: 'stopped', cpuPercent: 0, memoryBytes: 0, uptimeSeconds: 0 }), proc(A, 3, 'worker', { status: 'errored' }),
    ])) : undefined));
    renderAt(`/servers/${A}`);
    expect(cells(await rowOf('api'))).toEqual(['1 · fork', 'Працює', '0.0 %', '96 МіБ', '12 год', '2']);
    expect(cells(await rowOf('mailer'))).toEqual(['2 · fork', 'Зупинено', '—', '—', '—', '2']);
    const worker = await rowOf('worker');
    expect(cells(worker)).toEqual(['3 · fork', 'Помилка', '—', '—', '—', '2']);
    expect(within(worker).getByText('Помилка').className).toContain('status--bad');
    expect(screen.getByText('3 сервісів · працюють 1 · потребують уваги 2')).toBeTruthy();
  });

  it.each([
    ['stale inventory', inventory(A, [proc(A, 1, 'api', { inventoryState: 'stale' })], 'stale'), 'Застаріло'],
    ['exporter unavailable', inventory(A, [proc(A, 1, 'api', { inventoryState: 'unavailable' })], 'unavailable'), 'Невідомо'],
    ['offline server', inventory(A, [proc(A, 1, 'api', { serverStatus: 'offline' })], 'current', 'offline'), 'Невідомо'],
  ])('%s: the current state is unknown, metrics «—», the last known status is named apart and not counted as working', async (_n, inv, label) => {
    backend('viewer', (req) => (req.url === `/api/servers/${A}/applications` ? json(200, inv) : undefined));
    renderAt(`/servers/${A}`);
    const row = await rowOf('api');
    expect(within(row).getByText(label).className).toContain('status--muted');
    expect(within(row).getByText('останній відомий: працює')).toBeTruthy();
    expect(within(row).queryByText('Працює')).toBeNull();
    expect(cells(row).slice(2, 5)).toEqual(['—', '—', '—']);
    expect(screen.getByText('1 сервісів · працюють 0 · стан невідомий 1')).toBeTruthy();
  });

  it('server context: signal, load and agent; offline → load «—» with the reason once; hostname only when different', async () => {
    backend('viewer', (req) => (req.url === `/api/servers/${B}` ? json(200, detail(B, { status: 'offline', lastSeenAt: ago(600) })) : undefined));
    renderAt(`/servers/${A}`);
    const load = await screen.findByRole('group', { name: 'Поточне навантаження' });
    expect(within(load).getByText('0.50 / 0.25 / 0.10')).toBeTruthy();
    expect(screen.getByText('18 с тому')).toBeTruthy();
    expect(screen.getByText('0.6.0')).toBeTruthy();
    expect(screen.queryByText(/хост alpha/)).toBeNull(); // the hostname equals the name: not repeated
    await nav.current?.(`/servers/${B}`);
    expect(await screen.findByText(/Поточне навантаження невідоме: сервер не онлайн/)).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Поточне навантаження' })).toBeNull();
    expect(screen.getByText(/хост beta\.internal/)).toBeTruthy();
    expect(screen.queryByText('0.50 / 0.25 / 0.10')).toBeNull(); // the last load of an offline server is not shown as current
  });

  it('roles: a viewer has no «Дії» column and no capability requests; an operator gets the row menu', async () => {
    const viewerCalls = backend('viewer');
    const view = renderAt(`/servers/${A}`);
    await rowOf('api');
    expect(within(await table()).queryByRole('columnheader', { name: 'Дії' })).toBeNull();
    expect(viewerCalls.some((c) => c.url.endsWith('/log-targets'))).toBe(false);
    view.unmount();
    vi.unstubAllGlobals();
    backend('operator');
    renderAt(`/servers/${A}`);
    expect(await within(await table()).findByRole('button', { name: 'Дії: api' })).toBeTruthy();
  });

  it('a double click on the confirmation sends one command; the target is re-checked and named', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', (req) => (req.method === 'POST' && req.url === `/api/servers/${A}/control-commands` ? slow.promise : undefined));
    renderAt(`/servers/${A}`);
    const user = userEvent.setup();
    await user.click(await within(await table()).findByRole('button', { name: 'Дії: api' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Перезапустити' }));
    const dialog = await screen.findByRole('dialog', { name: 'Перезапустити процес?' });
    expect(dialog.textContent).toContain('«api» (api) на сервері «alpha»');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/control-commands'))).toHaveLength(1); });
    slow.resolve(json(201, command()));
    expect(await screen.findByText(/У черзі/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/control-commands'))).toHaveLength(1);
  });
});

describe('servers list and overview: only their own requests', () => {
  it('servers list: one list request (no per-server inventory or control: no N+1); signal as age with the exact time', async () => {
    const calls = backend('admin');
    renderAt('/servers');
    const t = await screen.findByRole('table');
    const alpha = within(t).getByRole('rowheader', { name: 'alpha' }).closest('tr') as HTMLElement;
    expect(within(alpha).getByText('18 с тому')).toBeTruthy();
    expect(within(alpha).getByText('Онлайн').className).toContain('status--ok');
    const beta = within(t).getByRole('rowheader', { name: 'beta' }).closest('tr') as HTMLElement;
    expect(within(beta).getByText('10 хв тому')).toBeTruthy();
    expect(within(beta).getByText('Офлайн').className).toContain('status--bad');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => /\/api\/servers\/[^/?]+\/(applications|control|log-targets)/.test(c.url))).toEqual([]);
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Назва', 'Стан агента', 'Останній сигнал', 'Ключ агента']);
  });
});
