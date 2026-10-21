import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF, deferred, installFetch, json, type RecordedRequest, renderApp, session } from './support';

// Users → «Доступи» (ADR-028): per-server grants of operators/viewers, saved atomically with the revision they were
// based on; admin is shown as full access; nothing is reported as saved before the API answers.

const ADMIN_ID = '00000000-0000-4000-8000-000000000000';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN2_ID = '22222222-2222-4222-8222-222222222222';
const ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = (id: string, email: string, role: string) => ({ id, email, role, isActive: true, createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z' });
const access = (over: Record<string, unknown> = {}) => ({ userId: OTHER_ID, email: 'other@example.test', role: 'viewer', isActive: true, global: false, revision: 0, servers: [], ...over });
const grant = (serverId: string, serverName: string, mode: 'all' | 'selected', services: { name: string; available: boolean }[] = []) =>
  ({ serverId, serverName, serverActive: true, mode, grantedAt: '2026-10-20T10:00:00.000Z', services });

afterEach(() => { vi.unstubAllGlobals(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route = () => undefined, initial = access()) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session('admin'));
    if (req.url.startsWith('/api/users?')) {
      return json(200, { items: [user(ADMIN_ID, 'admin@example.test', 'admin'), user(OTHER_ID, 'other@example.test', 'viewer'), user(ADMIN2_ID, 'boss@example.test', 'admin')], nextAfter: null });
    }
    if (req.url === `/api/users/${OTHER_ID}/access` && req.method === 'GET') return json(200, initial);
    if (req.url.startsWith('/api/access/servers?')) return json(200, { items: [{ id: ALPHA, name: 'alpha', isActive: true }, { id: BETA, name: 'beta', isActive: false }], nextAfterName: null });
    if (req.url.startsWith(`/api/access/servers/${ALPHA}/services`)) {
      return json(200, { serverId: ALPHA, items: [{ name: 'api', processes: 1 }, { name: 'worker', processes: 1 }], truncated: false });
    }
    return json(404, {});
  });
}
const puts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'PUT');

async function open(email = 'other@example.test') {
  const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: `Дії: ${email}` }));
  await u.click(screen.getByRole('menuitem', { name: 'Доступи' }));
  return u;
}

describe('access editor', () => {
  it('table says who has full access; the editor of an admin only explains global access (no save)', async () => {
    backend();
    renderApp('/users');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByText('Повний доступ')).toHaveLength(2);
    expect(within(table).getByText('За наданими доступами')).toBeTruthy();
    installFetch((req) => {
      if (req.url === `/api/users/${ADMIN2_ID}/access`) return json(200, access({ userId: ADMIN2_ID, email: 'boss@example.test', role: 'admin', global: true }));
      if (req.url.startsWith('/api/users?')) return json(200, { items: [user(ADMIN2_ID, 'boss@example.test', 'admin')], nextAfter: null });
      return json(200, session('admin'));
    });
    await open('boss@example.test');
    const dialog = await screen.findByRole('dialog', { name: 'Доступи: boss@example.test' });
    expect(await within(dialog).findByText(/до всіх серверів і сервісів, включно з майбутніми/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Зберегти доступи' })).toBeNull();
  });

  it('add a server, pick services; an empty selection is refused locally; PUT carries revision + CSRF; success only after the answer', async () => {
    const reply = deferred<Response>();
    const calls = backend((req) => (req.method === 'PUT' ? reply.promise : undefined));
    renderApp('/users');
    const u = await open();
    const dialog = await screen.findByRole('dialog', { name: 'Доступи: other@example.test' });
    expect(await within(dialog).findByText(/Доступів немає/)).toBeTruthy();
    await u.click(await within(dialog).findByRole('button', { name: 'Додати alpha' }));
    expect(within(dialog).getByText('неактивний')).toBeTruthy(); // beta is offered, marked inactive
    expect(within(dialog).queryByRole('button', { name: 'Додати alpha' })).toBeNull(); // not offered twice
    await u.click(within(dialog).getByRole('button', { name: 'Зберегти доступи' }));
    expect(within(dialog).getByText('Виберіть хоча б один сервіс або приберіть сервер.')).toBeTruthy();
    expect(puts(calls)).toHaveLength(0);
    await u.click(await within(dialog).findByRole('checkbox', { name: 'api' }));
    expect(within(dialog).getByText('Вибрано: 1')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Зберегти доступи' }));
    expect(within(dialog).getByRole('button', { name: 'Збереження…' })).toBeTruthy();
    expect(screen.queryByText(/збережено/)).toBeNull(); // nothing claimed before the API answers
    const sent = puts(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`/api/users/${OTHER_ID}/access`);
    expect(sent[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ expectedRevision: 0, servers: [{ serverId: ALPHA, mode: 'selected', services: ['api'] }] });
    reply.resolve(json(200, access({ revision: 1, servers: [grant(ALPHA, 'alpha', 'selected', [{ name: 'api', available: true }])] })));
    expect(await screen.findByText(/Доступи other@example\.test збережено: серверів — 1/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('existing grants: a gone service is marked unavailable (never a wildcard); switching to "all" sends no names; remove a server', async () => {
    const calls = backend((req) => (req.method === 'PUT' ? json(200, access({ revision: 4 })) : undefined), access({
      revision: 3, servers: [grant(ALPHA, 'alpha', 'selected', [{ name: 'api', available: true }, { name: 'old-job', available: false }]), grant(BETA, 'beta', 'all')],
    }));
    renderApp('/users');
    const u = await open();
    const dialog = await screen.findByRole('dialog', { name: 'Доступи: other@example.test' });
    expect(await within(dialog).findByText('недоступний: зник із сервера')).toBeTruthy();
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: /old-job/ }).checked).toBe(true);
    const radios = within(dialog).getAllByRole<HTMLInputElement>('radio', { name: 'Усі сервіси (поточні й майбутні)' });
    expect(radios[1]?.checked).toBe(true); // beta: all
    await u.click(radios[0] as HTMLInputElement); // alpha → all
    await u.click(within(dialog).getByRole('button', { name: 'Прибрати beta' }));
    await u.click(within(dialog).getByRole('button', { name: 'Зберегти доступи' }));
    await waitFor(() => { expect(puts(calls)).toHaveLength(1); });
    expect(JSON.parse(puts(calls)[0]?.body ?? '')).toEqual({ expectedRevision: 3, servers: [{ serverId: ALPHA, mode: 'all', services: [] }] });
    expect(await screen.findByText(/прибрано|збережено/)).toBeTruthy();
  });

  it('409 (changed meanwhile): nothing overwritten, explained; "Перезавантажити" loads the current grants', async () => {
    let gets = 0;
    const calls = backend((req) => {
      if (req.method === 'PUT') return json(409, {});
      if (req.url === `/api/users/${OTHER_ID}/access`) {
        gets += 1;
        return json(200, gets === 1 ? access() : access({ revision: 7, servers: [grant(BETA, 'beta', 'all')] }));
      }
      return undefined;
    });
    renderApp('/users');
    const u = await open();
    const dialog = await screen.findByRole('dialog', { name: 'Доступи: other@example.test' });
    await u.click(await within(dialog).findByRole('button', { name: 'Додати alpha' }));
    await u.click(await within(dialog).findByRole('checkbox', { name: 'worker' }));
    await u.click(within(dialog).getByRole('button', { name: 'Зберегти доступи' }));
    expect(await within(dialog).findByText(/щойно змінив інший адміністратор/)).toBeTruthy();
    expect(puts(calls)).toHaveLength(1); // never retried automatically
    await u.click(within(dialog).getByRole('button', { name: 'Перезавантажити доступи' }));
    expect(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Прибрати beta' })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Прибрати alpha' })).toBeNull();
    expect(gets).toBe(2);
  });

  it('no answer (network): no success, a warning not to repeat blindly; unsaved changes are not dropped silently', async () => {
    backend((req) => (req.method === 'PUT' ? Promise.reject(new TypeError('network')) : undefined));
    renderApp('/users');
    const u = await open();
    const dialog = await screen.findByRole('dialog', { name: 'Доступи: other@example.test' });
    await u.click(await within(dialog).findByRole('button', { name: 'Додати alpha' }));
    await u.click(await within(dialog).findByRole('checkbox', { name: 'api' }));
    await u.click(within(dialog).getByRole('button', { name: 'Зберегти доступи' }));
    expect(await within(dialog).findByText(/Відповідь не отримано — зміни могли зберегтися/)).toBeTruthy();
    expect(screen.queryByText(/збережено:/)).toBeNull();
    await u.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    expect(screen.getByText(/Введені дані не збережено/)).toBeTruthy();
  });

  it('load failure is explained with a retry; the editor is never shown with guessed data', async () => {
    let fail = true;
    backend((req) => (req.url === `/api/users/${OTHER_ID}/access` && fail ? json(503, {}) : undefined));
    renderApp('/users');
    const u = await open();
    const dialog = await screen.findByRole('dialog', { name: 'Доступи: other@example.test' });
    expect(await within(dialog).findByText(/Сервіс тимчасово недоступний/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Зберегти доступи' })).toBeNull();
    fail = false;
    await u.click(within(dialog).getByRole('button', { name: 'Повторити' }));
    expect(await within(screen.getByRole('dialog')).findByText(/Доступів немає/)).toBeTruthy();
  });
});
