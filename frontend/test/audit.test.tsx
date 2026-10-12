import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetch, json, renderApp, session } from './support';

afterEach(() => { vi.unstubAllGlobals(); });

function item(id: number, extra: Record<string, unknown> = {}) {
  return {
    id: String(id), occurredAt: '2026-10-12T10:00:00.000Z', event: 'auth.login', outcome: 'success',
    actorUserId: '00000000-0000-4000-8000-000000000000', requestId: '11111111-1111-4111-8111-111111111111', details: {}, ...extra,
  };
}

function auditBackend(pages: Record<string, unknown>, fallback: (url: string) => Response = () => json(500, {})) {
  return installFetch((req) => {
    if (req.url === '/api/auth/me') return json(200, session('admin'));
    const page = pages[req.url];
    return page ? json(200, page) : fallback(req.url);
  });
}

describe('audit log page', () => {
  it('loads newest-first and pages older events with the keyset cursor', async () => {
    const calls = auditBackend({
      '/api/audit?limit=25': { items: [item(3), item(2)], nextBeforeId: '2' },
      '/api/audit?limit=25&beforeId=2': { items: [item(1, { event: 'auth.logout' })], nextBeforeId: null },
    });
    renderApp('/audit');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    await userEvent.setup().click(screen.getByRole('button', { name: 'Показати старіші' }));
    await waitFor(() => { expect(within(table).getAllByRole('row')).toHaveLength(4); });
    expect(screen.queryByRole('button', { name: 'Показати старіші' })).toBeNull();
    expect(screen.getByText('Вихід')).toBeTruthy();
    expect(calls.filter((c) => c.url.startsWith('/api/audit')).map((c) => c.url)).toEqual(['/api/audit?limit=25', '/api/audit?limit=25&beforeId=2']);
  });

  it('shows labels, actor/request IDs and safe details as text', async () => {
    auditBackend({
      '/api/audit?limit=25': {
        items: [item(5, { event: 'authz.denied', outcome: 'denied', details: { permission: 'audit:read', route: '/api/audit' } }),
          item(4, { outcome: 'failure', actorUserId: null, details: { reason: 'invalid_credentials' } })],
        nextBeforeId: null,
      },
    });
    renderApp('/audit');
    expect(await screen.findByText('Відмова в доступі')).toBeTruthy();
    expect(screen.getByText('дозвіл: audit:read; маршрут: /api/audit')).toBeTruthy();
    expect(screen.getByText('причина: невірні облікові дані')).toBeTruthy();
    expect(screen.getAllByText('11111111-1111-4111-8111-111111111111')).toHaveLength(2);
  });

  it('never renders HTML from the API', async () => {
    const payload = '<img src=x onerror="window.__xss=1">';
    auditBackend({ '/api/audit?limit=25': { items: [item(1, { event: payload, details: { route: payload } })], nextBeforeId: null } });
    const { container } = renderApp('/audit');
    expect(await screen.findByText(payload)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('empty state', async () => {
    auditBackend({ '/api/audit?limit=25': { items: [], nextBeforeId: null } });
    renderApp('/audit');
    expect(await screen.findByRole('heading', { name: 'Подій ще немає' })).toBeTruthy();
  });

  it('error state with Retry-After and a working retry', async () => {
    let fail = true;
    installFetch((req) => {
      if (req.url === '/api/auth/me') return json(200, session('admin'));
      return fail ? json(503, {}, { 'retry-after': '10' }) : json(200, { items: [item(1)], nextBeforeId: null });
    });
    renderApp('/audit');
    expect((await screen.findByRole('alert')).textContent).toContain('Спробуйте через 10 с.');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('403 from the API (role changed server-side) → forbidden, not an error', async () => {
    auditBackend({}, () => json(403, {}));
    renderApp('/audit');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
  });

  it('401 from the API → session cleared, back to login', async () => {
    auditBackend({}, () => json(401, {}));
    renderApp('/audit');
    expect(await screen.findByText('Сесія завершилась. Увійдіть знову.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
