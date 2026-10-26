import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, installFetch, json, type RecordedRequest, renderApp, session, setViewportWidth } from './support';

// Users redesign (USR-01…09, docs/design/part-02): page-local search and role filter (said so, the request never
// changes, «Далі» stays), filters and page kept across the drawers and the access editor, loading placeholders,
// records on a phone, one create request even when submitted twice. Synthetic values only.

afterEach(() => { vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = 'operator.with.a.rather.long.address.for.layout.checks@example.test';
const mk = (n: number, email: string, role: string, isActive = true) => ({ id: id(n), email, role, isActive, createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z' });
const PAGE1 = [mk(0, 'admin@example.test', 'admin'), mk(1, LONG, 'operator'), mk(2, 'viewer@example.test', 'viewer', false)];
const PAGE2 = [mk(3, 'later@example.test', 'operator')];

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route = () => undefined) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session('admin'));
    if (req.url.startsWith('/api/users?')) {
      const after = new URL(req.url, 'http://x').searchParams.get('after');
      return json(200, after === null ? { items: PAGE1, nextAfter: id(2) } : { items: PAGE2, nextAfter: null });
    }
    if (req.url.endsWith('/access')) return json(200, { userId: id(1), email: LONG, role: 'operator', isActive: true, global: false, revision: 1, servers: [] });
    return json(404, {});
  });
}
const rows = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((r) => r.querySelector('.users__email')?.textContent);
const listUrls = (calls: RecordedRequest[]) => calls.filter((c) => c.url.startsWith('/api/users?')).map((c) => c.url);

describe('USR-01 list: page-local search and role filter', () => {
  it('filter only the page in hand (said so); no matches keeps «Далі»; requests never carry the search', async () => {
    const calls = backend();
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(3); });
    expect(screen.getByText('Пошук і фільтр діють лише серед користувачів поточної сторінки (до 100).')).toBeTruthy();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Пошук на цій сторінці'), 'VIEWER');
    expect(rows()).toEqual(['viewer@example.test']);
    expect(screen.getByText('На цій сторінці: 3 · знайдено: 1')).toBeTruthy();
    await u.clear(screen.getByLabelText('Пошук на цій сторінці'));
    await u.selectOptions(screen.getByLabelText('Роль'), 'operator');
    expect(rows()).toEqual([LONG]);
    await u.type(screen.getByLabelText('Пошук на цій сторінці'), 'nobody');
    expect(await screen.findByRole('heading', { name: 'На цій сторінці збігів немає' })).toBeTruthy();
    expect(screen.getByText(/На наступних сторінках можуть бути збіги/)).toBeTruthy();
    const next = within(screen.getByRole('navigation', { name: 'Сторінки користувачів' })).getByRole<HTMLButtonElement>('button', { name: 'Далі' });
    expect(next.disabled).toBe(false);
    await u.click(next);
    await waitFor(() => { expect(screen.getByText('Сторінка 2')).toBeTruthy(); });
    expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe('nobody'); // filters kept across pages
    expect(listUrls(calls)).toEqual(['/api/users?limit=100', `/api/users?limit=100&after=${id(2)}`]);
  });

  it('page and filters survive the edit drawer and the access editor', async () => {
    backend();
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(3); });
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('Роль'), 'operator');
    await u.click(screen.getByRole('button', { name: `Дії: ${LONG}` }));
    await u.click(screen.getByRole('menuitem', { name: 'Роль і активність' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Скасувати' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Дії: ${LONG}` })); // focus returns to the menu
    await u.click(screen.getByRole('button', { name: `Дії: ${LONG}` }));
    await u.click(screen.getByRole('menuitem', { name: 'Сервери та сервіси' }));
    expect(await screen.findByRole('dialog', { name: new RegExp(`^Доступи: ${LONG.replace(/\./g, '\\.')}`) })).toBeTruthy();
    await u.keyboard('{Escape}');
    expect(screen.getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(rows()).toEqual([LONG]);
    expect(screen.getByText('Сторінка 1')).toBeTruthy();
  });

  it('long e-mails: one line in the table, the full address in the text, the tooltip and the menu name; keyboard-focusable', async () => {
    backend();
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(3); });
    const cell = screen.getAllByText(LONG).find((el) => el.classList.contains('users__email'));
    expect(cell?.getAttribute('title')).toBe(LONG);
    expect(cell?.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('button', { name: `Дії: ${LONG}` })).toBeTruthy();
    expect(screen.getByText('Неактивний')).toBeTruthy(); // status in words
  });
});

describe('USR-09 loading and states', () => {
  it('loading: placeholder rows, announced; no user is invented; then the list', async () => {
    const slow = deferred<Response>();
    backend((req) => (req.url.startsWith('/api/users?') ? slow.promise : undefined));
    renderApp('/users');
    expect(await screen.findByText('Завантаження користувачів…')).toBeTruthy();
    expect(document.querySelector('.users-card')?.textContent).not.toContain('@example.test'); // no row invented
    await act(async () => { slow.resolve(json(200, { items: PAGE1, nextAfter: null })); await Promise.resolve(); });
    await waitFor(() => { expect(rows()).toHaveLength(3); });
  });

  it('list error without data: explained with a retry, not an empty list', async () => {
    let fail = true;
    backend((req) => (req.url.startsWith('/api/users?') && fail ? json(503, {}, { 'retry-after': '5' }) : undefined));
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Не вдалося завантажити користувачів' })).toBeTruthy();
    expect(screen.queryByText('Користувачів ще немає')).toBeNull();
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    await waitFor(() => { expect(rows()).toHaveLength(3); });
  });

  it('phone: records with e-mail, role, «Ви», activity, access and the menu; no table', async () => {
    setViewportWidth(390);
    backend();
    renderApp('/users');
    const own = await screen.findByRole('article', { name: 'admin@example.test' });
    expect(within(own).getByText('Адміністратор · Ви')).toBeTruthy();
    expect(within(own).getByText('Повний доступ')).toBeTruthy();
    expect(within(own).getByRole('button', { name: 'Дії: admin@example.test' })).toBeTruthy();
    const other = screen.getByRole('article', { name: 'viewer@example.test' });
    expect(within(other).getByText('Неактивний')).toBeTruthy();
    expect(within(other).getByText('За наданими доступами')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('USR-06 create pending', () => {
  it('a second submit while pending sends nothing more; the form is locked and cannot be closed; one POST', async () => {
    const answer = deferred<Response>();
    const calls = backend((req) => (req.url === '/api/users' && req.method === 'POST' ? answer.promise : undefined));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(3); });
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Створити користувача' }));
    const form = screen.getByRole('form', { name: 'Створення користувача' });
    await u.type(within(form).getByLabelText('Email'), 'new@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), 'synthetic-New-Passw0rd-1');
    await u.click(within(form).getByRole('button', { name: 'Створити' }));
    const pending = within(form).getByRole<HTMLButtonElement>('button', { name: 'Створення…' });
    expect(pending.disabled).toBe(true);
    await u.click(pending);
    await u.keyboard('{Enter}');
    expect(within(form).getByLabelText<HTMLInputElement>('Email').disabled).toBe(true);
    expect(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: 'Закрити' }).disabled).toBe(true);
    await u.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(calls.filter((c) => c.url === '/api/users' && c.method === 'POST')).toHaveLength(1);
    await act(async () => { answer.resolve(json(201, mk(9, 'new@example.test', 'viewer'))); await Promise.resolve(); });
    expect(await screen.findByText(/Користувача new@example\.test створено \(Спостерігач, активний\)/)).toBeTruthy();
    expect(calls.filter((c) => c.url === '/api/users' && c.method === 'POST')).toHaveLength(1);
  });
});
