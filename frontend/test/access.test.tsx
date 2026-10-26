import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetUsersViewsForTests } from '../src/pages/usersView';
import { CSRF, deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// The access page /users/:id/access (ACL-01…15, ADR-028/035): per-server grants of operators/viewers edited as a
// draft and saved atomically with the revision they were based on; admin is shown as full access; nothing is reported
// as saved before the API answers; conflicts and lost answers are checked by an explicit GET, never retried.

const ADMIN_ID = '00000000-0000-4000-8000-000000000000';
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GAMMA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAGE = `/users/${OTHER_ID}/access`;
const API = `/api/users/${OTHER_ID}/access`;
const user = (id: string, email: string, role: string) => ({ id, email, role, isActive: true, createdAt: '2026-10-14T10:00:00.000Z', updatedAt: '2026-10-14T10:00:00.000Z' });
const access = (over: Record<string, unknown> = {}) => ({ userId: OTHER_ID, email: 'other@example.test', role: 'operator', isActive: true, global: false, revision: 0, servers: [], ...over });
const grant = (serverId: string, serverName: string, mode: 'all' | 'selected', services: { name: string; available: boolean }[] = []) =>
  ({ serverId, serverName, serverActive: true, mode, grantedAt: '2026-10-20T10:00:00.000Z', services });
const ok = (name: string) => ({ name, available: true });
const catalog: Record<string, string[]> = { [ALPHA]: ['api', 'worker'], [BETA]: ['api', 'web'], [GAMMA]: [] };
const serverOptions = [{ id: ALPHA, name: 'alpha', isActive: true }, { id: BETA, name: 'beta', isActive: true }, { id: GAMMA, name: 'gamma', isActive: false }];

afterEach(() => { vi.unstubAllGlobals(); forgetUsersViewsForTests(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route = () => undefined, initial: Record<string, unknown> = access()) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session('admin'));
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url.startsWith('/api/users?')) return json(200, { items: [user(ADMIN_ID, 'admin@example.test', 'admin'), user(OTHER_ID, 'other@example.test', 'operator')], nextAfter: null });
    if (req.url === API && req.method === 'GET') return json(200, initial);
    if (req.url.startsWith('/api/access/servers?')) return json(200, { items: serverOptions, nextAfterName: null });
    const svc = /^\/api\/access\/servers\/([0-9a-f-]{36})\/services(?:\?q=(.*))?$/.exec(req.url);
    if (svc) {
      const id = svc[1] ?? '';
      const q = decodeURIComponent(svc[2] ?? '').toLowerCase();
      return json(200, { serverId: id, items: (catalog[id] ?? []).filter((n) => n.includes(q)).map((name) => ({ name, processes: 1 })), truncated: false });
    }
    return json(404, {});
  });
}
const puts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'PUT');
const body = (r: RecordedRequest | undefined): unknown => JSON.parse(r?.body ?? '');
const saveButton = () => screen.getByRole('button', { name: /^(Зберегти|Збереження…)$/ });
const footer = () => screen.getByRole('group', { name: 'Збереження доступів' });
const serverButton = (name: RegExp) => screen.getByRole('button', { name });
const addServer = async (u: ReturnType<typeof userEvent.setup>, name: string) => {
  await u.click(await screen.findByRole('button', { name: /Додати сервер$/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Додати сервер' });
  await u.click(await within(dialog).findByRole('button', { name: `Додати ${name}` }));
};
async function openPage(initial?: Record<string, unknown>, route?: Route) {
  const calls = backend(route, initial);
  const app = renderApp(PAGE);
  await screen.findByRole('heading', { name: 'Доступи користувача' });
  return { calls, app, u: userEvent.setup() };
}

describe('ACL page: address, context and load states', () => {
  it('Users → «Сервери та сервіси» opens /users/:id/access; «← Користувачі» restores page and filters; Back restores too', async () => {
    const PAGE2 = '44444444-4444-4444-8444-444444444444';
    const calls = backend((req) => {
      if (req.url.startsWith('/api/users?') && req.url.includes(`after=${PAGE2}`)) {
        return json(200, { items: [user(OTHER_ID, 'other@example.test', 'operator'), user(THIRD_ID, 'third@example.test', 'viewer')], nextAfter: null });
      }
      if (req.url.startsWith('/api/users?')) return json(200, { items: [user(ADMIN_ID, 'admin@example.test', 'admin')], nextAfter: PAGE2 });
      return undefined;
    });
    const { router } = renderApp('/users');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Далі' }));
    expect(await screen.findByText('Сторінка 2')).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Роль'), 'operator');
    await u.click(screen.getByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Сервери та сервіси' }));
    expect(await screen.findByRole('heading', { name: 'Доступи користувача' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(PAGE);
    await u.click(screen.getByRole('link', { name: '← Користувачі' }));
    expect(await screen.findByText('Сторінка 2')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(screen.queryByText('third@example.test')).toBeNull(); // the role filter is applied again
    // The browser's Back from the access page returns to the list entry as it was left.
    await u.click(screen.getByRole('button', { name: 'Дії: other@example.test' }));
    await u.click(screen.getByRole('menuitem', { name: 'Сервери та сервіси' }));
    await screen.findByRole('heading', { name: 'Доступи користувача' });
    await act(async () => { await router.navigate(-1); });
    expect(await screen.findByText('Сторінка 2')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Роль').value).toBe('operator');
    expect(calls.some((c) => c.method !== 'GET' && c.url !== '/api/auth/me')).toBe(false);
  });

  it('direct URL: one GET of the access (no users list); context; ACL-01 empty state; Save off; «Скасувати» → plain /users', async () => {
    const { calls, app, u } = await openPage();
    expect(await screen.findByText('other@example.test')).toBeTruthy();
    expect(screen.getByText('Оператор')).toBeTruthy();
    expect(screen.getByText('Керування та логи в межах доступів')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Доступів немає' })).toBeTruthy();
    expect(within(footer()).getByText('Змін немає')).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(calls.filter((c) => c.url === API)).toHaveLength(1);
    expect(calls.some((c) => c.url.startsWith('/api/users?'))).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull(); // a page, not a modal: no focus trap, the app stays usable
    expect(document.getElementById('root')?.hasAttribute('inert') ?? false).toBe(false);
    await u.click(within(footer()).getByRole('button', { name: 'Скасувати' }));
    await waitFor(() => { expect(app.router.state.location.pathname).toBe('/users'); });
    expect(await screen.findByText('Сторінка 1')).toBeTruthy();
  });

  it('invalid id: «not found» without any request; 404: not found, nothing to save', async () => {
    const calls = backend();
    renderApp('/users/not-a-uuid/access');
    expect(await screen.findByRole('heading', { name: 'Користувача не знайдено' })).toBeTruthy();
    expect(screen.getByText('Посилання на доступи некоректне.')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/access'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull();
  });

  it('404 / 403 / 401 on load: not found, «Недостатньо прав» without editor data, sign-in', async () => {
    backend((req) => (req.url === API ? json(404, {}) : undefined));
    const first = renderApp(PAGE);
    expect(await screen.findByRole('heading', { name: 'Користувача не знайдено' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull();
    first.unmount();
    backend((req) => (req.url === API ? json(403, {}) : undefined));
    const second = renderApp(PAGE);
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(screen.queryByText('other@example.test')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull();
    second.unmount();
    backend((req) => (req.url === API ? json(401, {}) : undefined));
    renderApp(PAGE);
    expect(await screen.findByRole('button', { name: 'Увійти' })).toBeTruthy();
  });

  it('a user without users:manage gets «Недостатньо прав» and no request for the access', async () => {
    const calls = installFetch((req) => (req.url === '/api/auth/me' ? json(200, session('operator')) : json(404, {})));
    renderApp(PAGE);
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/access'))).toBe(false);
  });

  it('ACL-08 load failure: not an empty access, Save unavailable; «Повторити запит» loads it', async () => {
    let fail = true;
    backend((req) => (req.url === API && fail ? json(503, {}) : undefined), access({ servers: [grant(ALPHA, 'alpha', 'all')] }));
    renderApp(PAGE);
    expect(await screen.findByRole('heading', { name: 'Не вдалося отримати доступи' })).toBeTruthy();
    expect(screen.getByText(/Це помилка завантаження, а не відсутність доступів/)).toBeTruthy();
    expect(screen.queryByText('Доступів немає')).toBeNull();
    expect(within(footer()).getByText('Дані не завантажено')).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', true);
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Повторити запит' }));
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy();
  });

  it('admin target: «Повний доступ», no editor, no Save, no PUT', async () => {
    const { calls } = await openPage(access({ role: 'admin', global: true }));
    expect(await screen.findByRole('heading', { name: 'Повний доступ' })).toBeTruthy();
    expect(screen.getByText(/Окремі доступи його не обмежують/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Додати сервер/ })).toBeNull();
    expect(puts(calls)).toHaveLength(0);
  });

  it('ACL-13 inactive viewer: grants shown as grants (not «no access»), deactivation explained, viewer limits said', async () => {
    await openPage(access({ role: 'viewer', isActive: false, servers: [grant(ALPHA, 'alpha', 'all')] }));
    expect(await screen.findByText('Спостерігач')).toBeTruthy();
    expect(screen.getByText('Перегляд без логів і керування')).toBeTruthy();
    expect(screen.getByText('неактивний')).toBeTruthy();
    expect(screen.getByText('Користувач деактивований')).toBeTruthy();
    expect(screen.queryByText('Доступів немає')).toBeNull();
    expect(screen.getByText(/навіть за «Усі сервіси» без логів і команд/)).toBeTruthy();
  });
});

describe('ACL page: draft of servers and services', () => {
  it('ACL-02…04: independent scopes per server; switching keeps drafts; same names on two servers are separate; exact payload', async () => {
    const reply = deferred<Response>();
    const { calls, u } = await openPage(access({ revision: 3, servers: [grant(ALPHA, 'alpha', 'selected', [ok('api')]), grant(BETA, 'beta', 'all')] }),
      (req) => (req.method === 'PUT' ? reply.promise : undefined));
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy();
    expect(serverButton(/^alpha: Вибрано сервісів: 1$/).getAttribute('aria-current')).toBe('true');
    expect(await screen.findByRole<HTMLInputElement>('checkbox', { name: 'api' })).toHaveProperty('checked', true);
    await u.click(screen.getByRole('checkbox', { name: 'worker' }));
    expect(within(footer()).getByText('Є незбережені зміни')).toBeTruthy();
    await u.click(serverButton(/^beta: Усі поточні й майбутні$/));
    expect(await screen.findByRole('heading', { name: 'beta' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Усі сервіси — поточні й майбутні/ }).checked).toBe(true);
    expect(screen.getByText('Доступ до всіх сервісів сервера')).toBeTruthy();
    await u.click(screen.getByRole('radio', { name: /Вибрані сервіси/ }));
    // beta's «api» is another grant than alpha's «api»: not chosen here.
    expect(await screen.findByRole<HTMLInputElement>('checkbox', { name: 'api' })).toHaveProperty('checked', false);
    await u.click(screen.getByRole('checkbox', { name: 'web' }));
    await u.click(serverButton(/^alpha:/));
    expect(await screen.findByRole<HTMLInputElement>('checkbox', { name: 'worker' })).toHaveProperty('checked', true); // draft kept
    await u.click(saveButton());
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(body(puts(calls)[0])).toEqual({ expectedRevision: 3, servers: [
      { serverId: ALPHA, mode: 'selected', services: ['api', 'worker'] },
      { serverId: BETA, mode: 'selected', services: ['web'] },
    ] });
    reply.resolve(json(500, {}));
    expect(await screen.findByText('Не вдалося зберегти доступи')).toBeTruthy();
  });

  it('selected → all → selected restores the local choice; «all» sends no names; back to baseline clears dirty', async () => {
    const { calls, u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'selected', [ok('api')])] }), (req) => (req.method === 'PUT' ? json(200, access({ revision: 1, servers: [grant(ALPHA, 'alpha', 'all')] })) : undefined));
    await screen.findByRole('checkbox', { name: 'api' });
    await u.click(screen.getByRole('radio', { name: /Усі сервіси/ }));
    expect(screen.getByText(/Попередній вибір \(1\) лишається в чернетці/)).toBeTruthy();
    await u.click(screen.getByRole('radio', { name: /Вибрані сервіси/ }));
    expect(await screen.findByRole<HTMLInputElement>('checkbox', { name: 'api' })).toHaveProperty('checked', true);
    expect(within(footer()).getByText('Змін немає')).toBeTruthy(); // semantically the baseline again
    expect(saveButton()).toHaveProperty('disabled', true);
    await u.click(screen.getByRole('radio', { name: /Усі сервіси/ }));
    await u.click(saveButton());
    await waitFor(() => { expect(puts(calls)).toHaveLength(1); });
    expect(body(puts(calls)[0])).toEqual({ expectedRevision: 0, servers: [{ serverId: ALPHA, mode: 'all', services: [] }] });
  });

  it('gone grants stay (marked), can be removed explicitly and re-chosen; they are never dropped by the catalog', async () => {
    const { calls, u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'selected', [ok('api'), { name: 'old-job', available: false }])] }),
      (req) => (req.method === 'PUT' ? json(200, access({ revision: 1 })) : undefined));
    expect(await screen.findByText('зник із сервера')).toBeTruthy();
    const gone = screen.getByRole<HTMLInputElement>('checkbox', { name: /old-job/ });
    expect(gone.checked).toBe(true);
    expect(screen.getByText('Вибрано: 2')).toBeTruthy();
    await u.click(gone);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /old-job/ }).checked).toBe(false); // still listed
    await u.click(saveButton());
    await waitFor(() => { expect(puts(calls)).toHaveLength(1); });
    expect(body(puts(calls)[0])).toEqual({ expectedRevision: 0, servers: [{ serverId: ALPHA, mode: 'selected', services: ['api'] }] });
  });

  it('ACL-05/06 search: only the view changes; the choice outside it is kept and counted; no matches said; Enter does not save', async () => {
    const { calls, u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'selected', [ok('api')])] }));
    await screen.findByRole('checkbox', { name: 'api' });
    const search = screen.getByLabelText('Пошук сервісів цього сервера');
    await u.type(search, 'work');
    await waitFor(() => { expect(screen.queryByRole('checkbox', { name: 'api' })).toBeNull(); });
    expect(screen.getByText('Вибрано: 1')).toBeTruthy();
    expect(screen.getByText('Ще 1 вибраних поза пошуком — вибір збережено')).toBeTruthy();
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    expect(screen.getByText('Вибрано: 2')).toBeTruthy();
    await u.type(search, '{Enter}');
    await u.clear(search);
    await u.type(search, 'zzz');
    expect(await screen.findByText('Сервісів за запитом «zzz» не знайдено. Пошук не змінює вибір.')).toBeTruthy();
    await u.clear(search);
    expect(await screen.findByRole<HTMLInputElement>('checkbox', { name: 'api' })).toHaveProperty('checked', true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'worker' }).checked).toBe(true);
    expect(puts(calls)).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull(); // searching asks nothing
  });

  it('catalog: over 500 is said to be truncated; an error keeps the choice and retries; an empty server is explained', async () => {
    let fail = true;
    const { u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'selected', [ok('svc-999')]), grant(GAMMA, 'gamma', 'selected', [ok('x')])] }), (req) => {
      if (req.url.startsWith(`/api/access/servers/${ALPHA}/services`)) {
        if (fail) return json(503, {});
        return json(200, { serverId: ALPHA, items: Array.from({ length: 500 }, (_, i) => ({ name: `svc-${String(i).padStart(3, '0')}`, processes: 1 })), truncated: true });
      }
      return undefined;
    });
    expect(await screen.findByText('Не вдалося завантажити сервіси')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'svc-999' }).checked).toBe(true); // the draft stays
    fail = false;
    await u.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(await screen.findByText(/Показано перші 500 — це не повний каталог/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /svc-999/ }).checked).toBe(true); // beyond the first 500, kept
    await u.click(serverButton(/^gamma:/));
    expect(await screen.findByText(/На сервері ще немає відомих сервісів/)).toBeTruthy();
  });

  it('a new server is «selected» with nothing chosen: Save blocked and explained; remove the last server → revoke-all draft', async () => {
    const reply = deferred<Response>();
    const { calls, u } = await openPage(access({ revision: 2, servers: [grant(BETA, 'beta', 'all')] }), (req) => (req.method === 'PUT' ? reply.promise : undefined));
    await addServer(u, 'alpha');
    expect(await screen.findByRole('heading', { name: 'alpha' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'alpha' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Вибрані сервіси/ }).checked).toBe(true);
    expect(screen.getByText(/Виберіть хоча б один сервіс або приберіть сервер/)).toBeTruthy();
    expect(within(footer()).getByText(/alpha: виберіть сервіси або приберіть сервер/)).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(puts(calls)).toHaveLength(0);
    // ACL-11: removing asks first; «Продовжити редагування» changes nothing.
    await u.click(screen.getByRole('button', { name: 'Прибрати доступ до alpha' }));
    let dialog = screen.getByRole('dialog', { name: 'Прибрати доступ до сервера?' });
    expect(within(dialog).getByText(/Реальний доступ зміниться лише після «Зберегти»/)).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Продовжити редагування' }));
    expect(screen.getByRole('heading', { name: 'alpha' })).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Прибрати доступ до alpha' }));
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Прибрати з чернетки' }));
    expect(await screen.findByRole('heading', { name: 'beta' })).toBeTruthy(); // selection moves to an existing server
    expect(within(footer()).getByText('Змін немає'));
    await u.click(screen.getByRole('button', { name: 'Прибрати доступ до beta' }));
    dialog = screen.getByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Прибрати з чернетки' }));
    expect(await screen.findByText(/Після «Зберегти» всі доступи користувача буде відкликано; доти вони діють/)).toBeTruthy();
    expect(saveButton()).toHaveProperty('disabled', false);
    await u.click(saveButton());
    expect(body(puts(calls)[0])).toEqual({ expectedRevision: 2, servers: [] });
    reply.resolve(json(200, access({ revision: 3 })));
    expect(await screen.findByText(/Доступи прибрано \(ревізія 3\)/)).toBeTruthy();
  });
});

describe('ACL-14/15 add a server', () => {
  it('servers in the draft are not offered; «Показати ще» loads the next page of the SAME query; no matches; Escape closes', async () => {
    const { calls, u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'all')] }), (req) => {
      if (!req.url.startsWith('/api/access/servers?')) return undefined;
      const url = new URL(req.url, 'http://x');
      const q = url.searchParams.get('q');
      if (q === 'zzz') return json(200, { items: [], nextAfterName: null });
      if (q === 'be') return json(200, { items: [{ id: BETA, name: 'beta', isActive: true }], nextAfterName: null });
      if (url.searchParams.get('afterName') === 'beta') return json(200, { items: [{ id: GAMMA, name: 'gamma', isActive: false }], nextAfterName: null });
      return json(200, { items: [{ id: ALPHA, name: 'alpha', isActive: true }, { id: BETA, name: 'beta', isActive: true }], nextAfterName: 'beta' });
    });
    const opener = await screen.findByRole('button', { name: '+ Додати сервер' });
    await u.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Додати сервер' });
    expect(await within(dialog).findByRole('button', { name: 'Додати beta' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Додати alpha' })).toBeNull();
    expect(within(dialog).getByText(/Повний доступ не надається автоматично/)).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Показати ще' }));
    expect(await within(dialog).findByRole('button', { name: 'Додати gamma' })).toBeTruthy();
    expect(within(dialog).getByText('неактивний')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('afterName=beta'))).toBe(true);
    await u.type(within(dialog).getByLabelText('Пошук серверів для призначення'), 'zzz');
    expect(await within(dialog).findByText('Серверів за запитом «zzz» не знайдено.')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Додати gamma' })).toBeNull(); // the old query's pages are gone
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(puts(calls)).toHaveLength(0);
  });

  it('a late answer of an older query never replaces the current one', async () => {
    const slow = deferred<Response>();
    const { u } = await openPage(access(), (req) => {
      if (req.url.startsWith('/api/access/servers?') && !req.url.includes('q=')) return slow.promise;
      if (req.url.startsWith('/api/access/servers?')) return json(200, { items: [{ id: BETA, name: 'beta', isActive: true }], nextAfterName: null });
      return undefined;
    });
    await u.click(await screen.findByRole('button', { name: 'Додати сервер' }));
    const dialog = await screen.findByRole('dialog', { name: 'Додати сервер' });
    await u.type(within(dialog).getByLabelText('Пошук серверів для призначення'), 'be');
    expect(await within(dialog).findByRole('button', { name: 'Додати beta' })).toBeTruthy();
    await act(async () => { slow.resolve(json(200, { items: [{ id: ALPHA, name: 'alpha', isActive: true }], nextAfterName: null })); await Promise.resolve(); });
    expect(within(dialog).queryByRole('button', { name: 'Додати alpha' })).toBeNull();
  });
});

describe('ACL-07/12 leaving with unsaved changes', () => {
  it('links, «Скасувати» and Back ask first; «Продовжити редагування» keeps draft and focus; «Відкинути зміни» leaves', async () => {
    backend(undefined, access({ servers: [grant(ALPHA, 'alpha', 'all')] }));
    const app = renderApp('/users'); // a history entry before the page, for Back
    await screen.findByText('Сторінка 1');
    await act(async () => { await app.router.navigate(PAGE); });
    const u = userEvent.setup();
    await screen.findByRole('heading', { name: 'alpha' });
    await u.click(screen.getByRole('radio', { name: /Вибрані сервіси/ }));
    await u.click(await screen.findByRole('checkbox', { name: 'api' }));
    // Switching servers and searching ask nothing.
    await u.type(screen.getByLabelText('Пошук сервісів цього сервера'), 'a');
    expect(screen.queryByRole('dialog')).toBeNull();
    // A sidebar link.
    const link = screen.getByRole('link', { name: 'Огляд' });
    await u.click(link);
    let dialog = await screen.findByRole('dialog', { name: 'Скасувати зміни?' });
    expect(within(dialog).getByText('Незбережені зміни буде втрачено. Поточні збережені доступи не зміняться.')).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Продовжити редагування' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(app.router.state.location.pathname).toBe(PAGE);
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'api' }).checked).toBe(true);
    // Browser Back / Forward (history POP).
    await act(async () => { await app.router.navigate(-1); });
    expect(await screen.findByRole('dialog', { name: 'Скасувати зміни?' })).toBeTruthy();
    await u.keyboard('{Escape}');
    expect(app.router.state.location.pathname).toBe(PAGE);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'api' }).checked).toBe(true);
    // «Скасувати» in the save bar, then discard.
    await u.click(within(footer()).getByRole('button', { name: 'Скасувати' }));
    dialog = await screen.findByRole('dialog', { name: 'Скасувати зміни?' });
    await u.click(within(dialog).getByRole('button', { name: 'Відкинути зміни' }));
    await waitFor(() => { expect(app.router.state.location.pathname).toBe('/users'); });
  });

  it('reload / closing the tab is guarded only while there is something to lose', async () => {
    const { u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'all')] }));
    await screen.findByRole('heading', { name: 'alpha' });
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(false);
    await u.click(screen.getByRole('radio', { name: /Вибрані сервіси/ }));
    expect(unload()).toBe(true); // the scope changed: a draft to lose
  });

  it('switching to another user id never shows the previous draft; a late answer of the previous user is dropped', async () => {
    const slow = deferred<Response>();
    backend((req) => {
      if (req.url === API) return slow.promise;
      if (req.url === `/api/users/${THIRD_ID}/access`) return json(200, access({ userId: THIRD_ID, email: 'third@example.test', role: 'viewer', servers: [grant(BETA, 'beta', 'all')] }));
      return undefined;
    });
    const { router } = renderApp(PAGE);
    await screen.findByText('Завантаження доступів…');
    await act(async () => { await router.navigate(`/users/${THIRD_ID}/access`); });
    expect(await screen.findByText('third@example.test')).toBeTruthy();
    await act(async () => { slow.resolve(json(200, access({ servers: [grant(ALPHA, 'alpha', 'all')] }))); await Promise.resolve(); });
    expect(screen.queryByText('other@example.test')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'alpha' })).toBeNull();
  });

  it('logout with a draft: the session ends, the sign-in shows, nothing of the draft returns', async () => {
    const { calls, u } = await openPage(access({ servers: [grant(ALPHA, 'alpha', 'all')] }));
    await screen.findByRole('heading', { name: 'alpha' });
    await u.click(screen.getByRole('radio', { name: /Вибрані сервіси/ }));
    await u.click(screen.getByRole('button', { name: 'Вийти' }));
    expect(await screen.findByRole('button', { name: 'Увійти' })).toBeTruthy();
    expect(screen.queryByText('other@example.test')).toBeNull();
    expect(puts(calls)).toHaveLength(0);
  });
});

describe('ACL-09/10 saving, conflicts and unknown results', () => {
  const start = access({ revision: 4, servers: [grant(ALPHA, 'alpha', 'selected', [ok('api')])] });

  it('ACL-10: one PUT; editing and a second submit blocked while pending; success only after the answer; next PUT uses the new revision', async () => {
    const first = deferred<Response>();
    let n = 0;
    const { calls, u } = await openPage(start, (req) => {
      if (req.method !== 'PUT') return undefined;
      n += 1;
      return n === 1 ? first.promise : json(200, access({ revision: 6, servers: [grant(ALPHA, 'alpha', 'all')] }));
    });
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    expect(screen.getByRole('button', { name: 'Збереження…' })).toHaveProperty('disabled', true);
    expect(within(footer()).getByRole('status').textContent).toBe('Збереження…');
    expect(screen.getByRole('checkbox', { name: 'worker' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /Усі сервіси/ }).matches(':disabled')).toBe(true); // the fieldset is disabled
    expect(screen.getByRole('button', { name: '+ Додати сервер' })).toHaveProperty('disabled', true);
    fireEvent.click(saveButton());
    expect(puts(calls)).toHaveLength(1);
    expect(screen.queryByText(/Доступи збережено/)).toBeNull();
    // Leaving while pending: said honestly, the request is not «cancelled».
    await u.click(screen.getByRole('link', { name: 'Огляд' }));
    const dialog = await screen.findByRole('dialog', { name: 'Збереження ще триває' });
    expect(within(dialog).getByText(/вихід його не скасує/)).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Залишитися' }));
    await act(async () => { first.resolve(json(200, access({ revision: 5, servers: [grant(ALPHA, 'alpha', 'selected', [ok('api'), ok('worker')])] }))); await Promise.resolve(); });
    expect(await screen.findByText(/Доступи збережено \(ревізія 5\)/)).toBeTruthy();
    expect(within(footer()).getByText('Змін немає')).toBeTruthy();
    await u.click(screen.getByRole('radio', { name: /Усі сервіси/ }));
    await u.click(saveButton());
    await waitFor(() => { expect(puts(calls)).toHaveLength(2); });
    expect(body(puts(calls)[1])).toEqual({ expectedRevision: 5, servers: [{ serverId: ALPHA, mode: 'all', services: [] }] });
  });

  it('ACL-09 refused: the draft stays, the reason is said; 403 on save drops the editor', async () => {
    let status = 400;
    const { calls, u } = await openPage(start, (req) => (req.method === 'PUT' ? json(status, {}) : undefined));
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    expect(await screen.findByText('Не вдалося зберегти доступи')).toBeTruthy();
    expect(screen.getByText(/Ваші зміни залишилися в редакторі/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'worker' }).checked).toBe(true);
    status = 403;
    await u.click(saveButton());
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(puts(calls)).toHaveLength(2);
  });

  it('409: nothing overwritten, never retried; the stored state is read on request; keeping the draft is an explicit choice', async () => {
    let gets = 0;
    const remote = access({ revision: 7, servers: [grant(BETA, 'beta', 'all')] });
    const { calls, u } = await openPage(undefined, (req) => {
      if (req.method === 'PUT') return puts(calls).length === 1 ? json(409, {}) : json(200, access({ revision: 8 }));
      if (req.url === API) { gets += 1; return json(200, gets === 1 ? start : remote); }
      return undefined;
    });
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    expect(await screen.findByText('Доступи змінилися після відкриття сторінки')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'worker' }).checked).toBe(true);
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(within(footer()).getByText(/застарілій версії/)).toBeTruthy();
    expect(puts(calls)).toHaveLength(1);
    await u.click(screen.getByRole('button', { name: 'Переглянути актуальний стан' }));
    expect(await screen.findByText('Актуальний збережений стан (ревізія 7) відрізняється від вашої чернетки')).toBeTruthy();
    expect(screen.getByText('beta — Усі поточні й майбутні')).toBeTruthy();
    expect(gets).toBe(2);
    expect(puts(calls)).toHaveLength(1); // reading never writes
    await u.click(screen.getByRole('button', { name: 'Залишити чернетку на актуальній версії' }));
    expect(screen.getByText(/Чернетку перенесено на актуальну ревізію 7/)).toBeTruthy();
    await u.click(saveButton());
    await waitFor(() => { expect(puts(calls)).toHaveLength(2); });
    expect(body(puts(calls)[1])).toEqual({ expectedRevision: 7, servers: [{ serverId: ALPHA, mode: 'selected', services: ['api', 'worker'] }] });
  });

  it('409 → discard the draft (asked first) shows the stored state', async () => {
    let gets = 0;
    const { u } = await openPage(undefined, (req) => {
      if (req.method === 'PUT') return json(409, {});
      if (req.url === API) { gets += 1; return json(200, gets === 1 ? start : access({ revision: 9, servers: [grant(BETA, 'beta', 'all')] })); }
      return undefined;
    });
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    await u.click(await screen.findByRole('button', { name: 'Переглянути актуальний стан' }));
    await u.click(await screen.findByRole('button', { name: 'Відкинути чернетку й показати актуальний стан' }));
    const dialog = screen.getByRole('dialog', { name: 'Відкинути чернетку?' });
    await u.click(within(dialog).getByRole('button', { name: 'Відкинути чернетку' }));
    expect(await screen.findByRole('heading', { name: 'beta' })).toBeTruthy();
    expect(screen.getByText(/Показано актуальний збережений стан \(ревізія 9\)/)).toBeTruthy();
    expect(within(footer()).getByText('Змін немає')).toBeTruthy();
  });

  it('lost answer: «unknown», no retry; a failed check proves nothing; stored = draft → confirmed state without claiming authorship', async () => {
    let gets = 0;
    let check: 'fail' | 'saved' = 'fail';
    const saved = access({ revision: 5, servers: [grant(ALPHA, 'alpha', 'selected', [ok('api'), ok('worker')])] });
    const { calls, u } = await openPage(undefined, (req) => {
      if (req.method === 'PUT') return Promise.reject(new TypeError('Failed to fetch'));
      if (req.url === API) { gets += 1; return gets === 1 ? json(200, start) : check === 'fail' ? json(503, {}) : json(200, saved); }
      return undefined;
    });
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    expect(await screen.findByText('Результат невідомий')).toBeTruthy();
    expect(screen.getByText(/доступи могли зберегтися/)).toBeTruthy();
    expect(screen.queryByText(/Доступи збережено/)).toBeNull();
    expect(saveButton()).toHaveProperty('disabled', true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'worker' }).checked).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Перевірити збережений стан' }));
    expect(await screen.findByText(/Не вдалося прочитати збережений стан.*Результат збереження лишається невідомим/)).toBeTruthy();
    expect(screen.getByText('Результат невідомий')).toBeTruthy();
    check = 'saved';
    await u.click(screen.getByRole('button', { name: 'Перевірити збережений стан' }));
    expect(await screen.findByText(/збігаються з вашою чернеткою.*не показує/)).toBeTruthy();
    expect(within(footer()).getByText('Змін немає')).toBeTruthy();
    expect(puts(calls)).toHaveLength(1);
  });

  it('lost answer, stored state unchanged: the draft stays and may be saved again with the same revision (explicitly)', async () => {
    let n = 0;
    const { calls, u } = await openPage(start, (req) => {
      if (req.method === 'PUT') { n += 1; return n === 1 ? Promise.reject(new TypeError('Failed to fetch')) : json(200, access({ revision: 5 })); }
      return undefined;
    });
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    await u.click(await screen.findByRole('button', { name: 'Перевірити збережений стан' }));
    expect(await screen.findByText(/не змінилися \(ревізія 4\).*на момент перевірки зміни не застосовано/)).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'worker' }).checked).toBe(true);
    expect(puts(calls)).toHaveLength(1);
    await u.click(saveButton());
    await waitFor(() => { expect(puts(calls)).toHaveLength(2); });
    expect(body(puts(calls)[1])).toMatchObject({ expectedRevision: 4 });
  });

  it('the check finds the user became an admin: no editing on stale assumptions', async () => {
    let gets = 0;
    const { u } = await openPage(undefined, (req) => {
      if (req.method === 'PUT') return json(409, {});
      if (req.url === API) { gets += 1; return json(200, gets === 1 ? start : access({ role: 'admin', global: true, revision: 6 })); }
      return undefined;
    });
    await u.click(await screen.findByRole('checkbox', { name: 'worker' }));
    await u.click(saveButton());
    await u.click(await screen.findByRole('button', { name: 'Переглянути актуальний стан' }));
    expect(await screen.findByRole('heading', { name: 'Повний доступ' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull();
  });
});
