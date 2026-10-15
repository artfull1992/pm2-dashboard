import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlTarget } from '../src/api/types';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import { CommandStatusList, type CommandRequest, LIMIT_TEXT, MAX_ACTIVE_COMMANDS, MAX_FINISHED_COMMANDS, useProcessCommands } from '../src/components/processActions';
import { CSRF, installFetch, json, type RecordedRequest, session } from './support';

// Command tracking limits of the shared hook (used by the server page and the applications list): an accepted,
// unfinished command is never dropped for a newer one; at the limit no POST is sent; a final status frees the slot;
// only finished history is trimmed.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target = (key: string): ControlTarget => ({ targetKey: key, name: key, pmId: 1, actions: ['restart'], matchStatus: 'ok' });
const req = (key: string, serverId = A): CommandRequest => ({ serverId, serverName: serverId === A ? 'alpha' : 'beta', target: target(key), action: 'restart' });

let status: Map<string, string>;
let ids: Map<string, string>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const view = (cid: string, serverId: string, targetKey: string) => ({
  id: cid, serverId, targetKey, action: 'restart', status: status.get(cid) ?? 'queued', reason: status.get(cid) === 'unknown' ? 'timeout' : null,
  requestedBy: '00000000-0000-4000-8000-000000000001', requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: status.get(cid) === 'succeeded' ? { status: 'online' } : null,
});
const meta = new Map<string, { serverId: string; targetKey: string }>();

function backend() {
  return installFetch((r) => {
    if (r.url === '/api/auth/me') return json(200, session('operator'));
    if (r.url === '/api/auth/logout') return new Response(null, { status: 204 });
    const post = /^\/api\/servers\/([^/]+)\/control-commands$/.exec(r.url);
    if (post && r.method === 'POST') {
      const body = JSON.parse(r.body ?? '{}') as { targetKey: string; idempotencyKey: string };
      // Same idempotency key → the same command (as the API does).
      let cid = ids.get(body.idempotencyKey);
      if (!cid) { cid = id(ids.size + 1); ids.set(body.idempotencyKey, cid); meta.set(cid, { serverId: post[1] ?? '', targetKey: body.targetKey }); }
      const m = meta.get(cid);
      return json(201, view(cid, m?.serverId ?? '', m?.targetKey ?? ''));
    }
    const get = /^\/api\/control-commands\/(.+)$/.exec(r.url);
    if (get) { const m = meta.get(get[1] ?? ''); return json(200, view(get[1] ?? '', m?.serverId ?? '', m?.targetKey ?? '')); }
    return json(404, {});
  });
}
const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/control-commands'));
const reads = (calls: RecordedRequest[], cid: string) => calls.filter((c) => c.url === `/api/control-commands/${cid}`).length;

const noop = () => undefined;
const api: { ask: (r: CommandRequest) => void; busy: (s: string, t: string) => boolean; logout: () => Promise<unknown> } = { ask: noop, busy: () => false, logout: () => Promise.resolve() };
function Harness() {
  const { ask, dialog, tracked, isBusy, limitReached } = useProcessCommands({ onChanged: () => undefined });
  const { logout } = useAuth();
  useEffect(() => { api.ask = ask; api.busy = isBusy; api.logout = logout; });
  return <><p data-testid="limit">{String(limitReached)}</p><CommandStatusList tracked={tracked} showServer />{dialog}</>;
}
function App() { const { state } = useAuth(); return state.status === 'authenticated' ? <Harness /> : <p>anon</p>; }

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  status = new Map(); ids = new Map(); meta.clear(); api.ask = noop;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const tick = async (ms = 2100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const lines = () => screen.queryAllByRole('status').map((s) => s.textContent);
async function accept(key: string, serverId = A) {
  act(() => { api.ask(req(key, serverId)); });
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
}
async function mount() {
  const calls = backend();
  render(<AuthProvider><App /></AuthProvider>);
  await screen.findByTestId('limit');
  await waitFor(() => { expect(api.ask).not.toBe(noop); });
  return calls;
}

describe('command tracking limits', () => {
  it('at the limit nothing is dropped and no POST is sent; the first command keeps polling; a final status frees the slot', async () => {
    const calls = await mount();
    for (let i = 0; i < MAX_ACTIVE_COMMANDS; i++) await accept(`t${String(i)}`);
    expect(screen.getByTestId('limit').textContent).toBe('true');
    expect(lines()).toHaveLength(MAX_ACTIVE_COMMANDS);

    // A sixth command: refused before the POST, with the reason; the dialog stays open (same key for a later retry).
    act(() => { api.ask(req('t5')); });
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    expect(within(dialog).getByRole('alert').textContent).toBe(`${LIMIT_TEXT}. Команду не надіслано.`);
    expect(posts(calls)).toHaveLength(MAX_ACTIVE_COMMANDS);
    expect(lines()).toHaveLength(MAX_ACTIVE_COMMANDS);
    expect(lines().some((l) => l.includes('«t0»'))).toBe(true);
    expect(api.busy(A, 't0')).toBe(true);

    // The first command is still followed.
    const before = reads(calls, id(1));
    await tick();
    expect(reads(calls, id(1))).toBeGreaterThan(before);

    // Polling errors never free a slot (no invented final status).
    status.set(id(1), 'queued');
    expect(screen.getByTestId('limit').textContent).toBe('true');

    // t0 succeeds → the slot is free → the explicit retry in the same dialog is accepted, once.
    status.set(id(1), 'succeeded');
    await tick();
    await waitFor(() => { expect(screen.getByTestId('limit').textContent).toBe('false'); });
    expect(api.busy(A, 't0')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(posts(calls)).toHaveLength(MAX_ACTIVE_COMMANDS + 1);
    expect(lines().filter((l) => l.includes('Виконано'))).toHaveLength(1);
    expect(lines()).toHaveLength(MAX_ACTIVE_COMMANDS + 1);
    expect(screen.getByTestId('limit').textContent).toBe('true');
  });

  it('only the finished history is trimmed: active commands always stay', async () => {
    await mount();
    // Many commands finish one after another while others are still active.
    for (let i = 0; i < 8; i++) {
      await accept(`f${String(i)}`);
      status.set(id(i + 1), 'succeeded');
      await tick();
    }
    await accept('a0');
    await accept('a1');
    await tick();
    const shown = lines();
    expect(shown.filter((l) => l.includes('Виконано'))).toHaveLength(MAX_FINISHED_COMMANDS);
    expect(shown.filter((l) => l.includes('У черзі'))).toHaveLength(2);
    expect(shown.some((l) => l.includes('«f7»'))).toBe(true); // the newest finished ones are kept
    expect(shown.some((l) => l.includes('«f0»'))).toBe(false);
    expect(api.busy(A, 'a0') && api.busy(A, 'a1')).toBe(true);
  });

  it('a double click sends one POST; an explicit retry after a lost answer reuses the key and adds no duplicate', async () => {
    let lose = true;
    const calls = backend();
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const p = original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/control-commands') && init?.method === 'POST' && lose ? p.then(() => json(503, {})) : p;
    }));
    render(<AuthProvider><App /></AuthProvider>);
    await screen.findByTestId('limit');
    await waitFor(() => { expect(api.ask).not.toBe(noop); });
    act(() => { api.ask(req('dup')); });
    const dialog = await screen.findByRole('dialog');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await within(dialog).findByText(/команда могла бути створена/);
    expect(posts(calls)).toHaveLength(1); // the command was created, the answer was lost
    lose = false;
    await user.click(within(dialog).getByRole('button', { name: 'Перезапустити' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    const keys = posts(calls).map((c) => (JSON.parse(c.body ?? '{}') as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(lines()).toHaveLength(1);
    expect(posts(calls)[0]?.headers.get('x-csrf-token')).toBe(CSRF);
  });

  it('busy is per serverId + targetKey: the same key on another server stays free; unknown outcome is final and frees the slot', async () => {
    await mount();
    await accept('same', A);
    expect(api.busy(A, 'same')).toBe(true);
    expect(api.busy(B, 'same')).toBe(false);
    await accept('same', B);
    expect(api.busy(B, 'same')).toBe(true);
    status.set(id(1), 'unknown');
    await tick();
    await waitFor(() => { expect(api.busy(A, 'same')).toBe(false); });
    expect(api.busy(B, 'same')).toBe(true);
    expect(lines().some((l) => /Результат невідомий/.test(l))).toBe(true);
  });

  it('logout ends the session: tracking stops, nothing is followed any more', async () => {
    const calls = await mount();
    await accept('t0');
    await tick();
    await act(async () => { await api.logout(); });
    expect(await screen.findByText('anon')).toBeTruthy();
    const after = reads(calls, id(1));
    await tick(6000);
    expect(reads(calls, id(1))).toBe(after);
  });
});
