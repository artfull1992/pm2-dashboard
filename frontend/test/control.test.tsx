import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../src/App';
import { AuthProvider } from '../src/auth/AuthContext';
import { CSRF, deferred, installFetch, json, type RecordedRequest, session } from './support';

// Allowlisted PM2 control UI (Task 009, ADR-017).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CMD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const XSS = '<img src=x onerror="window.__pwned=1">';
const detail = (id: string, name: string) => ({
  id, name, isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online', lastSeenAt: new Date().toISOString(), hasActiveCredential: true, snapshot: null,
});
const apps = (id: string) => ({ serverId: id, serverStatus: 'online', inventory: { state: 'current', reason: null, source: 'pm2', capturedAt: null, collectedAt: null, reportedAt: null, processCount: 0 }, items: [], freshWindowSeconds: 180 });
const target = (over: Record<string, unknown> = {}) => ({ targetKey: 'api-prod', name: 'api', pmId: 3, actions: ['restart', 'stop'], matchStatus: 'ok', ...over });
const control = (id: string, over: Record<string, unknown> = {}) => ({
  serverId: id, enabled: true, serverStatus: 'online', broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: new Date().toISOString(), fresh: true },
  targets: [target()], targetFreshSeconds: 60, ...over,
});
const command = (over: Record<string, unknown> = {}) => ({
  id: CMD, serverId: A, targetKey: 'api-prod', action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
  requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0,
  before: null, after: null, ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

const nav: { current: NavigateFunction | null } = { current: null };
function Probe() {
  const navigate = useNavigate();
  useEffect(() => { nav.current = navigate; }, [navigate]);
  return null;
}
const renderAt = (path: string) => render(<AuthProvider><MemoryRouter initialEntries={[path]}><Probe /><AppRoutes /></MemoryRouter></AuthProvider>);

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'operator' | 'viewer' | 'admin', route: Route = () => undefined, controlFor: (id: string) => unknown = (id) => control(id)) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    for (const [id, name] of [[A, 'alpha'], [B, 'beta']] as const) {
      if (req.url === `/api/servers/${id}`) return json(200, detail(id, name));
      if (req.url === `/api/servers/${id}/applications`) return json(200, apps(id));
      if (req.url === `/api/servers/${id}/control`) return json(200, controlFor(id));
      if (req.url.startsWith(`/api/servers/${id}/control-commands?`)) return json(200, { items: [] });
    }
    return json(404, {});
  });
}
const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.includes('/control-commands'));
const section = async () => within(await screen.findByRole('region', { name: 'Керування PM2' }));

describe('process control on the server page', () => {
  it('viewer sees the allowlisted targets but no action buttons; names render as text', async () => {
    backend('viewer', undefined, (id) => control(id, { targets: [target({ name: XSS })] }));
    renderAt(`/servers/${A}`);
    const s = await section();
    expect(await s.findByText(XSS)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(s.queryByRole('button', { name: /Перезапустити|Зупинити|Запустити/ })).toBeNull();
  });

  it.each([
    ['control disabled in the API', { enabled: false }, /вимкнене на сервері API/],
    ['broker report stale', { broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: '2026-10-13T10:00:00.000Z', fresh: false } }, /давно не звітував/],
    ['broker unavailable', { broker: { state: 'unavailable', daemon: null, allowlist: null, reportedAt: new Date().toISOString(), fresh: true } }, /недоступний/],
    ['server offline', { serverStatus: 'offline' }, /Сервер не онлайн/],
    ['identity changed', { targets: [target({ matchStatus: 'fingerprint_mismatch', pmId: null })] }, /fingerprint/],
  ])('%s → buttons disabled with an explanation', async (_n, over, text) => {
    backend('operator', undefined, (id) => control(id, over));
    renderAt(`/servers/${A}`);
    const s = await section();
    expect(await s.findByText(text)).toBeTruthy();
    for (const b of s.getAllByRole('button', { name: /Перезапустити|Зупинити/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('confirmation names server, process and target; cancel sends nothing; confirm sends only key/action/target with CSRF', async () => {
    const calls = backend('operator', (req) => (req.method === 'POST' && req.url === `/api/servers/${A}/control-commands` ? json(201, command()) : undefined));
    renderAt(`/servers/${A}`);
    const s = await section();
    const user = userEvent.setup();
    await user.click(await s.findByRole('button', { name: 'Перезапустити' }));
    let dialog = await screen.findByRole('dialog', { name: 'Перезапустити процес?' });
    expect(dialog.textContent).toContain('«api» (api-prod) на сервері «alpha»');
    await user.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    expect(posts(calls)).toEqual([]);
    await user.click(s.getByRole('button', { name: 'Перезапустити' }));
    dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    const req = posts(calls)[0];
    expect(req?.headers.get('x-csrf-token')).toBe(CSRF);
    const body = JSON.parse(req?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['action', 'idempotencyKey', 'targetKey']);
    expect(body).toMatchObject({ targetKey: 'api-prod', action: 'restart' });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await s.findByText(/У черзі/)).toBeTruthy();
  });

  it('"accepted" is not success: success is shown only after the confirmed command status', async () => {
    let status = 'queued';
    backend('operator', (req) => {
      if (req.method === 'POST' && req.url.endsWith('/control-commands')) return json(201, command());
      if (req.url === `/api/control-commands/${CMD}`) return json(200, command({ status, ...(status === 'succeeded' ? { after: { status: 'online' }, completedAt: new Date().toISOString() } : {}) }));
      return undefined;
    });
    renderAt(`/servers/${A}`);
    const s = await section();
    const user = userEvent.setup();
    await user.click(await s.findByRole('button', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    expect(await s.findByText(/У черзі/)).toBeTruthy();
    expect(s.queryByText(/Виконано/)).toBeNull();
    status = 'dispatched';
    expect(await s.findByText(/виконується/, undefined, { timeout: 4000 })).toBeTruthy();
    status = 'succeeded';
    expect(await s.findByText(/Виконано й підтверджено/, undefined, { timeout: 4000 })).toBeTruthy();
  });

  it('unknown result is explained honestly', async () => {
    backend('operator', (req) => {
      if (req.method === 'POST' && req.url.endsWith('/control-commands')) return json(201, command({ status: 'dispatched', attempts: 1, dispatchedAt: new Date().toISOString() }));
      if (req.url === `/api/control-commands/${CMD}`) return json(200, command({ status: 'unknown', reason: 'timeout', completedAt: new Date().toISOString() }));
      return undefined;
    });
    renderAt(`/servers/${A}`);
    const s = await section();
    const user = userEvent.setup();
    await user.click(await s.findByRole('button', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    expect(await s.findByText(/Результат невідомий .*дія могла виконатися/, undefined, { timeout: 4000 })).toBeTruthy();
  });

  it('errors: 409 is explained and not retried; a lost response can be retried explicitly with the SAME key', async () => {
    let mode: 'conflict' | 'down' | 'ok' = 'conflict';
    const calls = backend('operator', (req) => {
      if (req.method !== 'POST' || !req.url.endsWith('/control-commands')) return undefined;
      if (mode === 'conflict') return json(409, {});
      if (mode === 'down') return json(503, {}, { 'retry-after': '3' });
      return json(200, command());
    });
    renderAt(`/servers/${A}`);
    const s = await section();
    const user = userEvent.setup();
    await user.click(await s.findByRole('button', { name: 'Перезапустити' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(posts(calls)).toHaveLength(1); // no automatic retry
    mode = 'down';
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    expect(await within(dialog).findByText(/повторна спроба в цьому ж вікні не створить дубліката/)).toBeTruthy();
    mode = 'ok';
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    const keys = posts(calls).map((c) => (JSON.parse(c.body ?? '{}') as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('A → B while a request for A is pending: it is aborted and nothing of A appears on B', async () => {
    const slow = deferred<Response>();
    const calls = backend('operator', (req) => (req.method === 'POST' && req.url === `/api/servers/${A}/control-commands` ? slow.promise : undefined));
    renderAt(`/servers/${A}`);
    const s = await section();
    const user = userEvent.setup();
    await user.click(await s.findByRole('button', { name: 'Перезапустити' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Перезапустити' }));
    await act(async () => { await nav.current?.(`/servers/${B}`); });
    expect(await screen.findByRole('heading', { name: 'beta' })).toBeTruthy();
    expect(posts(calls)[0]?.signal?.aborted).toBe(true);
    await act(async () => { slow.resolve(json(201, command())); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/У черзі/)).toBeNull();
  });
});
