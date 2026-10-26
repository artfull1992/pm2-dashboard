import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// Review 390ee8b (stage 3.4): (1) a create whose answer is lost is an UNKNOWN result, checked on request by a bounded
// read of the list (GET only, never a second POST), and a check that finds nothing never claims the user does not
// exist; (2) «Показати» really shows the target: filters that would hide it are cleared by that explicit action only.
// Synthetic users only; the fixture "creates" in memory.

const PAGE = 100;
const MULTI_PAGE_TEST_MS = 15_000;
const PASSWORD = 'synthetic-Fresh-Passw0rd';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; // n = 0 → the admin itself
const mk = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n), email: n === 0 ? 'admin@example.test' : `user${String(n).padStart(3, '0')}@example.test`, role: n === 0 ? 'admin' : 'viewer', isActive: true,
  createdAt: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), updatedAt: '2026-10-14T10:00:00.000Z', ...over,
});

const scrolled: Element[] = [];
const noScroll = Element.prototype.scrollIntoView; // the setup.ts no-op
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
});
afterEach(() => { vi.unstubAllGlobals(); Element.prototype.scrollIntoView = noScroll; });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
/** In-memory users; POST stores {email, role} from the body (like the server) unless `post` answers first. */
function backend(total: number, o: { route?: Route; post?: (stored: boolean) => Response | Promise<Response>; store?: boolean } = {}) {
  const users = Array.from({ length: total }, (_, n) => mk(n));
  const calls = installFetch((req) => {
    const r = o.route?.(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session('admin'));
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url.startsWith('/api/users?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const after = q.get('after');
      const start = after === null ? 0 : users.findIndex((u) => u.id === after) + 1;
      const items = users.slice(start, start + Number(q.get('limit')));
      return json(200, { items, nextAfter: start + items.length < users.length ? (items.at(-1)?.id ?? null) : null });
    }
    if (req.url === '/api/users' && req.method === 'POST') {
      const body = JSON.parse(req.body ?? '{}') as { email: string; role: string };
      const created = mk(users.length + 1000, { email: body.email.trim().toLowerCase(), role: body.role });
      if (o.store !== false) users.push(created);
      return o.post ? o.post(o.store !== false) : json(201, created);
    }
    return json(404, {});
  });
  const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/users').length;
  const gets = () => calls.filter((c) => c.url.startsWith('/api/users?'));
  return { calls, users, posts, gets };
}
/** The connection drops after the server has (or has not) stored the user: fetch rejects → ApiError 'network'. */
const lost = () => Promise.reject(new TypeError('Failed to fetch'));
const after = (c: RecordedRequest) => new URL(c.url, 'http://x').searchParams.get('after');
const rows = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((r) => r.querySelector('.users__email')?.textContent ?? '');
const pager = () => screen.getByRole('navigation', { name: 'Сторінки користувачів' });
const form = () => screen.getByRole('form', { name: 'Створення користувача' });
const roleFilter = () => screen.getByLabelText<HTMLSelectElement>('Роль');
const search = () => screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці');

async function create(u: ReturnType<typeof userEvent.setup>, email: string, role: 'viewer' | 'operator' | 'admin' = 'viewer') {
  await u.click(screen.getByRole('button', { name: 'Створити користувача' }));
  await u.type(within(form()).getByLabelText('Email'), email);
  await u.type(within(form()).getByLabelText('Початковий пароль'), PASSWORD);
  await u.selectOptions(within(form()).getByLabelText('Роль'), role);
  await u.click(within(form()).getByRole('button', { name: 'Створити' }));
}

describe('create with a lost answer (P2-1)', () => {
  it('created on the server, answer lost: unknown (not «failed»), password cleared, a GET-only check finds it on another page; one POST', async () => {
    const api = backend(230, { post: lost });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'Fresh@Example.test', 'operator');
    const alert = await within(form()).findByRole('alert');
    expect(within(alert).getByText('Результат невідомий')).toBeTruthy();
    expect(alert.textContent).toMatch(/користувача fresh@example\.test \(Оператор\) могли створити/);
    expect(within(form()).queryByText('Не вдалося створити користувача')).toBeNull();
    expect(within(form()).getByLabelText<HTMLInputElement>('Початковий пароль').value).toBe('');
    expect(within(form()).getByLabelText<HTMLInputElement>('Email').value).toBe('Fresh@Example.test');
    expect(within(form()).getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(api.users.filter((x) => x.email === 'fresh@example.test')).toHaveLength(1); // it does exist on the server
    // Editing the field afterwards does not change what is checked: the attempt that was actually sent.
    await u.clear(within(form()).getByLabelText('Email'));
    await u.type(within(form()).getByLabelText('Email'), 'other@example.test');
    const before = api.gets().length;
    await u.click(within(alert).getByRole('button', { name: 'Перечитати стан' }));
    const result = await within(form()).findByText(/Обліковий запис fresh@example\.test існує/);
    expect(result.closest('[role="status"]')?.textContent).toMatch(/Оператор, активний/);
    expect(result.closest('[role="status"]')?.textContent).toMatch(/пароль ця перевірка не перевіряє/i);
    // Page 1 had no match: the walk went on (keyset, from the first page) and found it on page 3.
    expect(api.gets().slice(before).map(after)).toEqual([null, id(99), id(199)]);
    expect(api.gets().slice(before).every((c) => c.method === 'GET' && c.body === undefined && !c.url.includes(PASSWORD))).toBe(true);
    expect(api.posts()).toBe(1);
    await u.click(within(form()).getByRole('button', { name: 'Відкрити fresh@example.test у списку' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => { expect(rows()).toContain('fresh@example.test'); });
    expect(within(pager()).getByText('Сторінка 3')).toBeTruthy();
    await u.click(within(pager()).getByRole('button', { name: 'Назад' }));
    await waitFor(() => { expect(within(pager()).getByText('Сторінка 2')).toBeTruthy(); });
    expect(api.posts()).toBe(1);
  }, MULTI_PAGE_TEST_MS);

  it('not stored, the whole list read: says so with the bound and keeps the result unknown (never «not created»)', async () => {
    const api = backend(150, { post: lost, store: false });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    await u.click(await within(form()).findByRole('button', { name: 'Перечитати стан' }));
    const note = await within(form()).findByText(/у списку на момент перевірки немає/);
    expect(note.textContent).toMatch(/2 сторінки/);
    expect(note.textContent).toMatch(/не доводить/);
    expect(within(form()).getByText('Результат невідомий')).toBeTruthy();
    expect(within(form()).queryByText(/не створено/)).toBeNull();
    expect(api.posts()).toBe(1);
  }, MULTI_PAGE_TEST_MS);

  it('the walk is bounded (MAX_SEEK_PAGES): a longer list ends with «checked the first N pages», still unknown', async () => {
    const api = backend(5_050, { post: lost, store: false });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    const before = api.gets().length;
    await u.click(await within(form()).findByRole('button', { name: 'Перечитати стан' }));
    const note = await within(form()).findByText(/Перевірено перші 50 сторінок/, {}, { timeout: 5_000 });
    expect(note.textContent).toMatch(/5000/);
    expect(api.gets().length - before).toBe(50);
    expect(within(form()).getByText('Результат невідомий')).toBeTruthy();
    expect(api.posts()).toBe(1);
  }, MULTI_PAGE_TEST_MS);

  it('a failed check is shown in the drawer, keeps the attempt and the unknown result; retry is possible; no POST', async () => {
    let failing = false;
    const api = backend(150, { post: lost, route: (req) => (failing && req.url.startsWith('/api/users?') ? json(503, {}, { 'retry-after': '7' }) : undefined) });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    failing = true;
    await u.click(await within(form()).findByRole('button', { name: 'Перечитати стан' }));
    const err = await within(form()).findByText(/Не вдалося перевірити список/);
    expect(err.closest('.notice')?.textContent).toMatch(/7 с/);
    expect(within(form()).getByText('Результат невідомий')).toBeTruthy();
    expect(within(form()).queryByText(/існує/)).toBeNull();
    failing = false;
    await u.click(within(form()).getByRole('button', { name: 'Перечитати стан' }));
    expect(await within(form()).findByText(/Обліковий запис fresh@example\.test існує/)).toBeTruthy();
    expect(api.posts()).toBe(1);
  }, MULTI_PAGE_TEST_MS);

  it('one check at a time: a second click while checking sends nothing; the check is announced', async () => {
    const slow = deferred<Response>();
    let hold = false;
    const api = backend(150, { post: lost, route: (req) => (hold && req.url.startsWith('/api/users?') ? slow.promise : undefined) });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    hold = true;
    const before = api.gets().length;
    const button = await within(form()).findByRole<HTMLButtonElement>('button', { name: 'Перечитати стан' });
    await u.click(button);
    const busy = within(form()).getByRole<HTMLButtonElement>('button', { name: 'Перевірка…' });
    expect(busy.disabled).toBe(true);
    await u.click(busy);
    expect(api.gets().length - before).toBe(1);
    expect(within(form()).getByRole<HTMLButtonElement>('button', { name: 'Створити' }).disabled).toBe(true); // no create while checking
    expect(api.posts()).toBe(1);
  });

  it('closing the drawer during a check aborts it; the late answer changes nothing', async () => {
    const slow = deferred<Response>();
    let hold = false;
    const api = backend(150, { post: lost, route: (req) => (hold && req.url.startsWith('/api/users?') ? slow.promise : undefined) });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    hold = true;
    await u.click(await within(form()).findByRole('button', { name: 'Перечитати стан' }));
    const check = api.gets().at(-1);
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Закрити' }));
    await u.click(screen.getByRole('button', { name: 'Закрити без збереження' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(check?.signal?.aborted).toBe(true);
    await act(async () => { slow.resolve(json(200, { items: [mk(1)], nextAfter: null })); await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/існує/)).toBeNull();
    expect(api.posts()).toBe(1);
  });

  it('401 during the check ends the session; nothing else is sent', async () => {
    let expired = false;
    const api = backend(150, { post: lost, route: (req) => (expired && (req.url.startsWith('/api/users?') || req.url === '/api/auth/me') ? json(401, {}) : undefined) });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    expired = true;
    await u.click(await within(form()).findByRole('button', { name: 'Перечитати стан' }));
    expect(await screen.findByRole('button', { name: 'Увійти' })).toBeTruthy();
    expect(screen.queryByText(/fresh@example\.test/)).toBeNull();
    expect(api.posts()).toBe(1);
  });

  it('403 on a later check removes the earlier found result (no stale privileged data shown as current)', async () => {
    let forbid = false;
    const api = backend(150, { post: lost, route: (req) => (forbid && req.url.startsWith('/api/users?') ? json(403, {}) : undefined) });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'fresh@example.test');
    await u.click(await within(form()).findByRole('button', { name: 'Перечитати стан' }));
    expect(await within(form()).findByText(/Обліковий запис fresh@example\.test існує/)).toBeTruthy();
    forbid = true;
    await u.click(within(form()).getByRole('button', { name: 'Перечитати стан' }));
    expect(await within(form()).findByText(/Недостатньо прав/)).toBeTruthy();
    expect(within(form()).queryByText(/існує/)).toBeNull();
    expect(within(form()).queryByRole('button', { name: /у списку$/ })).toBeNull();
    expect(api.posts()).toBe(1);
  });

  it('a confirmed refusal (409) stays a refusal: no unknown result, no check button', async () => {
    const api = backend(150, { post: () => json(409, {}), store: false });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await create(u, 'dup@example.test');
    expect(await within(form()).findByText('Не вдалося створити користувача')).toBeTruthy();
    expect(within(form()).getByText(/Користувач із таким email уже існує\./)).toBeTruthy();
    expect(within(form()).queryByRole('button', { name: 'Перечитати стан' })).toBeNull();
    expect(api.posts()).toBe(1);
  });
});

describe('«Показати» under filters (P2-2)', () => {
  async function filtered(u: ReturnType<typeof userEvent.setup>, f: { q?: string; role?: string }) {
    if (f.role) await u.selectOptions(roleFilter(), f.role);
    if (f.q) await u.type(search(), f.q);
  }

  it('incompatible role, target on the next page: «Показати» opens page 2, clears the role, the row is visible, focused and scrolled to', async () => {
    const api = backend(150);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { role: 'operator' });
    await create(u, 'fresh@example.test', 'viewer');
    await u.click(await screen.findByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows()).toContain('fresh@example.test'); });
    expect(within(pager()).getByText('Сторінка 2')).toBeTruthy();
    expect(roleFilter().value).toBe('');
    expect(screen.getByText(/Фільтр «Роль» скинуто, щоб показати fresh@example\.test/)).toBeTruthy();
    const cell = screen.getAllByText('fresh@example.test').find((el) => el.classList.contains('users__email'));
    await waitFor(() => { expect(document.activeElement).toBe(cell); });
    expect(scrolled).toContain(cell);
    expect(api.posts()).toBe(1);
    await u.click(within(pager()).getByRole('button', { name: 'Назад' }));
    await waitFor(() => { expect(within(pager()).getByText('Сторінка 1')).toBeTruthy(); });
  }, MULTI_PAGE_TEST_MS);

  it('incompatible search: cleared by «Показати»; a compatible role is kept', async () => {
    backend(150);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { role: 'viewer', q: 'user00' });
    await create(u, 'fresh@example.test', 'viewer');
    await u.click(await screen.findByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows()).toContain('fresh@example.test'); });
    expect(search().value).toBe('');
    expect(roleFilter().value).toBe('viewer');
    expect(screen.getByText(/Пошук скинуто, щоб показати fresh@example\.test/)).toBeTruthy();
  }, MULTI_PAGE_TEST_MS);

  it('both incompatible: both cleared; a compatible search is kept', async () => {
    backend(150);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { role: 'operator', q: 'nobody' });
    await create(u, 'fresh@example.test', 'viewer');
    await u.click(await screen.findByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows()).toContain('fresh@example.test'); });
    expect(search().value).toBe('');
    expect(roleFilter().value).toBe('');
    expect(screen.getByText(/Пошук і фільтр «Роль» скинуто/)).toBeTruthy();
  }, MULTI_PAGE_TEST_MS);

  it('compatible search is kept: «fresh» still shows the target', async () => {
    backend(150);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { q: 'FRESH' });
    await create(u, 'fresh@example.test', 'viewer');
    await u.click(await screen.findByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows()).toEqual(['fresh@example.test']); });
    expect(search().value).toBe('FRESH');
  }, MULTI_PAGE_TEST_MS);

  it('last page with room but hidden by the filter: no claim it is visible, «Показати» reveals it on the same page (reloaded, no polling)', async () => {
    const api = backend(50);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(50); });
    const u = userEvent.setup();
    await filtered(u, { role: 'operator' });
    await create(u, 'fresh@example.test', 'viewer');
    const notice = await screen.findByText(/Користувача fresh@example\.test створено/);
    expect(notice.textContent).toMatch(/приховує/);
    const before = api.gets().length;
    await u.click(screen.getByRole('button', { name: 'Показати fresh@example.test' }));
    await waitFor(() => { expect(rows()).toContain('fresh@example.test'); });
    expect(within(pager()).getByText('Сторінка 1')).toBeTruthy();
    expect(roleFilter().value).toBe('');
    expect(api.gets().length - before).toBeLessThanOrEqual(2); // the walk's one page (+ one reload of the same page)
  });

  it('last page with room and no hiding filter: shown after the reload, no «Показати» (unchanged)', async () => {
    backend(50);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(50); });
    const u = userEvent.setup();
    await filtered(u, { role: 'viewer' });
    await create(u, 'fresh@example.test', 'viewer');
    expect(await screen.findByText('Користувача fresh@example.test створено (Спостерігач, активний).')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показати fresh@example.test' })).toBeNull();
    await waitFor(() => { expect(rows()).toContain('fresh@example.test'); });
  });

  it('the seek fails: filters and page are kept, «Показати» stays for a retry', async () => {
    let failing = false;
    backend(150, { route: (req) => (failing && req.url.startsWith('/api/users?') ? json(503, {}) : undefined) });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { role: 'operator' });
    await create(u, 'fresh@example.test', 'viewer');
    const show = await screen.findByRole('button', { name: 'Показати fresh@example.test' });
    await waitFor(() => { expect(show.hasAttribute('disabled')).toBe(false); });
    failing = true;
    await u.click(show);
    expect(await screen.findByText(/Сервіс тимчасово недоступний/)).toBeTruthy();
    expect(roleFilter().value).toBe('operator');
    expect(within(pager()).getByText('Сторінка 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Показати fresh@example.test' })).toBeTruthy();
  }, MULTI_PAGE_TEST_MS);

  it('the seek reaches its bound without the target: filters are kept', async () => {
    backend(230, { store: false });
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { role: 'operator', q: 'x' });
    await create(u, 'ghost@example.test', 'viewer');
    await u.click(await screen.findByRole('button', { name: 'Показати ghost@example.test' }));
    expect(await screen.findByText(/Не вдалося знайти ghost@example\.test/)).toBeTruthy();
    expect(roleFilter().value).toBe('operator');
    expect(search().value).toBe('x');
  }, MULTI_PAGE_TEST_MS);

  it('closing forms normally keeps filters and the page (create cancel, own account)', async () => {
    backend(150);
    renderApp('/users');
    await waitFor(() => { expect(rows()).toHaveLength(PAGE); });
    const u = userEvent.setup();
    await filtered(u, { role: 'admin', q: 'admin' });
    await u.click(screen.getByRole('button', { name: 'Створити користувача' }));
    await u.click(within(form()).getByRole('button', { name: 'Скасувати' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(roleFilter().value).toBe('admin');
    expect(search().value).toBe('admin');
    await u.click(screen.getByRole('button', { name: 'Дії: admin@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Роль і активність' }));
    await u.keyboard('{Escape}');
    expect(roleFilter().value).toBe('admin');
    expect(rows()).toEqual(['admin@example.test']);
  });
});
