import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// Task 011.1: every user is reachable and manageable through bounded keyset pages ("Назад" / "Далі").

const PAGE = 100;
// Tests that render two or more full 100-row pages are CPU-bound in jsdom: ≈0.65 s alone, but 4–5.3 s when the
// suite runs in parallel with another one (measured; the same on the revision before ADR-024). The default 5 s test
// budget is therefore no headroom for their real work; the waits and assertions inside are unchanged.
const MULTI_PAGE_TEST_MS = 15_000;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; // n = 0 → the admin itself
const mk = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n), email: n === 0 ? 'admin@example.test' : `user${String(n).padStart(3, '0')}@example.test`, role: n === 0 ? 'admin' : 'viewer', isActive: true,
  createdAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), updatedAt: '2026-10-14T10:00:00.000Z', ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(total: number, route: Route = () => undefined) {
  const users = Array.from({ length: total }, (_, n) => mk(n));
  const calls = installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session('admin'));
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url === '/api/auth/login') return json(200, session('admin'));
    if (req.url.startsWith('/api/users?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const after = q.get('after');
      const start = after === null ? 0 : users.findIndex((u) => u.id === after) + 1;
      const items = users.slice(start, start + Number(q.get('limit')));
      return json(200, { items, nextAfter: start + items.length < users.length ? (items.at(-1)?.id ?? null) : null });
    }
    if (req.url === '/api/users' && req.method === 'POST') {
      const created = mk(users.length, { email: 'fresh@example.test', role: 'operator' });
      users.push(created);
      return json(201, created);
    }
    if (req.method === 'PATCH') {
      const target = users.find((u) => req.url.endsWith(u.id));
      if (!target) return json(404, {});
      Object.assign(target, JSON.parse(req.body ?? '{}') as object);
      return json(200, target);
    }
    return json(404, {});
  });
  return { calls, users };
}
const lists = (calls: RecordedRequest[]) => calls.filter((c) => c.url.startsWith('/api/users?')).map((c) => new URL(c.url, 'http://x').searchParams.get('after'));
const rows = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((r) => r.textContent);
const pager = () => screen.getByRole('navigation', { name: 'Сторінки користувачів' });

describe('user pages', () => {
  it('230 users: 100 per page, "Далі" sends the cursor, the last page has no "Далі", "Назад" returns', async () => {
    const { calls } = backend(230);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    expect(rows()[0]).toContain('admin@example.test');
    expect(within(pager()).getByText('Сторінка 1')).toBeTruthy();
    expect(within(pager()).getByRole<HTMLButtonElement>('button', { name: 'Назад' }).disabled).toBe(true);
    const u = userEvent.setup();
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    expect(lists(calls).at(-1)).toBe(id(99));
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()).toHaveLength(30); });
    expect(rows().at(-1)).toContain('user229@example.test');
    expect(within(pager()).getByText('Сторінка 3')).toBeTruthy();
    expect(within(pager()).getByRole<HTMLButtonElement>('button', { name: 'Далі' }).disabled).toBe(true);
    await u.click(within(pager()).getByRole('button', { name: 'Назад' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    expect(lists(calls).at(-1)).toBe(id(99));
    expect(lists(calls).every((a) => a === null || /^[0-9a-f-]{36}$/.test(a))).toBe(true);
  }, MULTI_PAGE_TEST_MS);

  it('a late answer for a page the user already left never replaces the current page', async () => {
    const slow = deferred<Response>();
    let delayed = true;
    const { calls } = backend(230, (req) => (delayed && req.url.includes(`after=${id(99)}`) ? slow.promise : undefined));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    expect(screen.getByText('Завантаження…')).toBeTruthy(); // page 1 rows are not shown as page 2
    expect(screen.queryByRole('table')).toBeNull();
    await u.click(within(pager()).getByRole('button', { name: 'Назад' }));
    await waitFor(() => { expect(rows()[0]).toContain('admin@example.test'); });
    delayed = false;
    await act(async () => {
      slow.resolve(json(200, { items: [mk(100), mk(101)], nextAfter: id(101) }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rows()[0]).toContain('admin@example.test');
    expect(rows()).toHaveLength(PAGE);
    expect(within(pager()).getByText('Сторінка 1')).toBeTruthy();
    expect(lists(calls).filter((a) => a === id(99))).toHaveLength(1);
  }, MULTI_PAGE_TEST_MS);

  it('a failed next page shows an error with retry and no rows of the previous page', async () => {
    let fail = true;
    backend(230, (req) => (fail && req.url.includes(`after=${id(99)}`) ? json(503, {}, { 'retry-after': '3' }) : undefined));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    expect(await screen.findByRole('heading', { name: 'Не вдалося оновити список' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(pager()).getByText('Сторінка 2')).toBeTruthy();
    fail = false;
    await u.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
  }, MULTI_PAGE_TEST_MS);

  it('a user on page 2 is managed there; the same page is reloaded after the change', async () => {
    const { calls } = backend(230);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    await u.click(screen.getByRole('button', { name: 'Дії: user150@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Деактивувати' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Деактивувати' }));
    expect(await screen.findByText('user150@example.test деактивовано. Усі його сесії завершено.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')?.url).toBe(`/api/users/${id(150)}`);
    await waitFor(() => { expect(screen.getByRole('row', { name: /user150@example\.test/ }).textContent).toContain('Деактивований'); });
    expect(lists(calls).at(-1)).toBe(id(99));
    await u.click(screen.getByRole('button', { name: 'Дії: user150@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Активувати' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Активувати' }));
    expect(await screen.findByText(/user150@example\.test знову активний/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Дії: user160@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Змінити роль' }));
    await u.selectOptions(within(screen.getByRole('dialog')).getByLabelText('Нова роль'), 'admin');
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Змінити роль' }));
    expect(await screen.findByText(/Роль user160@example\.test змінено на «Адміністратор»/)).toBeTruthy();
    expect(within(pager()).getByText('Сторінка 2')).toBeTruthy();
  }, MULTI_PAGE_TEST_MS);

  it('creating a user when page 1 is full: the result says where it is and "Показати" opens the page with it', async () => {
    backend(150);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Новий користувач' }));
    const form = screen.getByRole('form', { name: 'Новий користувач' });
    await u.type(within(form).getByLabelText('Email'), 'fresh@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), 'synthetic-Fresh-Passw0rd');
    await u.click(within(form).getByRole('button', { name: 'Створити користувача' }));
    const notice = await screen.findByText(/Користувача fresh@example\.test створено \(Оператор\)/);
    expect(notice.textContent).toContain('наприкінці списку');
    expect(rows().some((r) => r.includes('fresh@example.test'))).toBe(false); // nothing invented on page 1
    await u.click(screen.getByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows().some((r) => r.includes('fresh@example.test'))).toBe(true); });
    expect(within(pager()).getByText('Сторінка 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Дії: fresh@example.test' })).toBeTruthy();
    await u.click(within(pager()).getByRole('button', { name: 'Назад' }));
    await waitFor(() => { expect(within(pager()).getByText('Сторінка 1')).toBeTruthy(); });
  }, MULTI_PAGE_TEST_MS);

  it('a failed create shows no invented row', async () => {
    backend(150, (req) => (req.url === '/api/users' && req.method === 'POST' ? json(409, {}) : undefined));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Новий користувач' }));
    const form = screen.getByRole('form', { name: 'Новий користувач' });
    await u.type(within(form).getByLabelText('Email'), 'dup@example.test');
    await u.type(within(form).getByLabelText('Початковий пароль'), 'synthetic-Dup-Passw0rd-1');
    await u.click(within(form).getByRole('button', { name: 'Створити користувача' }));
    expect(await within(form).findByText('Користувач із таким email уже існує.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Показати .*@/ })).toBeNull();
    expect(rows().some((r) => r.includes('dup@example.test'))).toBe(false);
  });

  it('own row stays marked without actions; logout and a new session start again on page 1 with no dialog', async () => {
    const { calls } = backend(230);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    expect(within(screen.getByRole('row', { name: /admin@example\.test/ })).getByText('Ви')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Дії: admin@example.test' })).toBeNull();
    const u = userEvent.setup();
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    await u.click(screen.getByRole('button', { name: 'Дії: user120@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Змінити роль' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await u.keyboard('{Escape}');
    await u.click(screen.getByRole('button', { name: 'Вийти' }));
    await u.type(await screen.findByLabelText('Email'), 'admin@example.test');
    await u.type(screen.getByLabelText('Пароль'), 'synthetic-Admin-Passw0rd');
    await u.click(screen.getByRole('button', { name: 'Увійти' }));
    await u.click(await screen.findByRole('link', { name: 'Користувачі' }));
    await waitFor(() => { expect(rows()[0]).toContain('admin@example.test'); });
    expect(within(pager()).getByText('Сторінка 1')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lists(calls).at(-1)).toBeNull();
  });

  it('keyboard: the pager buttons are reachable and operable with Enter', async () => {
    backend(230);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const next = within(pager()).getByRole('button', { name: 'Далі' });
    next.focus();
    await userEvent.setup().keyboard('{Enter}');
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
  });
});

// Task 011.2: a create started on one page and answered after the user moved to another page must refresh the
// CURRENT page (its cursor), decide visibility from the current data, and never reload the abandoned cursor.
describe('create while paging', () => {
  async function startCreate(u: ReturnType<typeof userEvent.setup>, email = 'fresh@example.test') {
    await u.click(screen.getByRole('button', { name: 'Новий користувач' }));
    const form = screen.getByRole('form', { name: 'Новий користувач' });
    await u.type(within(form).getByLabelText('Email'), email);
    await u.type(within(form).getByLabelText('Початковий пароль'), 'synthetic-Fresh-Passw0rd');
    await u.click(within(form).getByRole('button', { name: 'Створити користувача' }));
  }
  function delayedCreate(total: number, reply: () => Response) {
    const post = deferred<undefined>();
    let posts = 0;
    const api = backend(total, (req) => {
      if (req.url === '/api/users' && req.method === 'POST') {
        posts += 1;
        return post.promise.then(reply);
      }
      return undefined;
    });
    return { ...api, release: post.resolve, posts: () => posts };
  }
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

  it('page 1 → pending create → "Далі" → late success: page 2 keeps its rows, only its cursor is reloaded, "Показати" works', async () => {
    const api = delayedCreate(230, () => json(201, { ...mk(230), email: 'fresh@example.test', role: 'operator' }));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await startCreate(u);
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    const before = lists(api.calls).length;
    api.users.push({ ...mk(230), email: 'fresh@example.test', role: 'operator' });
    api.release(undefined);
    await settle();
    expect(await screen.findByText(/fresh@example\.test створено.*наприкінці списку/)).toBeTruthy();
    expect(lists(api.calls).slice(before)).toEqual([id(99)]); // the current page's cursor, never the abandoned first page
    expect(within(pager()).getByText('Сторінка 2')).toBeTruthy();
    expect(rows()[0]).toContain('user100@example.test');
    expect(rows()).toHaveLength(PAGE);
    await u.click(screen.getByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows().some((r) => r.includes('fresh@example.test'))).toBe(true); });
    expect(within(pager()).getByText('Сторінка 3')).toBeTruthy();
    expect(api.posts()).toBe(1);
  });

  it('page 2 → pending create → "Назад" → late success: page 1 keeps its rows and is the one reloaded', async () => {
    const api = delayedCreate(230, () => json(201, { ...mk(230), email: 'fresh@example.test', role: 'operator' }));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    await startCreate(u);
    await u.click(within(pager()).getByRole('button', { name: 'Назад' }));
    await waitFor(() => { expect(rows()[0]).toContain('admin@example.test'); });
    const before = lists(api.calls).length;
    api.release(undefined);
    await settle();
    expect(await screen.findByText(/fresh@example\.test створено/)).toBeTruthy();
    expect(lists(api.calls).slice(before)).toEqual([null]);
    expect(within(pager()).getByText('Сторінка 1')).toBeTruthy();
    expect(rows()[0]).toContain('admin@example.test');
    expect(rows()).toHaveLength(PAGE);
  });

  it('a failed create after moving to another page keeps the current list; no reload, no invented row', async () => {
    const api = delayedCreate(230, () => json(409, {}));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await startCreate(u, 'dup@example.test');
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()[0]).toContain('user100@example.test'); });
    const before = lists(api.calls).length;
    api.release(undefined);
    await settle();
    expect(await screen.findByText('Користувач із таким email уже існує.')).toBeTruthy();
    expect(lists(api.calls).length).toBe(before);
    expect(rows()[0]).toContain('user100@example.test');
    expect(rows().some((r) => r.includes('dup@example.test'))).toBe(false);
  });

  it('logout and a new session during the POST: the late success has no callback, notice or reload', async () => {
    const api = delayedCreate(230, () => json(201, { ...mk(230), email: 'fresh@example.test', role: 'operator' }));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await startCreate(u);
    await u.click(screen.getByRole('button', { name: 'Вийти' }));
    await u.type(await screen.findByLabelText('Email'), 'admin@example.test');
    await u.type(screen.getByLabelText('Пароль'), 'synthetic-Admin-Passw0rd');
    await u.click(screen.getByRole('button', { name: 'Увійти' }));
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const before = lists(api.calls).length;
    api.release(undefined);
    await settle();
    expect(screen.queryByText(/fresh@example\.test створено/)).toBeNull();
    expect(lists(api.calls).length).toBe(before);
  });

  it('created while on the last page with room: shown there after reloading that page (no "Показати"); one POST', async () => {
    const api = delayedCreate(150, () => json(201, { ...mk(150), email: 'fresh@example.test', role: 'operator' }));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await startCreate(u);
    await u.click(within(pager()).getByRole('button', { name: 'Далі' }));
    await waitFor(() => { expect(rows()).toHaveLength(50); });
    api.users.push({ ...mk(150), email: 'fresh@example.test', role: 'operator' });
    api.release(undefined);
    await settle();
    expect(await screen.findByText('Користувача fresh@example.test створено (Оператор).')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показати fresh@example.test' })).toBeNull();
    await waitFor(() => { expect(rows().at(-1)).toContain('fresh@example.test'); });
    expect(within(pager()).getByText('Сторінка 2')).toBeTruthy();
    expect(api.posts()).toBe(1);
  });

  it('"Показати" walks a bounded number of pages', async () => {
    const api = backend(230, (req) => (req.url === '/api/users' && req.method === 'POST' ? json(201, { ...mk(999), email: 'ghost@example.test' }) : undefined));
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await startCreate(u, 'ghost@example.test'); // the mock never lists it: the walk must stop at the last page
    const before = lists(api.calls).length;
    await u.click(await screen.findByRole('button', { name: 'Показати ghost@example.test' }));
    expect(await screen.findByText(/Не вдалося знайти ghost@example\.test/)).toBeTruthy();
    expect(lists(api.calls).length - before).toBeLessThanOrEqual(4); // 3 pages (+ at most one reload)
  });
});
