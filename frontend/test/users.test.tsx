import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF, deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// Own account (password change) and user administration UI (Task 011, ADR-019).

const ADMIN_ID = '00000000-0000-4000-8000-000000000000';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT = 'synthetic-Current-Pass-1';
const NEXT = 'synthetic-Next-Passw0rd-2';
const user = (id: string, email: string, role: string, isActive = true) => ({ id, email, role, isActive, createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z' });
const page = (items: unknown[]) => ({ items, nextAfter: null });

let storageWrites: string[];
beforeEach(() => {
  storageWrites = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string) { storageWrites.push(key); });
});
afterEach(() => { vi.unstubAllGlobals(); expect(storageWrites).toEqual([]); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'admin' | 'operator' | 'viewer', route: Route = () => undefined) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url.startsWith('/api/users?')) return json(200, page([user(ADMIN_ID, 'admin@example.test', 'admin'), user(OTHER_ID, 'other@example.test', 'viewer')]));
    return json(404, {});
  });
}
const posts = (calls: RecordedRequest[], url: string, method = 'POST') => calls.filter((c) => c.url === url && c.method === method);

async function fillPassword(current: string, next: string, confirm = next) {
  const u = userEvent.setup();
  const field = await screen.findByLabelText('Поточний пароль');
  if (current) await u.type(field, current);
  if (next) await u.type(screen.getByLabelText('Новий пароль'), next);
  if (confirm) await u.type(screen.getByLabelText('Повторіть новий пароль'), confirm);
  return u;
}

describe('own account', () => {
  it.each(['admin', 'operator', 'viewer'] as const)('%s sees the account page in the navigation with email and role', async (role) => {
    backend(role);
    renderApp('/');
    const link = await screen.findByRole('link', { name: 'Обліковий запис' });
    await userEvent.setup().click(link);
    expect(await screen.findByRole('heading', { name: 'Обліковий запис' })).toBeTruthy();
    expect(screen.getAllByText(`${role}@example.test`).length).toBeGreaterThan(0);
    expect(screen.getByLabelText<HTMLInputElement>('Поточний пароль').autocomplete).toBe('current-password');
    expect(screen.getByLabelText<HTMLInputElement>('Новий пароль').autocomplete).toBe('new-password');
    expect(screen.getByLabelText<HTMLInputElement>('Повторіть новий пароль').autocomplete).toBe('new-password');
    expect(screen.getByText(/всі ваші сесії буде завершено/)).toBeTruthy();
  });

  it('inline validation: required, length, differs from current, confirmation — nothing is sent', async () => {
    const calls = backend('viewer');
    renderApp('/account');
    const u = await fillPassword('', 'short', 'other');
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    expect(screen.getByText('Введіть поточний пароль.')).toBeTruthy();
    expect(screen.getByText(/Від 12 до 128 символів\./)).toBeTruthy();
    expect(screen.getByText('Паролі не збігаються.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Поточний пароль'));
    await u.clear(screen.getByLabelText('Новий пароль'));
    await u.type(screen.getByLabelText('Поточний пароль'), CURRENT);
    await u.type(screen.getByLabelText('Новий пароль'), CURRENT);
    await u.clear(screen.getByLabelText('Повторіть новий пароль'));
    await u.type(screen.getByLabelText('Повторіть новий пароль'), CURRENT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    expect(screen.getByText('Новий пароль має відрізнятися від поточного.')).toBeTruthy();
    expect(posts(calls, '/api/auth/change-password')).toHaveLength(0);
  });

  it('show/hide toggles all password fields (aria-pressed)', async () => {
    backend('viewer');
    renderApp('/account');
    const toggle = await screen.findByRole('button', { name: 'Показати паролі' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.setup().click(toggle);
    expect(screen.getByRole('button', { name: 'Приховати паролі' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Новий пароль').type).toBe('text');
  });

  it('success: one CSRF request with exactly the two passwords; private area dropped; login shows the notice', async () => {
    const answer = deferred<Response>();
    const calls = backend('operator', (req) => (req.url === '/api/auth/change-password' ? answer.promise : undefined));
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Зміна…' }).disabled).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Зміна…' })); // double submit ignored
    const sent = posts(calls, '/api/auth/change-password');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({ currentPassword: CURRENT, newPassword: NEXT });
    await act(async () => { answer.resolve(noContent()); await Promise.resolve(); });
    expect(await screen.findByText('Пароль змінено. Усі сесії завершено — увійдіть з новим паролем.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Обліковий запис' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(NEXT);
  });

  it('wrong current password (422): message, fields cleared, session kept, no retry', async () => {
    const calls = backend('viewer', (req) => (req.url === '/api/auth/change-password' ? json(422, {}) : undefined));
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    expect(await screen.findByText('Поточний пароль невірний.')).toBeTruthy();
    for (const label of ['Поточний пароль', 'Новий пароль', 'Повторіть новий пароль']) expect(screen.getByLabelText<HTMLInputElement>(label).value).toBe('');
    expect(posts(calls, '/api/auth/change-password')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Обліковий запис' })).toBeTruthy();
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError('fetch failed')), /пароль міг змінитися/],
    ['rate limit', () => json(429, {}, { 'retry-after': '60' }), /Забагато спроб зміни пароля\. Спробуйте через 1 хв\./],
    ['overload', () => json(503, {}, { 'retry-after': '1' }), /тимчасово перевантажений/],
  ])('%s: explained, never retried automatically', async (_n, reply, text) => {
    const calls = backend('viewer', (req) => (req.url === '/api/auth/change-password' ? reply() : undefined));
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    expect(await screen.findByText(text)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(posts(calls, '/api/auth/change-password')).toHaveLength(1);
  });

  it('409 (credentials changed concurrently) ends the session', async () => {
    backend('viewer', (req) => (req.url === '/api/auth/change-password' ? json(409, {}) : undefined));
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    expect(await screen.findByText('Сесія завершилась. Увійдіть знову.')).toBeTruthy();
  });

  it('leaving the page clears typed passwords (unmount)', async () => {
    backend('admin');
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('link', { name: 'Огляд' }));
    await u.click(await screen.findByRole('link', { name: 'Обліковий запис' }));
    expect((await screen.findByLabelText<HTMLInputElement>('Поточний пароль')).value).toBe('');
  });
});

describe('user administration', () => {
  it.each(['operator', 'viewer'] as const)('%s: no navigation item; direct /users is forbidden; the API is never called', async (role) => {
    const calls = backend(role);
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Користувачі' })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/users'))).toBe(false);
  });

  it('admin: one table; own row marked without actions; other rows have a "Дії" menu', async () => {
    backend('admin');
    renderApp('/');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Користувачі' }));
    const table = await screen.findByRole('table');
    const own = within(table).getByRole('rowheader', { name: /admin@example\.test/ }).closest('tr') as HTMLElement;
    expect(within(own).getByText('Ви')).toBeTruthy();
    expect(within(own).getByText(/Власний обліковий запис/)).toBeTruthy();
    expect(within(own).queryByRole('button', { name: /^Дії/ })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Дії: other@example.test' })).toBeTruthy();
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Email', 'Роль', 'Активність', 'Створено', 'Дії']);
  });

  it('create: validation, CSRF + exact body, password cleared, list reloaded; duplicate → conflict message', async () => {
    let created = 0;
    const calls = backend('admin', (req) => {
      if (req.url === '/api/users' && req.method === 'POST') {
        created += 1;
        return created === 1 ? json(201, user('22222222-2222-4222-8222-222222222222', 'new@example.test', 'operator')) : json(409, {});
      }
      return undefined;
    });
    renderApp('/users');
    const u = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Новий користувач' });
    await u.click(within(form).getByRole('button', { name: 'Створити користувача' }));
    expect(within(form).getByText('Введіть коректний email.')).toBeTruthy();
    expect(posts(calls, '/api/users')).toHaveLength(0);
    await u.type(within(form).getByLabelText('Email'), 'new@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), NEXT);
    await u.selectOptions(within(form).getByLabelText('Роль'), 'operator');
    const listsBefore = calls.filter((c) => c.url.startsWith('/api/users?')).length;
    await u.click(within(form).getByRole('button', { name: 'Створити користувача' }));
    expect(await screen.findByText('Користувача new@example.test створено (Оператор).')).toBeTruthy();
    const sent = posts(calls, '/api/users')[0];
    expect(sent?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({ email: 'new@example.test', password: NEXT, role: 'operator' });
    expect(within(form).getByLabelText<HTMLInputElement>('Початковий пароль').value).toBe('');
    await waitFor(() => { expect(calls.filter((c) => c.url.startsWith('/api/users?')).length).toBeGreaterThan(listsBefore); });
    await u.type(within(form).getByLabelText('Email'), 'new@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), NEXT);
    await u.click(within(form).getByRole('button', { name: 'Створити користувача' }));
    expect(await within(form).findByText('Користувач із таким email уже існує.')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(NEXT);
  });

  it('role change: menu → dialog → PATCH {role} with CSRF; success explained; Escape cancels without a request', async () => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? json(200, user(OTHER_ID, 'other@example.test', 'operator')) : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('button', { name: 'Змінити роль' }));
    expect(screen.getByRole('dialog', { name: 'Змінити роль: other@example.test' })).toBeTruthy();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('button', { name: 'Змінити роль' }));
    const dialog = screen.getByRole('dialog', { name: 'Змінити роль: other@example.test' });
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Змінити роль' }).disabled).toBe(true); // unchanged role
    await u.selectOptions(within(dialog).getByLabelText('Нова роль'), 'operator');
    await u.click(within(dialog).getByRole('button', { name: 'Змінити роль' }));
    expect(await screen.findByText(/Роль other@example\.test змінено на «Оператор»\. Усі його сесії завершено\./)).toBeTruthy();
    const sent = calls.filter((c) => c.method === 'PATCH');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`/api/users/${OTHER_ID}`);
    expect(sent[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toEqual({ role: 'operator' });
  });

  it.each([
    ['last admin', () => json(409, {}), 'Не можна залишити систему без активного адміністратора.'],
    ['network error', () => Promise.reject(new TypeError('fetch failed')), /дія могла виконатися/],
  ])('deactivate with confirmation; %s is explained and never retried', async (_n, reply, text) => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? reply() : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('button', { name: 'Деактивувати' }));
    const dialog = screen.getByRole('dialog', { name: 'Деактивувати: other@example.test' });
    expect(within(dialog).getByText(/Усі сесії користувача буде завершено/)).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Деактивувати' }));
    expect(await within(dialog).findByText(text)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}')).toEqual({ isActive: false });
  });

  it('pending mutation: buttons locked, dialog cannot be dismissed; leaving the page ignores the late answer', async () => {
    const answer = deferred<Response>();
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? answer.promise : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('button', { name: 'Деактивувати' }));
    const dialog = screen.getByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Деактивувати' }));
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Збереження…' }).disabled).toBe(true);
    await u.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await u.click(screen.getByRole('link', { name: 'Огляд' }));
    expect(calls.find((c) => c.method === 'PATCH')?.signal?.aborted).toBe(true);
    await act(async () => { answer.resolve(json(200, user(OTHER_ID, 'other@example.test', 'viewer', false))); await Promise.resolve(); });
    expect(screen.queryByText(/деактивовано/)).toBeNull();
  });

  it('a 401 during a mutation ends the session', async () => {
    backend('admin', (req) => (req.method === 'PATCH' ? json(401, {}) : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('button', { name: 'Деактивувати' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Деактивувати' }));
    expect(await screen.findByText('Сесія завершилась. Увійдіть знову.')).toBeTruthy();
  });
});
