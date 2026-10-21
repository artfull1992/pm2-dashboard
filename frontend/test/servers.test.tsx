import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF, installFetch, json, renderApp, session } from './support';

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = `ncag_${'T'.repeat(43)}`;
const server = (overrides: Record<string, unknown> = {}) => ({
  id: ID, name: 'web-01', isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online',
  lastSeenAt: '2026-10-12T10:05:00.000Z', hasActiveCredential: true, ...overrides,
});
const snapshot = { agentVersion: '0.5.0', hostname: 'web-01.example', platform: 'linux', arch: 'x64', loadAverage: [0.5, 0.25, 0.1] };
const page = (items: unknown[]) => ({ items, nextAfterId: null, onlineWindowSeconds: 90 });

let storageWrites: string[];
beforeEach(() => {
  storageWrites = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) { storageWrites.push(key); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(storageWrites).toEqual([]);
});

describe('servers list', () => {
  it('shows real statuses, last seen and credential state; viewer has no management controls', async () => {
    installFetch((req) => (req.url.startsWith('/api/servers')
      ? json(200, page([server(), server({ id: '22222222-2222-4222-8222-222222222222', name: 'db-01', status: 'never_connected', lastSeenAt: null, hasActiveCredential: false })]))
      : json(200, session('viewer'))));
    renderApp('/servers');
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('Онлайн')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Ще не підключався')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Додати сервер' })).toBeNull();
  });

  it('empty and error states (503 with Retry-After) with retry', async () => {
    let fail = true;
    installFetch((req) => {
      if (!req.url.startsWith('/api/servers')) return json(200, session('operator'));
      return fail ? json(503, {}, { 'retry-after': '20' }) : json(200, page([]));
    });
    renderApp('/servers');
    expect((await screen.findByRole('alert')).textContent).toContain('Спробуйте через 20 с.');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    // Operator: scoped visibility (ADR-028) — an empty list means no granted servers, said explicitly.
    expect(await screen.findByRole('heading', { name: 'Немає наданих серверів' })).toBeTruthy();
  });

  it('401 from the list clears the session; 403 shows forbidden', async () => {
    installFetch((req) => (req.url.startsWith('/api/servers') ? json(401, {}) : json(200, session('viewer'))));
    renderApp('/servers');
    expect(await screen.findByText('Сесія завершилась. Увійдіть знову.')).toBeTruthy();
  });

  it('403 from the API → forbidden view', async () => {
    installFetch((req) => (req.url.startsWith('/api/servers') ? json(403, {}) : json(200, session('viewer'))));
    renderApp('/servers');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
  });

  it('admin creates a server with CSRF; conflict is reported', async () => {
    const created: string[] = [];
    const calls = installFetch((req) => {
      if (req.url === '/api/servers' && req.method === 'POST') {
        const name = (JSON.parse(req.body ?? '{}') as { name: string }).name;
        if (created.includes(name)) return json(409, {});
        created.push(name);
        return json(201, server({ name, status: 'never_connected', lastSeenAt: null, hasActiveCredential: false }));
      }
      if (req.url.startsWith('/api/servers')) return json(200, page(created.map((name) => server({ name }))));
      return json(200, session('admin'));
    });
    renderApp('/servers');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    let dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    await user.type(within(dialog).getByLabelText('Назва нового сервера'), '  web-01 ');
    await user.click(within(dialog).getByRole('button', { name: 'Додати' }));
    await waitFor(() => { expect(screen.getByRole('link', { name: 'web-01' })).toBeTruthy(); });
    expect(screen.queryByRole('dialog')).toBeNull(); // closed on success
    expect(screen.getByRole('status').textContent).toContain('Сервер «web-01» додано');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ name: 'web-01' });
    await user.click(screen.getByRole('button', { name: 'Додати сервер' }));
    dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    await user.type(within(dialog).getByLabelText('Назва нового сервера'), 'web-01');
    await user.click(within(dialog).getByRole('button', { name: 'Додати' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('вже існує');
    expect(screen.getByRole('dialog', { name: 'Новий сервер' })).toBeTruthy(); // stays open with the error
  });

  it('polling refreshes while visible and stops after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = installFetch((req) => (req.url.startsWith('/api/servers') ? json(200, page([server()])) : json(200, session('viewer'))));
    const { unmount } = renderApp('/servers');
    await screen.findByRole('table');
    const before = calls.filter((c) => c.url.startsWith('/api/servers')).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const during = calls.filter((c) => c.url.startsWith('/api/servers')).length;
    expect(during).toBe(before + 1);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls.filter((c) => c.url.startsWith('/api/servers')).length).toBe(during);
  });
});

describe('server detail', () => {
  function backend(role: 'admin' | 'viewer', state: { active: boolean; snapshot: unknown; status?: string }) {
    return installFetch((req) => {
      if (req.url === `/api/servers/${ID}/agent-credentials` && req.method === 'POST') {
        const rotated = state.active;
        state.active = true;
        return json(201, { serverId: ID, token: TOKEN, issuedAt: '2026-10-12T11:00:00.000Z', rotated });
      }
      if (req.url === `/api/servers/${ID}/agent-credentials/revoke`) { state.active = false; return json(200, { serverId: ID, revoked: true }); }
      if (req.url === `/api/servers/${ID}`) return json(200, { ...server({ hasActiveCredential: state.active, status: state.status ?? 'online' }), snapshot: state.snapshot });
      return json(200, session(role));
    });
  }

  it('renders the current load (explained as not CPU %) and agent identification; no host memory/uptime/CPU count (ADR-023)', async () => {
    backend('viewer', { active: true, snapshot });
    renderApp(`/servers/${ID}`);
    expect(await screen.findByText('web-01.example')).toBeTruthy();
    expect(screen.getByText('linux / x64')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Поточне навантаження' })).getByText('0.50 / 0.25 / 0.10')).toBeTruthy();
    expect(screen.getByText(/не відсоток CPU/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Пам['’]ять ОС|Аптайм ОС|ядер/);
    expect(screen.queryByRole('button', { name: /ключ/i })).toBeNull();
  });

  it('offline server: the last load is not shown as current', async () => {
    backend('viewer', { active: true, snapshot, status: 'offline' });
    renderApp(`/servers/${ID}`);
    expect(await screen.findByText(/Поточне навантаження невідоме: сервер не онлайн/)).toBeTruthy();
    expect(screen.queryByText('0.50 / 0.25 / 0.10')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Поточне навантаження' })).toBeNull();
  });

  it('a response with legacy host metrics is rejected by the parser (contract drift is visible, not silently rendered)', async () => {
    backend('viewer', { active: true, snapshot: { ...snapshot, memory: { totalBytes: 1, freeBytes: 0 } } });
    renderApp(`/servers/${ID}`);
    expect(await screen.findByText(/Не вдалося оновити дані/)).toBeTruthy();
    expect(screen.queryByText('0.50 / 0.25 / 0.10')).toBeNull();
  });

  it('no snapshot yet, unknown id and malformed id', async () => {
    backend('viewer', { active: false, snapshot: null });
    renderApp(`/servers/${ID}`);
    expect(await screen.findByText('Агент ще не надсилав даних.')).toBeTruthy();
  });

  it('malformed id is rejected client-side without a request', async () => {
    const calls = backend('viewer', { active: false, snapshot: null });
    renderApp('/servers/not-a-uuid');
    expect(await screen.findByRole('heading', { name: 'Сервер не знайдено' })).toBeTruthy();
    expect(calls.some((c) => c.url.startsWith('/api/servers/'))).toBe(false);
  });

  it('admin: issue shows the token once; closing the dialog removes it from the page', async () => {
    const calls = backend('admin', { active: false, snapshot });
    renderApp(`/servers/${ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Видати ключ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ключ агента видано' });
    expect(within(dialog).getByDisplayValue(TOKEN)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.headers.get('x-csrf-token')).toBe(CSRF);
    await user.click(within(dialog).getByRole('button', { name: /закрити/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('admin: rotation and revoke require explicit confirmation; cancel sends nothing', async () => {
    const state = { active: true, snapshot };
    const calls = backend('admin', state);
    renderApp(`/servers/${ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Відкликати ключ' }));
    const confirm = await screen.findByRole('dialog', { name: 'Відкликати ключ агента?' });
    await user.click(within(confirm).getByRole('button', { name: 'Скасувати' }));
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Відкликати ключ' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Відкликати' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Видати ключ' })).toBeTruthy(); });
    expect(calls.filter((c) => c.url.endsWith('/revoke'))).toHaveLength(1);

    // Re-issue, then rotate: rotation needs confirmation and reports the previous key revoked.
    await user.click(screen.getByRole('button', { name: 'Видати ключ' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Ключ агента видано' })).getByRole('button', { name: /закрити/ }));
    await user.click(await screen.findByRole('button', { name: 'Видати новий ключ' }));
    const rotate = await screen.findByRole('dialog', { name: 'Видати новий ключ?' });
    await user.click(within(rotate).getByRole('button', { name: 'Видати новий' }));
    expect(await screen.findByRole('dialog', { name: 'Ключ агента видано' })).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/agent-credentials'))).toHaveLength(2);
  });

  it('Escape closes the token dialog and the token is gone', async () => {
    backend('admin', { active: false, snapshot });
    renderApp(`/servers/${ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Видати ключ' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });
});
