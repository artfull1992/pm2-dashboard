import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAuditPage } from '../src/api/types';
import { detailRows, eventLabel, isKnownEvent, reasonLabel, searchText, targetOf } from '../src/components/auditEvents';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session, setViewportWidth } from './support';

// Audit log (AUD-01…05): server order by id is kept (chunks appended, never re-sorted by time), the cursor comes from
// the API, duplicates are dropped by string id, a failed older chunk keeps the journal and is retried with the same
// cursor, search/filters only on loaded events (said so), details in the drawer from the loaded row only, honest
// actor/target fallbacks, plain text only, 401/403 and late answers handled. Synthetic values only.

afterEach(() => { vi.unstubAllGlobals(); });

const U1 = '0a1b2c3d-0000-4000-8000-000000000001';
const U2 = '0a1b2c3d-0000-4000-8000-000000000002';
const S1 = '5e1f0000-0000-4000-8000-0000000000aa';
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, occurredAt: '2026-10-23T07:21:48.000Z', event: 'auth.login', outcome: 'success', actorUserId: U1, requestId: 'req-0001', details: {}, ...extra,
});
const page = (items: unknown[], nextBeforeId: string | null = null) => ({ items, nextBeforeId });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(route: Route, role: 'admin' | 'operator' | 'viewer' = 'admin') {
  return installFetch((req) => {
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url === '/api/auth/logout') return noContent();
    const r = route(req);
    if (r) return r;
    if (req.url.startsWith('/api/dashboard')) return json(503, {});
    return json(404, {});
  });
}
const audits = (calls: RecordedRequest[]) => calls.filter((c) => c.url.startsWith('/api/audit')).map((c) => c.url);
/** A row of the table by a text in it (the event filter's <option> repeats event names, so search the table only). */
const rowOf = async (text: string) => (await within(await screen.findByRole('table')).findByText(text)).closest('tr') as HTMLElement;
const cursorOf = (req: RecordedRequest) => new URL(req.url, 'http://x').searchParams.get('beforeId');

describe('AUD-01 list: actor, action, target, result', () => {
  // These fixtures carry no `context`, as an older API: people are named by id, nothing is guessed.
  it('older API (no context): readable actions, actor ids, system / unknown / missing initiators, no name guessed from a key', async () => {
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page([
      item('9', { event: 'process.command_requested', actorUserId: U1, details: { serverId: S1, commandId: 'c-1', targetKey: 'api-service', action: 'restart' } }),
      item('8', { event: 'process.command_succeeded', actorUserId: null, requestId: null, details: { serverId: S1, commandId: 'c-1', targetKey: 'api-service', action: 'restart' } }),
      item('7', { event: 'auth.login', outcome: 'failure', actorUserId: null, details: { reason: 'invalid_credentials' } }),
      item('6', { event: 'authz.denied', outcome: 'denied', actorUserId: U2, details: { permission: 'audit:read', route: '/api/audit' } }),
      item('5', { event: 'future.event_code', actorUserId: null, details: {} }),
      item('4', { event: 'user.role_changed', details: { targetUserId: U2, fromRole: 'viewer', toRole: 'operator', sessionsRevoked: 0 } }),
    ])) : undefined));
    renderApp('/audit');
    const req = await rowOf('Запросив перезапуск');
    expect(within(req).getByText('Користувач 0a1b2c3d…').getAttribute('title')).toBe(U1);
    // No stored service name and no linked command: the key is not shown as a name (it is in the technical ids).
    expect(within(req).getByText('Назву застосунку не збережено')).toBeTruthy();
    expect(within(req).queryByText('api-service')).toBeNull();
    expect(within(req).getByText('сервер 5e1f0000…')).toBeTruthy();
    expect(within(req).getByText('Успіх')).toBeTruthy();
    const done = await rowOf('Перезапуск виконано');
    expect(within(done).getByText('Система')).toBeTruthy(); // a lifecycle step the server records itself
    const login = await rowOf('Невдала спроба входу');
    expect(within(login).getByText('Обліковий запис не встановлено')).toBeTruthy();
    expect(within(login).getByText('Невдача')).toBeTruthy();
    expect(within(login).getByText('невірні облікові дані')).toBeTruthy();
    const denied = await rowOf('Відмова в доступі');
    expect(within(denied).getByText('/api/audit')).toBeTruthy();
    expect(within(denied).getByText('потрібен дозвіл audit:read')).toBeTruthy();
    expect(within(denied).getByText('Відмовлено')).toBeTruthy();
    // Unknown code: shown as it is; no actor → «Ініціатора не встановлено», never «Система»; no target → «Не передано».
    const unknown = await rowOf('future.event_code');
    expect(within(unknown).getByText('Ініціатора не встановлено')).toBeTruthy();
    expect(within(unknown).getByText('Не передано')).toBeTruthy();
    expect(within(unknown).queryByText('Система')).toBeNull();
    const role = await rowOf('Змінив роль');
    expect(within(role).getByText('Користувач 0a1b2c3d…', { selector: '.audit__target' })).toBeTruthy();
    expect(within(role).getByText('viewer → operator')).toBeTruthy();
    // The request id is not repeated in every row (it is in the details).
    expect(screen.queryByText('req-0001')).toBeNull();
  });

  it('plain text only: an HTML payload in allowlisted text fields renders as text', async () => {
    const xss = '<img src=x onerror="window.__xss=1">';
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page([item('1', { event: xss, details: { route: xss, targetKey: xss } })])) : undefined));
    const { container } = renderApp('/audit');
    expect((await screen.findAllByText(xss)).length).toBeGreaterThan(0);
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('the parser keeps only the allowlist (secrets or unknown keys are dropped) and checks types', () => {
    const parsed = parseAuditPage(page([item('1', { details: { route: '/x', password: 'p', webhookUrl: 'https://hooks.example/abc', nested: { a: 1 }, revision: 0, stale: false } })]));
    expect(parsed.items[0]?.details).toEqual({ route: '/x', revision: 0, stale: false });
    expect(() => parseAuditPage(page([item('1', { details: { revision: -1 } })]))).toThrow();
    expect(() => parseAuditPage(page([item('1', { details: { stale: 'no' } })]))).toThrow();
    expect(() => parseAuditPage(page([item('1x')]))).toThrow();
  });

  it('phone width: records with the same essentials, no table', async () => {
    setViewportWidth(390);
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page([item('3', { event: 'logs.view_opened', details: { serverId: S1, targetKey: 'report-worker' } })])) : undefined));
    renderApp('/audit');
    const record = await screen.findByRole('article', { name: 'Переглянув логи: Успіх' });
    expect(within(record).getByText('Назву застосунку не збережено · сервер 5e1f0000…')).toBeTruthy();
    expect(within(record).getByText('Користувач 0a1b2c3d…')).toBeTruthy();
    expect(within(record).getByText(/^23\.10 · /)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('order, cursor and older chunks', () => {
  it('appends chunks in the server order (by id) even when times disagree; the cursor is the API\'s; ids above MAX_SAFE_INTEGER stay exact', async () => {
    const big = '9007199254740993'; // MAX_SAFE_INTEGER + 2: Number() would turn it into …992
    const calls = backend((req) => {
      if (req.url === '/api/audit?limit=25') {
        return json(200, page([item('9007199254740995', { event: 'auth.logout', occurredAt: '2026-10-23T07:00:00.000Z' }), item('9007199254740994', { event: 'auth.login', occurredAt: '2026-10-23T09:00:00.000Z' })], big));
      }
      if (req.url === `/api/audit?limit=25&beforeId=${big}`) return json(200, page([item('9007199254740992', { event: 'admin.bootstrap' })]));
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Вийшов');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Показати старіші' }));
    await rowOf('Створено адміністратора');
    const order = within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent);
    expect(order).toEqual(['Вийшов', 'Увійшов', 'Створено адміністратора']); // not re-sorted by time
    expect(audits(calls)).toEqual(['/api/audit?limit=25', `/api/audit?limit=25&beforeId=${big}`]);
    expect(screen.getByText('Старіших подій немає')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показати старіші' })).toBeNull();
  });

  it('a failed older chunk keeps the journal, says so, and «Повторити» asks for the same cursor; an overlapping answer adds no duplicates', async () => {
    let fail = true;
    const calls = backend((req) => {
      if (req.url === '/api/audit?limit=25') return json(200, page([item('30', { event: 'auth.logout' }), item('29')], '29'));
      if (req.url === '/api/audit?limit=25&beforeId=29') return fail ? json(503, {}, { 'retry-after': '5' }) : json(200, page([item('29'), item('28', { event: 'admin.bootstrap' })]));
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Вийшов');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Показати старіші' }));
    expect(await screen.findByText(/Не вдалося завантажити старіші події\. Завантажені записи збережено\. Спробуйте через 5 с\./)).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('rowheader')).toHaveLength(2);
    expect(screen.queryByText('Подій ще немає')).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Повторити' }));
    await rowOf('Створено адміністратора');
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Вийшов', 'Увійшов', 'Створено адміністратора']);
    expect(calls.filter((c) => cursorOf(c) === '29')).toHaveLength(2);
  });
});

describe('search and filters among loaded events', () => {
  it('filter only the loaded events (said so), count loaded and found apart, keep «Показати старіші» with no matches; the request never changes', async () => {
    const calls = backend((req) => {
      if (req.url === '/api/audit?limit=25') {
        return json(200, page([
          item('3', { event: 'logs.view_opened', details: { serverId: S1, targetKey: 'report-worker' } }),
          item('2', { event: 'authz.denied', outcome: 'denied', details: { permission: 'logs:read', route: '/api/x' } }),
          item('1', { event: 'auth.login', outcome: 'failure', actorUserId: null, details: { reason: 'inactive_user' } }),
        ], '1'));
      }
      if (req.url === '/api/audit?limit=25&beforeId=1') return json(200, page([item('0', { event: 'auth.logout' })]));
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Переглянув логи');
    expect(screen.getByText('Пошук і фільтри діють лише серед завантажених подій.')).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Пошук серед завантажених подій'), 'REPORT');
    expect(screen.getByText(/Завантажено: 3 · знайдено: 1/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Пошук серед завантажених подій'));
    await user.selectOptions(screen.getByLabelText('Результат'), 'denied');
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Відмова в доступі']);
    await user.selectOptions(screen.getByLabelText('Результат'), '');
    await user.selectOptions(screen.getByLabelText('Дія'), 'auth.login');
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Невдала спроба входу']);
    await user.type(screen.getByLabelText('Пошук серед завантажених подій'), 'nothing-here');
    expect(await screen.findByRole('heading', { name: 'Серед завантажених подій збігів немає' })).toBeTruthy();
    const older = screen.getByRole<HTMLButtonElement>('button', { name: 'Показати старіші' });
    expect(older.disabled).toBe(false);
    await user.click(older);
    await waitFor(() => { expect(screen.getByText(/Завантажено: 4 · знайдено: 0/)).toBeTruthy(); });
    expect(audits(calls)).toEqual(['/api/audit?limit=25', '/api/audit?limit=25&beforeId=1']); // the API cursor, no search params
    await user.click(screen.getAllByRole('button', { name: /^Скинути/ })[0] as HTMLElement);
    expect(within(screen.getByRole('table')).getAllByRole('rowheader')).toHaveLength(4);
  });
});

describe('AUD-03…05 states', () => {
  it('AUD-04 loading, then AUD-05 error that does not claim an empty journal; retry', async () => {
    const first = deferred<Response>();
    let n = 0;
    backend((req) => {
      if (!req.url.startsWith('/api/audit')) return undefined;
      n += 1;
      return n === 1 ? first.promise : json(200, page([item('1')]));
    });
    renderApp('/audit');
    expect(await screen.findByText('Завантаження журналу…')).toBeTruthy();
    await act(async () => { first.resolve(json(503, {}, { 'retry-after': '10' })); await Promise.resolve(); });
    expect(await screen.findByRole('heading', { name: 'Не вдалося завантажити журнал' })).toBeTruthy();
    expect(screen.getByText(/це не означає, що подій немає\. Спробуйте через 10 с\./)).toBeTruthy();
    expect(screen.queryByText('Подій ще немає')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    expect(await rowOf('Увійшов')).toBeTruthy();
  });

  it('an empty journal (successful) is said as such', async () => {
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page([])) : undefined));
    renderApp('/audit');
    expect(await screen.findByRole('heading', { name: 'Подій ще немає' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Показати старіші' })).toBeNull();
  });
});

describe('AUD-02 details drawer', () => {
  it('from the row only: full time with zone, actor id, target/context, allowlisted details (0 and false kept), technical ids; focus and Escape; no request', async () => {
    const calls = backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page([
      item('42', { event: 'process.command_succeeded', actorUserId: null, requestId: null, details: { serverId: S1, commandId: 'c-9', targetKey: 'api-service', action: 'restart' } }),
      item('41', { event: 'agent.credential_issued', details: { serverId: S1, rotated: false } }),
      item('40', { event: 'auth.password_change', details: { sessionsRevoked: 0 } }),
    ])) : undefined));
    renderApp('/audit');
    const user = userEvent.setup();
    const opener = within(await rowOf('Перезапуск виконано')).getByRole('button', { name: 'Перезапуск виконано' });
    const before = calls.length;
    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Перезапуск виконано' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Закрити деталі' }));
    expect(within(dialog).getByText(/^23\.10\.2026, \d\d:21:48 · .+/)).toBeTruthy(); // year, local time, zone
    expect(within(dialog).getByText('Автор запису').nextElementSibling?.textContent).toMatch(/^Система/);
    expect(within(dialog).getByText(/Успіх керуючої дії не означає, що процес зараз працює справно/)).toBeTruthy();
    expect(within(dialog).getByText('Перезапуск (restart)')).toBeTruthy();
    expect(within(dialog).getByText('Запит (ID)').nextElementSibling?.textContent).toBe('—');
    expect(within(dialog).getByText('Подія (ID)').nextElementSibling?.textContent).toBe('42');
    expect(within(dialog).getByText('Код події').nextElementSibling?.textContent).toBe('process.command_succeeded');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // 0 and false are values, not «absent».
    await user.click(within(await rowOf('Видав ключ агента')).getByRole('button', { name: 'Видав ключ агента' }));
    let d = await screen.findByRole('dialog');
    expect(within(d).getByText('Ключ замінено').nextElementSibling?.textContent).toBe('ні');
    await user.click(within(d).getByRole('button', { name: 'Закрити' }));
    await user.click(within(await rowOf('Змінив власний пароль')).getByRole('button', { name: 'Змінив власний пароль' }));
    d = await screen.findByRole('dialog');
    expect(within(d).getByText('Завершено сесій').nextElementSibling?.textContent).toBe('0');
    expect(within(d).getByText('Автор запису (ID)').nextElementSibling?.textContent).toBe(U1);
    expect(calls.slice(before)).toEqual([]);
  });
});

describe('refresh, access and sessions', () => {
  it('«Оновити» explicitly reloads the newest chunk (older chunks dropped, filters kept); a failed refresh keeps the journal', async () => {
    let round = 0;
    backend((req) => {
      if (req.url === '/api/audit?limit=25') {
        round += 1;
        if (round === 1) return json(200, page([item('2', { event: 'auth.logout' })], '2'));
        if (round === 2) return json(200, page([item('3', { event: 'admin.bootstrap' }), item('2', { event: 'auth.logout' })], '2'));
        return json(503, {});
      }
      if (req.url === '/api/audit?limit=25&beforeId=2') return json(200, page([item('1', { event: 'auth.login' })]));
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Вийшов');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Показати старіші' }));
    await rowOf('Увійшов');
    await user.selectOptions(screen.getByLabelText('Результат'), 'success');
    await user.click(screen.getByRole('button', { name: 'Оновити' }));
    await rowOf('Створено адміністратора');
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Створено адміністратора', 'Вийшов']);
    expect(screen.getByLabelText<HTMLSelectElement>('Результат').value).toBe('success');
    await user.click(screen.getByRole('button', { name: 'Оновити' }));
    expect(await screen.findByText(/Не вдалося оновити журнал\. Показано раніше завантажені події/)).toBeTruthy();
    expect(within(screen.getByRole('table')).getAllByRole('rowheader')).toHaveLength(2);
  });

  it('403 on an older chunk after a successful read: «forbidden», no list or drawer remains', async () => {
    backend((req) => {
      if (req.url === '/api/audit?limit=25') return json(200, page([item('2', { event: 'auth.logout' })], '2'));
      if (req.url === '/api/audit?limit=25&beforeId=2') return json(403, {});
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Вийшов');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Показати старіші' }));
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('rowheader', { name: 'Вийшов' })).toBeNull();
  });

  it('401 on an older chunk: the session ends, the journal is gone', async () => {
    backend((req) => {
      if (req.url === '/api/audit?limit=25') return json(200, page([item('2', { event: 'auth.logout' })], '2'));
      if (req.url === '/api/audit?limit=25&beforeId=2') return json(401, {});
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Вийшов');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Показати старіші' }));
    expect(await screen.findByText('Сесія завершилась. Увійдіть знову.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('late answers: an older chunk answered after «Оновити», and a first chunk answered after logout, change nothing', async () => {
    const older = deferred<Response>();
    let firsts = 0;
    backend((req) => {
      if (req.url === '/api/audit?limit=25') { firsts += 1; return json(200, page([item(firsts === 1 ? '2' : '3', { event: firsts === 1 ? 'auth.logout' : 'admin.bootstrap' })], firsts === 1 ? '2' : null)); }
      if (req.url === '/api/audit?limit=25&beforeId=2') return older.promise;
      return undefined;
    });
    renderApp('/audit');
    await rowOf('Вийшов');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Показати старіші' }));
    await user.click(screen.getByRole('button', { name: 'Оновити' }));
    await rowOf('Створено адміністратора');
    await act(async () => { older.resolve(json(200, page([item('1', { event: 'auth.login' })]))); await new Promise((r) => setTimeout(r, 20)); });
    expect(within(screen.getByRole('table')).queryByText('Увійшов')).toBeNull();
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Створено адміністратора']);
  });

  it('a first chunk answered after logout is never shown', async () => {
    const late = deferred<Response>();
    backend((req) => (req.url.startsWith('/api/audit') ? late.promise : undefined));
    renderApp('/audit');
    await screen.findByText('Завантаження журналу…');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Вийти' }));
    await act(async () => { late.resolve(json(200, page([item('1', { event: 'auth.logout' })]))); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole('table')).toBeNull();
    expect(await screen.findByLabelText('Email')).toBeTruthy();
  });

  it.each(['operator', 'viewer'] as const)('%s: no audit navigation; /audit is forbidden and the audit API is never called', async (role) => {
    const calls = backend(() => undefined, role);
    renderApp('/audit');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Журнал аудиту' })).toBeNull();
    expect(audits(calls)).toEqual([]);
  });
});

// Review fc6f2e4: codes are strings from the API; dictionary lookups must use own keys only. A code that matches an
// Object.prototype property (constructor, toString, __proto__, hasOwnProperty…) is an ordinary unknown code.
const PROTO_CODES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

describe('unknown codes that match Object.prototype properties', () => {
  it.each(['future.event_code', ...PROTO_CODES])('%s: label is the exact string, not known; reason/action fall back to the string', (code) => {
    expect(eventLabel(code)).toBe(code);
    expect(typeof eventLabel(code)).toBe('string');
    expect(isKnownEvent(code)).toBe(false);
    expect(reasonLabel(code)).toBe(code);
    const parsed = parseAuditPage(page([item('1', { event: code, details: { action: code, reason: code, targetKey: 'svc' } })])).items[0];
    expect(parsed).toBeDefined();
    if (!parsed) return;
    for (const [, value] of detailRows(parsed.details)) expect(typeof value).toBe('string');
    expect(detailRows(parsed.details)).toEqual(expect.arrayContaining([['Причина', code], ['Дія', code]]));
    expect(typeof targetOf(parsed).primary).toBe('string');
    expect(searchText(parsed)).toContain(code.toLocaleLowerCase('uk-UA'));
    expect([eventLabel('auth.login'), eventLabel(code)].sort((x, y) => x.localeCompare(y, 'uk'))).toHaveLength(2);
  });

  it('known labels are unchanged', () => {
    expect(eventLabel('auth.login')).toBe('Вхід');
    expect(isKnownEvent('auth.login')).toBe(true);
    expect(reasonLabel('invalid_credentials')).toBe('невірні облікові дані');
  });

  it('the page keeps the journal: rows, the «Дія» filter, search and the drawer work with such codes', async () => {
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page([
      item('9', { event: 'auth.login' }),
      ...PROTO_CODES.map((code, k) => item(String(8 - k), { event: code, details: { action: code, reason: code } })),
    ])) : undefined));
    renderApp('/audit');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['Увійшов', ...PROTO_CODES]);
    const options = within(screen.getByLabelText('Дія')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Усі дії', 'Вхід', ...PROTO_CODES]));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Дія'), 'constructor');
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['constructor']);
    await user.selectOptions(screen.getByLabelText('Дія'), '');
    await user.type(screen.getByLabelText('Пошук серед завантажених подій'), '__proto__');
    expect(within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(['__proto__']);
    await user.click(within(screen.getByRole('table')).getByRole('button', { name: '__proto__' }));
    const dialog = await screen.findByRole('dialog', { name: '__proto__' });
    expect(within(dialog).getByText('Код події').nextElementSibling?.textContent).toBe('__proto__');
    await user.click(within(dialog).getByRole('button', { name: 'Закрити' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
  });
});

// ADR-033: the API's read-time context makes rows readable — who (e-mail), what (the concrete action), on which
// application and server; a system step names the requester of its command, apart from the author of the row.
describe('readable context (ADR-033)', () => {
  const LONG = 'operator.with.a.rather.long.address.for.layout@example.test';
  const ctx = (over: Record<string, unknown> = {}) => ({ actorEmail: null, serverName: null, targetUserEmail: null, command: null, ...over });
  const command = { requestedBy: U1, requestedByEmail: 'admin@example.test', serviceName: 'orders-api' };
  const rows = [
    item('9', { event: 'process.command_requested', details: { serverId: S1, commandId: 'c-1', targetKey: 'api', action: 'restart', serviceName: 'orders-api' }, context: ctx({ actorEmail: 'admin@example.test', serverName: 'node-a', command }) }),
    item('8', { event: 'process.command_succeeded', actorUserId: null, requestId: null, details: { serverId: S1, commandId: 'c-1', targetKey: 'api', action: 'restart' }, context: ctx({ serverName: 'node-a', command }) }),
    item('7', { event: 'logs.view_opened', actorUserId: U2, details: { serverId: S1, targetKey: 'n-0123456789abcdef01234567' }, context: ctx({ actorEmail: LONG, serverName: 'node-a' }) }),
    item('6', { event: 'user.role_changed', details: { targetUserId: U2, fromRole: 'viewer', toRole: 'operator', sessionsRevoked: 0 }, context: ctx({ actorEmail: 'admin@example.test', targetUserEmail: LONG }) }),
    item('5', { event: 'auth.logout', actorUserId: U2, context: ctx() }), // the account is not found any more
  ];

  it('who / what / application / server are visible in the row; a system step names the requester apart', async () => {
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page(rows)) : undefined));
    renderApp('/audit');
    const req = await rowOf('Запросив перезапуск');
    expect(within(req).getByText('admin@example.test')).toBeTruthy();
    expect(within(req).getByText('orders-api')).toBeTruthy();
    expect(within(req).getByText('node-a')).toBeTruthy();
    const done = await rowOf('Перезапуск виконано');
    expect(within(done).getByText('admin@example.test')).toBeTruthy(); // the requester of the command
    expect(within(done).getByText('Системна подія · за запитом користувача')).toBeTruthy();
    expect(within(done).getByText('orders-api')).toBeTruthy(); // from the linked command (the row itself has no name)
    const logs = await rowOf('Переглянув логи');
    expect(within(logs).getByText(LONG)).toBeTruthy();
    expect(within(logs).getByText('Назву застосунку не збережено')).toBeTruthy(); // the opaque key is not decoded
    expect(within(logs).queryByText(/n-0123456789/)).toBeNull();
    const role = await rowOf('Змінив роль');
    expect(within(role).getByText(LONG, { selector: '.audit__target' })).toBeTruthy();
    expect(within(await rowOf('Вийшов')).getByText('Користувача не знайдено')).toBeTruthy();
  });

  it('details: author of the row and requester of the command apart, origin of each name, ids and the key only in the technical part', async () => {
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page(rows)) : undefined));
    renderApp('/audit');
    const user = userEvent.setup();
    await user.click(within(await rowOf('Перезапуск виконано')).getByRole('button', { name: 'Перезапуск виконано' }));
    const dialog = await screen.findByRole('dialog', { name: 'Перезапуск виконано' });
    const row = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent ?? '';
    expect(row('Автор запису')).toMatch(/^Система/);
    expect(row('Замовник команди')).toMatch(/^admin@example\.test/);
    expect(row('Застосунок')).toBe('orders-apiз пов’язаної команди (збережено під час запиту)');
    expect(row('Сервер')).toBe('node-aпоточна назва на момент перегляду');
    expect(within(dialog).getByText(/Email і назви серверів — поточні на момент перегляду/)).toBeTruthy();
    expect(row('Замовник команди (ID)')).toBe(U1);
    expect(row('Ключ цілі')).toBe('api');
    await user.keyboard('{Escape}');
    await user.click(within(await rowOf('Переглянув логи')).getByRole('button', { name: 'Переглянув логи' }));
    const logs = await screen.findByRole('dialog', { name: 'Переглянув логи' });
    expect(within(logs).getByText('Застосунок').nextElementSibling?.textContent).toMatch(/^Назву застосунку не збережено/);
    expect(within(logs).getByText('Ключ цілі').nextElementSibling?.textContent).toBe('n-0123456789abcdef01234567');
  });

  it('local search finds e-mails, server, application, target user and the readable action', async () => {
    backend((req) => (req.url === '/api/audit?limit=25' ? json(200, page(rows)) : undefined));
    renderApp('/audit');
    await rowOf('Запросив перезапуск');
    const user = userEvent.setup();
    const search = screen.getByLabelText('Пошук серед завантажених подій');
    const found = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((th) => th.textContent);
    for (const [q, expected] of [
      ['orders-api', ['Запросив перезапуск', 'Перезапуск виконано']],
      ['rather.long', ['Переглянув логи', 'Змінив роль']],
      ['NODE-A', ['Запросив перезапуск', 'Перезапуск виконано', 'Переглянув логи']],
      ['переглянув', ['Переглянув логи']],
    ] as const) {
      await user.clear(search);
      await user.type(search, q);
      expect(found()).toEqual(expected);
    }
  });

  it('the parser: context absent → null (older API); present → every field checked', () => {
    expect(parseAuditPage(page([item('1')])).items[0]?.context).toBeNull();
    expect(parseAuditPage(page([item('1', { context: ctx({ serverName: 'node-a', command }) })])).items[0]?.context).toEqual(ctx({ serverName: 'node-a', command }));
    expect(() => parseAuditPage(page([item('1', { context: ctx({ serverName: 42 }) })]))).toThrow();
    expect(() => parseAuditPage(page([item('1', { context: ctx({ command: { requestedBy: U1 } }) })]))).toThrow();
    expect(() => parseAuditPage(page([item('1', { context: 'x' })]))).toThrow();
  });
});
