import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF, deferred, installFetch, json, type RecordedRequest, renderApp, session } from './support';

// Unified frontend layout (design task): permission-aware grouped navigation, profile block, mobile menu, and the
// lifecycle of create dialogs (focus, Escape, unsaved input, pending, unknown result, late answers).

const ID = '11111111-1111-4111-8111-111111111111';
const server = (over: Record<string, unknown> = {}) => ({
  id: ID, name: 'web-01', isActive: true, createdAt: '2026-10-12T10:00:00.000Z', status: 'online',
  lastSeenAt: '2026-10-12T10:05:00.000Z', hasActiveCredential: false, ...over,
});
const page = (items: unknown[]) => ({ items, nextAfterId: null, onlineWindowSeconds: 90 });
const dashboard = {
  generatedAt: '2026-10-15T10:00:00.000Z', windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
  servers: { active: 0, inactive: 0, online: 0, offline: 0, neverConnected: 0 }, inventory: { current: 0, stale: 0, unavailable: 0, notReported: 0 },
  processes: { live: { total: 0, online: 0, transitional: 0, problem: 0 }, notLive: 0 },
  attentionServers: { items: [], total: 0, limit: 20 }, attentionProcesses: { items: [], total: 0, limit: 20 },
  serverList: { items: [], total: 0, limit: 50 }, recentActions: null,
};

afterEach(() => { vi.unstubAllGlobals(); });

function backend(role: 'admin' | 'operator' | 'viewer', route: (req: RecordedRequest) => Response | Promise<Response> | undefined = () => undefined) {
  return installFetch((req) => {
    const custom = route(req);
    if (custom) return custom;
    if (req.url === '/api/auth/me' || req.url === '/api/auth/login') return json(200, session(role));
    if (req.url === '/api/auth/logout') return new Response(null, { status: 204 });
    if (req.url.startsWith('/api/dashboard')) return json(200, dashboard);
    if (req.url.startsWith('/api/servers')) return json(200, page([]));
    return json(404, {});
  });
}

const nav = () => screen.getByRole('navigation', { name: 'Основна навігація' });
const links = (list: HTMLElement) => within(list).getAllByRole('link').map((a) => a.textContent);

describe('navigation', () => {
  it('admin: two groups in the agreed order; the account lives in the profile block, not in the navigation', async () => {
    backend('admin');
    renderApp('/');
    await screen.findByRole('heading', { name: 'Огляд' });
    expect(links(within(nav()).getByRole('list', { name: 'Моніторинг' }))).toEqual(['Огляд', 'Сервери', 'Застосунки', 'Сповіщення']);
    expect(links(within(nav()).getByRole('list', { name: 'Адміністрування' }))).toEqual(['Користувачі', 'Журнал аудиту', 'Налаштування']);
    expect(within(nav()).queryByRole('link', { name: 'Обліковий запис' })).toBeNull();
    const profile = screen.getByRole('group', { name: 'Обліковий запис користувача' });
    expect(within(profile).getByText('admin@example.test')).toBeTruthy();
    expect(within(profile).getByText('Адміністратор')).toBeTruthy();
    expect(within(profile).getByRole('link', { name: 'Обліковий запис' })).toBeTruthy();
    expect(within(profile).getByRole('button', { name: 'Вийти' })).toBeTruthy();
  });

  it.each([
    ['operator', ['Огляд', 'Сервери', 'Застосунки', 'Сповіщення']],
    ['viewer', ['Огляд', 'Сервери', 'Застосунки', 'Сповіщення']],
  ] as const)('%s: only permitted sections; the empty administration group is not rendered', async (role, monitoring) => {
    backend(role);
    renderApp('/');
    await screen.findByRole('heading', { name: 'Огляд' });
    expect(links(within(nav()).getByRole('list', { name: 'Моніторинг' }))).toEqual([...monitoring]);
    expect(within(nav()).queryByRole('list', { name: 'Адміністрування' })).toBeNull();
    expect(screen.queryByText('Адміністрування')).toBeNull();
    for (const hidden of ['Користувачі', 'Журнал аудиту', 'Налаштування']) expect(screen.queryByRole('link', { name: hidden })).toBeNull();
  });

  it('mobile menu: the toggle reports its state; Escape closes it and returns focus to the toggle', async () => {
    backend('viewer');
    renderApp('/');
    await screen.findByRole('heading', { name: 'Огляд' });
    const u = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'Меню' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')?.className).toBe('sidebar');
    await u.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')?.className).toContain('sidebar--open');
    await u.keyboard('{Escape}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });
});

describe('create dialog lifecycle (servers)', () => {
  it('focus moves into the form and returns to the opener; Escape on a clean form closes without a request', async () => {
    const calls = backend('admin');
    renderApp('/servers');
    const u = userEvent.setup();
    const opener = await screen.findByRole('button', { name: 'Додати сервер' });
    await u.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Назва нового сервера'));
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('Tab stays inside the dialog', async () => {
    backend('admin');
    renderApp('/servers');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    const dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    for (let i = 0; i < 6; i++) {
      await u.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('unsaved input is never dropped silently: closing asks first, "back" keeps the text, discard closes', async () => {
    const calls = backend('admin');
    renderApp('/servers');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    let dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    await u.type(within(dialog).getByLabelText('Назва нового сервера'), 'draft-01');
    await u.keyboard('{Escape}');
    expect(screen.getByRole('alert').textContent).toContain('не збережено');
    await u.click(screen.getByRole('button', { name: 'Повернутися до форми' }));
    dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Назва нового сервера').value).toBe('draft-01');
    await u.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    await u.click(screen.getByRole('button', { name: 'Закрити без збереження' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('pending: one request, Escape and Cancel do nothing until the answer; success closes and names the server', async () => {
    const answer = deferred<Response>();
    const calls = backend('admin', (req) => (req.method === 'POST' ? answer.promise : undefined));
    renderApp('/servers');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    const dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    await u.type(within(dialog).getByLabelText('Назва нового сервера'), 'web-01');
    await u.click(within(dialog).getByRole('button', { name: 'Додати' }));
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Додавання…' }).disabled).toBe(true);
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Скасувати' }).disabled).toBe(true);
    await u.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Новий сервер' })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'POST')?.headers.get('x-csrf-token')).toBe(CSRF);
    await act(async () => { answer.resolve(json(201, server({ status: 'never_connected', lastSeenAt: null }))); await Promise.resolve(); });
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByRole('status').textContent).toContain('Сервер «web-01» додано');
    expect(screen.getByRole('link', { name: 'Відкрити' }).getAttribute('href')).toBe(`/servers/${ID}`);
  });

  it('no answer (network): the result is called unknown, the list is re-read, nothing is retried', async () => {
    const calls = backend('admin', (req) => (req.method === 'POST' ? Promise.reject(new TypeError('network down')) : undefined));
    renderApp('/servers');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    const dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    await u.type(within(dialog).getByLabelText('Назва нового сервера'), 'web-02');
    const reads = calls.filter((c) => c.url.startsWith('/api/servers?')).length;
    await u.click(within(dialog).getByRole('button', { name: 'Додати' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('сервер міг бути створений');
    await waitFor(() => { expect(calls.filter((c) => c.url.startsWith('/api/servers?')).length).toBeGreaterThan(reads); });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a late answer after leaving the page changes nothing (no notice, no reload of an abandoned view)', async () => {
    const answer = deferred<Response>();
    const calls = backend('admin', (req) => (req.method === 'POST' ? answer.promise : undefined));
    renderApp('/servers');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    const dialog = screen.getByRole('dialog', { name: 'Новий сервер' });
    await u.type(within(dialog).getByLabelText('Назва нового сервера'), 'web-03');
    await u.click(within(dialog).getByRole('button', { name: 'Додати' }));
    const post = calls.find((c) => c.method === 'POST');
    // Leaving the page while pending (the menu is behind the modal in a browser; here the route changes directly).
    await u.click(screen.getByRole('link', { name: 'Огляд' }));
    await screen.findByRole('heading', { name: 'Огляд' });
    expect(post?.signal?.aborted).toBe(true);
    const reads = calls.filter((c) => c.url.startsWith('/api/servers?')).length;
    await act(async () => { answer.resolve(json(201, server({ name: 'web-03' }))); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText(/web-03/)).toBeNull();
    expect(calls.filter((c) => c.url.startsWith('/api/servers?')).length).toBe(reads);
  });
});
