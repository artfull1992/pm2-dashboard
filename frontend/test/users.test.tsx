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

  it('admin: one table; own row marked «Ви» with a read-only menu; access is said without guessing; no per-row requests', async () => {
    const calls = backend('admin');
    renderApp('/');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Користувачі' }));
    const table = await screen.findByRole('table');
    const own = within(table).getByRole('rowheader', { name: /admin@example\.test/ }).closest('tr') as HTMLElement;
    expect(within(own).getByText('Ви')).toBeTruthy();
    expect(within(own).getByText('Повний доступ')).toBeTruthy();
    const other = within(table).getByRole('rowheader', { name: /other@example\.test/ }).closest('tr') as HTMLElement;
    expect(within(other).getByText('За наданими доступами')).toBeTruthy(); // no grant summary is invented
    expect(within(other).getByText('Активний')).toBeTruthy();
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Email', 'Роль', 'Доступ', 'Активність', 'Дії']);
    // One list request; nothing per row (no access summaries are fetched).
    expect(calls.filter((c) => c.url.startsWith('/api/users'))).toHaveLength(1); // one page
    expect(calls.some((c) => c.url.includes('/access'))).toBe(false);
  });

  it('own account: «Роль і активність» opens read-only details (no form, no request); no access editor in the menu', async () => {
    const calls = backend('admin');
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Дії: admin@example.test' }));
    expect(screen.queryByRole('menuitem', { name: 'Сервери та сервіси' })).toBeNull();
    await u.click(screen.getByRole('menuitem', { name: 'Роль і активність' }));
    const dialog = screen.getByRole('dialog', { name: 'Ваш обліковий запис' });
    expect(within(dialog).getByText('Власну роль та активність змінює інший адміністратор')).toBeTruthy();
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Зберегти' })).toBeNull();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Дії: admin@example.test' }));
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('create: validation, CSRF + exact body {email, password, role} (no isActive), password cleared, list reloaded; duplicate keeps email and role', async () => {
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
    await u.click(await screen.findByRole('button', { name: 'Створити користувача' }));
    const form = screen.getByRole('form', { name: 'Створення користувача' });
    expect(within(form).getByText('Новий користувач створюється активним')).toBeTruthy();
    expect(within(form).getByLabelText<HTMLSelectElement>('Роль').value).toBe('viewer'); // safe default
    expect(within(form).getByLabelText<HTMLInputElement>('Початковий пароль').type).toBe('password');
    await u.click(within(form).getByRole('button', { name: 'Створити' }));
    expect(within(form).getByText('Введіть коректний email.')).toBeTruthy();
    expect(posts(calls, '/api/users')).toHaveLength(0);
    await u.type(within(form).getByLabelText('Email'), 'new@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), NEXT);
    await u.selectOptions(within(form).getByLabelText('Роль'), 'operator');
    const listsBefore = calls.filter((c) => c.url.startsWith('/api/users?')).length;
    await u.click(within(form).getByRole('button', { name: 'Створити' }));
    expect(await screen.findByText('Користувача new@example.test створено (Оператор, активний).')).toBeTruthy();
    const sent = posts(calls, '/api/users')[0];
    expect(sent?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(sent?.body ?? '{}')).toEqual({ email: 'new@example.test', password: NEXT, role: 'operator' });
    expect(screen.queryByRole('dialog')).toBeNull(); // closed on success: the password left the page with the form
    expect(document.body.innerHTML).not.toContain(NEXT);
    await waitFor(() => { expect(calls.filter((c) => c.url.startsWith('/api/users?')).length).toBeGreaterThan(listsBefore); });
    await u.click(screen.getByRole('button', { name: 'Створити користувача' }));
    const again = screen.getByRole('form', { name: 'Створення користувача' });
    expect(within(again).getByLabelText<HTMLInputElement>('Початковий пароль').value).toBe('');
    await u.type(within(again).getByLabelText('Email'), 'new@example.test');
    await u.type(within(again).getByLabelText('Початковий пароль'), NEXT);
    await u.selectOptions(within(again).getByLabelText('Роль'), 'operator');
    await u.click(within(again).getByRole('button', { name: 'Створити' }));
    expect(await within(again).findByText(/Користувач із таким email уже існує\./)).toBeTruthy();
    expect(within(again).getByLabelText<HTMLInputElement>('Початковий пароль').value).toBe(''); // cleared after a failed request too
    expect(within(again).getByLabelText<HTMLInputElement>('Email').value).toBe('new@example.test');
    expect(within(again).getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(document.body.innerHTML).not.toContain(NEXT);
  });

  async function openEdit(u: ReturnType<typeof userEvent.setup>, email = 'other@example.test') {
    await u.click(await screen.findByRole('button', { name: `Дії: ${email}` }));
    await u.click(screen.getByRole('menuitem', { name: 'Роль і активність' }));
    return screen.getByRole('form', { name: 'Роль і активність' });
  }
  const patches = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'PATCH');

  it.each([
    ['role only', async (u: ReturnType<typeof userEvent.setup>, f: HTMLElement) => { await u.selectOptions(within(f).getByLabelText('Роль'), 'operator'); }, { role: 'operator' }, user(OTHER_ID, 'other@example.test', 'operator'), /other@example\.test: роль — «Оператор»\. Усі його сесії завершено\./],
    ['activity only', async (u: ReturnType<typeof userEvent.setup>, f: HTMLElement) => { await u.click(within(f).getByLabelText('Активний користувач')); }, { isActive: false }, user(OTHER_ID, 'other@example.test', 'viewer', false), /other@example\.test: деактивовано\. Усі його сесії завершено\./],
    ['both in ONE request', async (u: ReturnType<typeof userEvent.setup>, f: HTMLElement) => { await u.selectOptions(within(f).getByLabelText('Роль'), 'admin'); await u.click(within(f).getByLabelText('Активний користувач')); }, { role: 'admin', isActive: false }, user(OTHER_ID, 'other@example.test', 'admin', false), /роль — «Адміністратор», деактивовано/],
  ])('edit — %s: the change is listed before saving; one PATCH with only the changed fields and CSRF', async (_n, change, body, answer, text) => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? json(200, answer) : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    const form = await openEdit(u);
    expect(within(form).getByText('other@example.test')).toBeTruthy(); // the target, read-only
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Зберегти' }).disabled).toBe(true); // unchanged
    expect(within(form).getByText('Змін немає.')).toBeTruthy();
    await change(u, form);
    expect(within(form).getByText('Буде змінено для other@example.test')).toBeTruthy();
    if ('isActive' in body) expect(within(form).getByText(/деактивувати — користувач не зможе увійти/)).toBeTruthy();
    expect(within(form).getByText('Усі сесії користувача буде завершено одразу після збереження.')).toBeTruthy();
    await u.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(patches(calls)).toHaveLength(1);
    expect(patches(calls)[0]?.url).toBe(`/api/users/${OTHER_ID}`);
    expect(patches(calls)[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(patches(calls)[0]?.body ?? '{}')).toEqual(body);
  });

  it('edit: clean Escape closes without a request; a dirty close asks first and «Повернутися до форми» keeps the values', async () => {
    const calls = backend('admin');
    renderApp('/users');
    const u = userEvent.setup();
    await openEdit(u);
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    const form = await openEdit(u);
    await u.selectOptions(within(form).getByLabelText('Роль'), 'operator');
    await u.keyboard('{Escape}');
    expect(screen.getByText(/Введені дані не збережено/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Повернутися до форми' }));
    expect(within(screen.getByRole('form', { name: 'Роль і активність' })).getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(patches(calls)).toHaveLength(0);
  });

  it.each([
    ['last admin (409)', () => json(409, {}), 'Не вдалося зберегти', /Не можна залишити систему без активного адміністратора\./],
    ['self change (403)', () => json(403, {}), 'Не вдалося зберегти', /Власну роль чи активність змінює лише інший адміністратор\./],
    ['rate limit (429)', () => json(429, {}, { 'retry-after': '30' }), 'Не вдалося зберегти', /Забагато змін поспіль\. Спробуйте через 30 с\./],
  ])('edit — %s: explained in the form, the draft kept, never retried', async (_n, reply, title, text) => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? reply() : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    const form = await openEdit(u);
    await u.click(within(form).getByLabelText('Активний користувач'));
    await u.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(form).findByText(title)).toBeTruthy();
    expect(within(form).getByText(text)).toBeTruthy();
    expect(within(form).getByLabelText<HTMLInputElement>('Активний користувач').checked).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(patches(calls)).toHaveLength(1);
  });

  it('edit — no answer (network): the result is unknown, not a failure; «Перечитати стан» re-reads the list; nothing is resent', async () => {
    let lists = 0;
    const calls = backend('admin', (req) => {
      if (req.method === 'PATCH') return Promise.reject(new TypeError('fetch failed'));
      if (req.url.startsWith('/api/users?')) {
        lists += 1;
        return json(200, page([user(ADMIN_ID, 'admin@example.test', 'admin'), user(OTHER_ID, 'other@example.test', 'viewer', lists < 2)]));
      }
      return undefined;
    });
    renderApp('/users');
    const u = userEvent.setup();
    const form = await openEdit(u);
    await u.click(within(form).getByLabelText('Активний користувач'));
    await u.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await within(form).findByText('Результат невідомий')).toBeTruthy();
    expect(within(form).getByText(/дія могла виконатися/)).toBeTruthy();
    await u.click(within(form).getByRole('button', { name: 'Перечитати стан' }));
    expect(await within(form).findByText('За останнім списком: Спостерігач, неактивний.')).toBeTruthy();
    expect(patches(calls)).toHaveLength(1);
  });

  it('pending mutation: fields and buttons locked, Escape and ✕ do not close; leaving the page ignores the late answer', async () => {
    const answer = deferred<Response>();
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? answer.promise : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    const form = await openEdit(u);
    await u.click(within(form).getByLabelText('Активний користувач'));
    await u.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Збереження…' }).disabled).toBe(true);
    expect(within(form).getByLabelText<HTMLSelectElement>('Роль').disabled).toBe(true);
    expect(within(form).getByLabelText<HTMLInputElement>('Активний користувач').disabled).toBe(true);
    expect(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: 'Закрити' }).disabled).toBe(true);
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
    const form = await openEdit(u);
    await u.click(within(form).getByLabelText('Активний користувач'));
    await u.click(within(form).getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByText('Сесія завершилась. Увійдіть знову.')).toBeTruthy();
  });

  it('«Сервери та сервіси» opens the access page of that user (ACL); «← Користувачі» returns to the list', async () => {
    backend('admin', (req) => (req.url === `/api/users/${OTHER_ID}/access` ? json(200, { userId: OTHER_ID, email: 'other@example.test', role: 'viewer', isActive: true, global: false, revision: 1, servers: [] }) : undefined));
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Сервери та сервіси' }));
    expect(await screen.findByRole('heading', { name: 'Доступи користувача' })).toBeTruthy();
    expect(await screen.findByText('other@example.test')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull(); // a page, not a modal
    await u.click(screen.getByRole('link', { name: '← Користувачі' }));
    expect(await screen.findByText('Сторінка 1')).toBeTruthy();
  });
});

// Task 011.1: a response that belongs to an earlier form/session must never change the current session. The test
// transport (deferred) completes AFTER the abort, exactly the case the UI has to ignore.
describe('stale responses across sessions', () => {
  async function relogin(u: ReturnType<typeof userEvent.setup>) {
    await u.click(screen.getByRole('button', { name: 'Вийти' }));
    await u.type(await screen.findByLabelText('Email'), 'viewer@example.test');
    await u.type(screen.getByLabelText('Пароль'), CURRENT);
    await u.click(screen.getByRole('button', { name: 'Увійти' }));
    await u.click(await screen.findByRole('link', { name: 'Огляд' }));
    expect(await screen.findByRole('heading', { name: 'Огляд' })).toBeTruthy();
  }
  function lateBackend(reply: Promise<Response>) {
    return backend('viewer', (req) => {
      if (req.url === '/api/auth/change-password') return reply;
      if (req.url === '/api/auth/logout') return noContent();
      if (req.url === '/api/auth/login') return json(200, session('viewer'));
      return undefined;
    });
  }

  it('pending change → leave the page → late success: the session is kept', async () => {
    const answer = deferred<Response>();
    lateBackend(answer.promise);
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    await u.click(screen.getByRole('link', { name: 'Огляд' }));
    await act(async () => { answer.resolve(noContent()); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole('heading', { name: 'Огляд' })).toBeTruthy();
    expect(screen.queryByText(/Пароль змінено/)).toBeNull();
  });

  it('pending change → logout → new login → late success of the OLD form does not end the NEW session', async () => {
    const answer = deferred<Response>();
    lateBackend(answer.promise);
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    await relogin(u);
    await act(async () => { answer.resolve(noContent()); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole('heading', { name: 'Огляд' })).toBeTruthy();
    expect(screen.queryByText(/Пароль змінено/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Вийти' })).toBeTruthy();
  });

  it('a late ERROR (409) of the old form does not end the new session either', async () => {
    const answer = deferred<Response>();
    lateBackend(answer.promise);
    renderApp('/account');
    const u = await fillPassword(CURRENT, NEXT);
    await u.click(screen.getByRole('button', { name: 'Змінити пароль' }));
    await relogin(u);
    await act(async () => { answer.resolve(json(409, {})); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByRole('heading', { name: 'Огляд' })).toBeTruthy();
    expect(screen.queryByText('Сесія завершилась. Увійдіть знову.')).toBeNull();
  });

  it('create / update user answered after leaving the page: no stale callback, no reload', async () => {
    const created = deferred<Response>();
    const updated = deferred<Response>();
    const calls = backend('admin', (req) => {
      if (req.url === '/api/users' && req.method === 'POST') return created.promise;
      if (req.method === 'PATCH') return updated.promise;
      return undefined;
    });
    renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Створити користувача' }));
    const form = screen.getByRole('form', { name: 'Створення користувача' });
    await u.type(within(form).getByLabelText('Email'), 'late@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), NEXT);
    await u.click(within(form).getByRole('button', { name: 'Створити' }));
    await u.click(screen.getByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Роль і активність' }));
    const edit = screen.getByRole('form', { name: 'Роль і активність' });
    await u.click(within(edit).getByLabelText('Активний користувач'));
    await u.click(within(edit).getByRole('button', { name: 'Зберегти' }));
    await u.click(screen.getByRole('link', { name: 'Огляд' }));
    const lists = calls.filter((c) => c.url.startsWith('/api/users?')).length;
    await act(async () => {
      created.resolve(json(201, user('33333333-3333-4333-8333-333333333333', 'late@example.test', 'viewer')));
      updated.resolve(json(200, user(OTHER_ID, 'other@example.test', 'viewer', false)));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls.filter((c) => c.url.startsWith('/api/users?')).length).toBe(lists);
    expect(screen.getByRole('heading', { name: 'Огляд' })).toBeTruthy();
  });
});
