import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIncidentPage } from '../src/api/types';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session, setViewportWidth } from './support';

// Alerts page (ADR-021, design NTF-01…07): honest engine/delivery state, never "all good" when off or unknown; tabs
// with their own cursor pages; search and filters only on the page in hand (said so, «Старіші» stays); delivery only
// where the API sends it (admin); a modal drawer built from the row only; late answers and revoked access never leave
// old data on screen.

const S = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const inc = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n), rule: 'process_down', severity: 'critical', status: 'firing', resolution: null,
  serverId: S, serverName: 'alpha', serverStatus: 'online', processName: 'api', pmId: 3, detail: { status: 'errored' },
  openedAt: '2026-10-14T10:00:00.000Z', lastObservedAt: '2026-10-14T10:05:00.000Z', resolvedAt: null, notification: null, ...over,
});
const closed = (n: number, over: Record<string, unknown> = {}) => inc(n, { status: 'resolved', resolution: 'recovered', resolvedAt: '2026-10-14T11:00:00.000Z', ...over });
const status = (over: Record<string, unknown> = {}) => ({
  engine: { enabled: true, running: true, lastEvaluationAt: '2026-10-14T10:06:00.000Z', lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: 0, admin: null, ...over,
});
const adminBlock = {
  webhookConfigured: true, publicUrlConfigured: true, intervalSeconds: 30, cooldownMinutes: 15, reminderMinutes: 0, maxAttempts: 6, queueMax: 100,
  thresholds: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
  queue: { queued: 1, sending: 0, sent: 7, failed: 1, unknown: 1, dropped: 0, cancelled: 0 }, lastSentAt: '2026-10-14T10:00:00.000Z', lastDeliveryError: 'http_500', lastEvaluationError: null,
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'admin' | 'operator' | 'viewer', route: Route = () => undefined) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url === '/api/alerts/status') return json(200, status());
    if (req.url.startsWith('/api/alerts?')) return json(200, { items: [], nextBefore: null });
    return json(404, {});
  });
}
const q = (req: RecordedRequest) => new URL(req.url, 'http://x').searchParams;
const isList = (req: RecordedRequest, state: 'active' | 'resolved') => req.url.startsWith('/api/alerts?') && q(req).get('state') === state;
const panel = () => screen.findByRole('tabpanel');
const rowOf = async (text: string) => (await within(await panel()).findByText(text)).closest('tr') as HTMLElement;

describe('alerts: engine state and NTF-04 (no active problems)', () => {
  it('engine disabled: explicit banner and an empty state that does not claim "no problems"', async () => {
    backend('viewer', (req) => (req.url === '/api/alerts/status' ? json(200, status({ engine: { enabled: false, running: false, lastEvaluationAt: null, lastEvaluationOk: null }, delivery: { enabled: false } })) : undefined));
    renderApp('/alerts');
    expect(await screen.findByText(/Рушій сповіщень вимкнено/)).toBeTruthy();
    expect(await screen.findByText('Рушій вимкнено — це не означає, що проблем немає.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Активних проблем немає' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/усе добре|все добре|все працює/i);
  });

  it('enabled and evaluated: «Активних проблем немає» names the time of the last evaluation', async () => {
    backend('operator');
    renderApp('/alerts');
    expect(await screen.findByRole('heading', { name: 'Активних проблем немає' })).toBeTruthy();
    expect(screen.getByText(/За останньою перевіркою .* відкритих проблем у вашому доступі немає\./)).toBeTruthy();
  });

  it.each([
    ['never evaluated', { enabled: true, running: true, lastEvaluationAt: null, lastEvaluationOk: null }, 'Перевірок ще не було.'],
    ['last evaluation failed', { enabled: true, running: true, lastEvaluationAt: '2026-10-14T10:06:00.000Z', lastEvaluationOk: false }, 'Остання перевірка завершилась з помилкою — поточний стан невідомий.'],
  ])('%s: no "no problems" claim', async (_name, engine, text) => {
    backend('viewer', (req) => (req.url === '/api/alerts/status' ? json(200, status({ engine })) : undefined));
    renderApp('/alerts');
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Активних проблем немає' })).toBeNull();
  });

  it('status failure and list success are separate: the list is shown, the empty state says the state is unknown; retry', async () => {
    let fail = true;
    const calls = backend('viewer', (req) => {
      if (req.url === '/api/alerts/status' && fail) return json(503, {}, { 'retry-after': '5' });
      return undefined;
    });
    renderApp('/alerts');
    expect(await screen.findByText(/Не вдалося отримати стан рушія: стан перевірок невідомий/)).toBeTruthy();
    expect(await screen.findByText('Стан рушія невідомий — це не означає, що проблем немає.')).toBeTruthy();
    // No count invented for the tab: without a status there is no total.
    expect(screen.getByRole('tab', { name: 'Активні проблеми' })).toBeTruthy();
    fail = false;
    const before = calls.filter((c) => c.url === '/api/alerts/status').length;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    await waitFor(() => { expect(calls.filter((c) => c.url === '/api/alerts/status').length).toBe(before + 1); });
    expect(await screen.findByRole('heading', { name: 'Активних проблем немає' })).toBeTruthy();
  });
});

describe('alerts: list (NTF-01/02) and its states (NTF-05/06/07)', () => {
  it('viewer: one table, problem / server+application / metric / times; no delivery column, no settings link; tab count = scoped activeCount', async () => {
    backend('viewer', (req) => {
      if (req.url === '/api/alerts/status') return json(200, status({ activeCount: 57 }));
      if (isList(req, 'active')) return json(200, { items: [inc(1), inc(2, { rule: 'process_cpu', severity: 'warning', detail: { value: 312, threshold: 90 }, serverStatus: 'offline', processName: 'worker' })], nextBefore: id(2) });
      return undefined;
    });
    renderApp('/alerts');
    expect(await screen.findByRole('tab', { name: 'Активні проблеми · 57' })).toBeTruthy();
    const errored = await rowOf('api');
    expect(within(errored).getByRole('button', { name: 'PM2-процес не працює' })).toBeTruthy();
    expect(within(errored).getByText('Активна · Критично')).toBeTruthy();
    expect(within(errored).getByText('errored')).toBeTruthy();
    const cpu = await rowOf('worker');
    expect(within(cpu).getByText('312 % CPU')).toBeTruthy(); // PM2 CPU may exceed 100 %
    expect(within(cpu).getByText('поріг 90 %')).toBeTruthy();
    expect(within(cpu).getByText('Сервер не звітує: стан не оновлюється')).toBeTruthy();
    // Page length and the scoped total are different numbers, both labelled.
    expect(within(await panel()).getByText(/На цій сторінці: 2 · усього активних у вашому доступі: 57/)).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Доставка' })).toBeNull();
    expect(within(screen.getByRole('heading', { level: 1, name: 'Сповіщення' }).closest('header') as HTMLElement).queryByRole('link')).toBeNull();
    expect(screen.queryByText(/Доставка й налаштування/)).toBeNull();
  });

  it('admin: delivery per incident in every state (incl. cancelled), Slack off now; settings link; no webhook value or admin block', async () => {
    const n = (state: string, over: Record<string, unknown> = {}) => ({ notify: true, state, attempts: 1, lastError: null, ...over });
    backend('admin', (req) => {
      if (req.url === '/api/alerts/status') return json(200, status({ admin: adminBlock, delivery: { enabled: false } }));
      if (isList(req, 'active')) {
        return json(200, { items: [
          inc(1, { processName: 'p-sent', notification: n('sent') }),
          inc(2, { processName: 'p-queued', notification: n('queued', { attempts: 0 }) }),
          inc(3, { processName: 'p-sending', notification: n('sending') }),
          inc(4, { processName: 'p-failed', notification: n('failed', { attempts: 6, lastError: 'http_500' }) }),
          inc(5, { processName: 'p-unknown', notification: n('unknown', { lastError: 'timeout' }) }),
          inc(6, { processName: 'p-dropped', notification: n('dropped') }),
          inc(7, { processName: 'p-cancelled', notification: n('cancelled') }),
          inc(8, { processName: 'p-none', notification: n('none', { attempts: 0 }) }),
          inc(9, { processName: 'p-cooldown', notification: { notify: false, state: 'none', attempts: 0, lastError: null } }),
        ], nextBefore: null });
      }
      return undefined;
    });
    renderApp('/alerts');
    expect(await screen.findByRole('columnheader', { name: 'Доставка' })).toBeTruthy();
    const cell = async (name: string) => (await rowOf(name)).lastElementChild as HTMLElement;
    expect((await cell('p-sent')).textContent).toBe('Надіслано');
    expect((await cell('p-queued')).textContent).toBe('У черзінадсилання зараз вимкнено');
    expect((await cell('p-sending')).textContent).toContain('Надсилається');
    expect((await cell('p-failed')).textContent).toBe('Не доставлено');
    expect((await cell('p-unknown')).textContent).toBe('Результат невідомийможливо, надіслано двічі');
    expect((await cell('p-dropped')).textContent).toBe('Відкинуто: черга переповнена');
    expect((await cell('p-cancelled')).textContent).toBe('Скасовано');
    expect((await cell('p-none')).textContent).toBe('Не надсилалось');
    expect((await cell('p-cooldown')).textContent).toBe('Без сповіщенняповтор у межах cooldown');
    // Distinct tones, not one colour for everything.
    expect((await cell('p-failed')).querySelector('.status--bad')).toBeTruthy();
    expect((await cell('p-unknown')).querySelector('.status--warn')).toBeTruthy();
    expect((await cell('p-queued')).querySelector('.status--info')).toBeTruthy();
    expect((await cell('p-sent')).querySelector('.status--ok')).toBeTruthy();
    expect(screen.getByText(/«Доставка» — результат саме цього інциденту/)).toBeTruthy();
    const header = screen.getByRole('heading', { level: 1, name: 'Сповіщення' }).closest('header') as HTMLElement;
    expect(within(header).getByRole('link', { name: 'Налаштування' }).getAttribute('href')).toBe('/settings/rules');
    expect(screen.queryByText(/Доставка й налаштування/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/hooks\.slack\.com|webhookConfigured/);
  });

  it('0 stays 0, missing stays «—»; a server problem has no invented process', async () => {
    backend('viewer', (req) => (isList(req, 'active') ? json(200, { items: [
      inc(1, { rule: 'process_restarts', severity: 'warning', processName: 'zero', detail: { delta: 0, spanSeconds: 600, threshold: 3 } }),
      inc(2, { rule: 'process_cpu', severity: 'warning', processName: 'nocpu', detail: { value: null, threshold: 90 } }),
      inc(3, { rule: 'server_offline', processName: null, pmId: null, serverName: 'gamma', serverStatus: 'offline', detail: { lastSeenAt: null } }),
    ], nextBefore: null }) : undefined));
    renderApp('/alerts');
    expect(within(await rowOf('zero')).getByText('0 рестартів за 10 хв')).toBeTruthy();
    const nocpu = await rowOf('nocpu');
    expect(within(nocpu).getByText('—')).toBeTruthy();
    expect(nocpu.textContent).not.toMatch(/0 % CPU/);
    const gamma = await rowOf('gamma');
    expect(within(gamma).getByText('Сигнал невідомий')).toBeTruthy();
    expect(gamma.querySelector('.incidents__app')?.textContent).toBe('—');
  });

  it('history: closing is not recovery (process_gone / excluded / retired / no reason); stopped may be intentional', async () => {
    backend('viewer', (req) => {
      if (isList(req, 'active')) return json(200, { items: [inc(9, { processName: 'stopper', severity: 'warning', detail: { status: 'stopped' } })], nextBefore: null });
      if (isList(req, 'resolved')) {
        return json(200, { items: [
          closed(1, { processName: 'gone', resolution: 'process_gone' }),
          closed(2, { processName: 'excl', resolution: 'excluded' }),
          closed(3, { processName: null, pmId: null, serverName: 'mem-server', rule: 'server_memory', severity: 'warning', resolution: 'retired', detail: { value: 93.5, threshold: 90 } }),
          closed(4, { processName: 'noreason', resolution: null }),
          closed(5, { processName: 'healed' }),
        ], nextBefore: null });
      }
      return undefined;
    });
    renderApp('/alerts');
    expect(within(await rowOf('stopper')).getByText('може бути навмисною зупинкою')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Історія' }));
    expect(await screen.findByRole('columnheader', { name: 'Закриття' })).toBeTruthy();
    expect(within(await rowOf('gone')).getByText('Процес зник з PM2 (відновлення не підтверджено)')).toBeTruthy();
    expect(within(await rowOf('excl')).getByText('Сервер виключено з моніторингу')).toBeTruthy();
    const mem = await rowOf('mem-server');
    expect(within(mem).getByText('Правило виведено з експлуатації (не відновлення)')).toBeTruthy();
    expect(within(mem).getByText('93,5 % пам’яті')).toBeTruthy();
    expect(within(await rowOf('noreason')).getByText('Причину не передано')).toBeTruthy();
    expect(within(await rowOf('healed')).getByText('Відновлено')).toBeTruthy();
    expect(within(await rowOf('healed')).getByText('Закрито')).toBeTruthy();
  });

  it('NTF-05 loading, then NTF-06 error without data: "unknown", never "no problems"; retry', async () => {
    const first = deferred<Response>();
    let n = 0;
    backend('viewer', (req) => {
      if (!isList(req, 'active')) return undefined;
      n += 1;
      return n === 1 ? first.promise : json(200, { items: [inc(1)], nextBefore: null });
    });
    renderApp('/alerts');
    expect(await screen.findByText('Завантаження проблем…')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Активних проблем/ })).toBeNull();
    await act(async () => { first.resolve(json(503, {})); await Promise.resolve(); });
    expect(await screen.findByRole('heading', { name: 'Не вдалося отримати проблеми' })).toBeTruthy();
    expect(screen.getByText(/Стан невідомий — це не означає, що проблем немає/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Активних проблем/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    expect(await rowOf('api')).toBeTruthy();
  });

  it('NTF-07 stale: a failed refresh keeps the previous rows under one warning with the time they were received', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    backend('viewer', (req) => (isList(req, 'active') ? (fail ? json(503, {}) : json(200, { items: [inc(1)], nextBefore: null })) : undefined));
    renderApp('/alerts');
    await rowOf('api');
    expect(within(await panel()).getByText(/^Отримано о /)).toBeTruthy();
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(await screen.findByText(/Дані застарілі · останнє отримання о /)).toBeTruthy();
    expect(screen.getByText(/Стан проблем і доставки після цього часу невідомий/)).toBeTruthy();
    expect(await rowOf('api')).toBeTruthy();
    expect(screen.getAllByText(/Дані застарілі/)).toHaveLength(1); // one warning, not one per row
    fail = false;
    await userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Оновити' }));
    await waitFor(() => { expect(screen.queryByText(/Дані застарілі/)).toBeNull(); });
  });

  it('phone width: records instead of a table, same facts; no table', async () => {
    setViewportWidth(390);
    backend('admin', (req) => {
      if (req.url === '/api/alerts/status') return json(200, status({ admin: adminBlock }));
      if (isList(req, 'active')) return json(200, { items: [inc(1, { notification: { notify: true, state: 'sent', attempts: 1, lastError: null } })], nextBefore: null });
      return undefined;
    });
    renderApp('/alerts');
    const record = await within(await panel()).findByRole('article', { name: 'PM2-процес не працює: alpha · api' });
    expect(within(record).getByText('alpha · api')).toBeTruthy();
    expect(within(record).getByText('errored')).toBeTruthy();
    expect(within(record).getByText(/^Початок /)).toBeTruthy();
    expect(within(record).getByText(/^Помічено /)).toBeTruthy();
    expect(within(record).getByText('Надіслано')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('alerts: page-local search and filters, paging, polling', () => {
  const page1 = { items: [
    inc(1, { processName: 'billing-api' }),
    inc(2, { processName: 'mailer', serverId: S2, serverName: 'beta', rule: 'process_cpu', severity: 'warning', detail: { value: 95, threshold: 90 } }),
    inc(3, { processName: 'reports', serverId: S2, serverName: 'beta' }),
  ], nextBefore: id(3) };

  it('search / server / type filter only this page, say so, keep «Старіші»; an empty filtered page offers the next one; reset', async () => {
    const calls = backend('viewer', (req) => {
      if (!isList(req, 'active')) return undefined;
      return json(200, q(req).get('before') === null ? page1 : { items: [inc(4, { processName: 'billing-worker' })], nextBefore: null });
    });
    renderApp('/alerts');
    await rowOf('billing-api');
    expect(screen.getByText(/Пошук і фільтри застосовуються лише до цієї сторінки \(до 25 записів\)/)).toBeTruthy();
    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Пошук на цій сторінці'), 'BILL');
    expect(within(await panel()).getByText(/На цій сторінці: 3 · за фільтром: 1/)).toBeTruthy();
    expect(within(await panel()).queryByText('mailer')).toBeNull();
    await u.clear(screen.getByLabelText('Пошук на цій сторінці'));
    await u.selectOptions(screen.getByLabelText('Сервер'), S2);
    await u.selectOptions(screen.getByLabelText('Тип проблеми'), 'process_cpu');
    expect(within(await panel()).getByText('mailer')).toBeTruthy();
    expect(within(await panel()).queryByText('reports')).toBeNull();
    // Nothing on this page: honest message, «Старіші» still available.
    await u.type(screen.getByLabelText('Пошук на цій сторінці'), 'nothing-here');
    expect(await screen.findByRole('heading', { name: 'На цій сторінці збігів немає' })).toBeTruthy();
    expect(screen.getByText(/Старіші записи можуть містити збіги/)).toBeTruthy();
    const older = screen.getByRole<HTMLButtonElement>('button', { name: 'Старіші' });
    expect(older.disabled).toBe(false);
    // Every request is the plain page request — no search or filter parameters the API does not have.
    for (const c of calls.filter((x) => x.url.startsWith('/api/alerts?'))) expect([...q(c).keys()].sort()).toEqual(c.url.includes('before=') ? ['before', 'limit', 'state'] : ['limit', 'state']);
    await u.click(screen.getAllByRole('button', { name: /^Скинути/ })[0] as HTMLElement);
    expect(within(await panel()).getByText(/^На цій сторінці: 3 · усього/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe('');
  });

  it('a filter on a server that is not on the next page stays visible and named; the page is not reset by it', async () => {
    backend('viewer', (req) => (isList(req, 'active') ? json(200, q(req).get('before') === null ? page1 : { items: [inc(5, { processName: 'other' })], nextBefore: null }) : undefined));
    renderApp('/alerts');
    await rowOf('billing-api');
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('Сервер'), S2);
    await u.click(screen.getByRole('button', { name: 'Старіші' }));
    expect(await screen.findByText('Сторінка 2')).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'beta (немає на цій сторінці)' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'На цій сторінці збігів немає' })).toBeTruthy();
  });

  it('active and history each page with their own cursor; switching tabs keeps each page', async () => {
    const calls = backend('viewer', (req) => {
      const before = req.url.startsWith('/api/alerts?') ? q(req).get('before') : null;
      if (isList(req, 'active')) return json(200, before === null ? { items: [inc(1, { processName: 'a1' })], nextBefore: id(1) } : { items: [inc(2, { processName: 'a2' })], nextBefore: null });
      if (isList(req, 'resolved')) return json(200, before === null ? { items: [closed(11, { processName: 'r1' })], nextBefore: id(11) } : { items: [closed(12, { processName: 'r2' })], nextBefore: null });
      return undefined;
    });
    renderApp('/alerts');
    const u = userEvent.setup();
    await rowOf('a1');
    await u.click(within(screen.getByRole('navigation', { name: 'Сторінки активних проблем' })).getByRole('button', { name: 'Старіші' }));
    expect(await rowOf('a2')).toBeTruthy();
    expect(calls.some((c) => isList(c, 'active') && q(c).get('before') === id(1))).toBe(true);
    await u.click(screen.getByRole('tab', { name: 'Історія' }));
    await rowOf('r1');
    const pager = screen.getByRole('navigation', { name: 'Сторінки історії' });
    await u.click(within(pager).getByRole('button', { name: 'Старіші' }));
    expect(await rowOf('r2')).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Сторінки історії' })).getByRole<HTMLButtonElement>('button', { name: 'Старіші' }).disabled).toBe(true);
    await u.click(screen.getByRole('tab', { name: /^Активні проблеми/ }));
    expect(await rowOf('a2')).toBeTruthy(); // still page 2
    await u.click(within(screen.getByRole('navigation', { name: 'Сторінки активних проблем' })).getByRole('button', { name: 'Новіші' }));
    expect(await rowOf('a1')).toBeTruthy();
  });

  it('polling refreshes the visible page only, keeps tab, page, filters and the open drawer; older pages are anchored by their cursor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = backend('viewer', (req) => {
      if (!isList(req, 'resolved')) return undefined;
      return json(200, q(req).get('before') === null ? { items: [closed(11, { processName: 'r1' })], nextBefore: id(11) } : { items: [closed(12, { processName: 'r2' }), closed(13, { processName: 'r3' })], nextBefore: null });
    });
    renderApp('/alerts');
    const u = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await u.click(await screen.findByRole('tab', { name: 'Історія' }));
    await u.click(await within(await screen.findByRole('navigation', { name: 'Сторінки історії' })).findByRole('button', { name: 'Старіші' }));
    await rowOf('r2');
    await u.type(screen.getByLabelText('Пошук на цій сторінці'), 'r3');
    await u.click(within(await rowOf('r3')).getByRole('button', { name: /PM2-процес не працює/ }));
    const before = calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const polled = calls.slice(before);
    expect(polled.filter((c) => isList(c, 'resolved') && q(c).get('before') === id(11))).toHaveLength(1);
    expect(polled.filter((c) => isList(c, 'active'))).toHaveLength(0); // the hidden tab is not polled
    expect(polled.filter((c) => c.url === '/api/alerts/status')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'PM2-процес не працює' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Історія' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Пошук на цій сторінці').value).toBe('r3');
    expect(screen.getByText('Сторінка 2')).toBeTruthy();
  });

  it('100–500 records are paged 25 at a time by cursor: never all at once, no request per row', async () => {
    const all = Array.from({ length: 500 }, (_, k) => closed(k + 1, { processName: `proc-${String(k + 1)}` }));
    const calls = backend('viewer', (req) => {
      if (!isList(req, 'resolved')) return undefined;
      const limit = Number(q(req).get('limit'));
      const before = q(req).get('before');
      const start = before === null ? 0 : all.findIndex((x) => x.id === before) + 1;
      const items = all.slice(start, start + limit);
      return json(200, { items, nextBefore: start + limit < all.length ? items.at(-1)?.id ?? null : null });
    });
    renderApp('/alerts');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Історія' }));
    await rowOf('proc-1');
    for (let p = 2; p <= 4; p += 1) {
      await u.click(within(screen.getByRole('navigation', { name: 'Сторінки історії' })).getByRole('button', { name: 'Старіші' }));
      await rowOf(`proc-${String((p - 1) * 25 + 1)}`);
    }
    expect(within(await panel()).getAllByRole('row')).toHaveLength(26);
    const lists = calls.filter((c) => c.url.startsWith('/api/alerts?'));
    for (const c of lists) expect(q(c).get('limit')).toBe('25');
    expect(calls.filter((c) => !c.url.startsWith('/api/alerts') && c.url !== '/api/auth/me')).toEqual([]);
  });
});

describe('alerts: details drawer (NTF-03)', () => {
  it('opens from the row: modal, named, focus on «Закрити деталі», Tab stays inside, Escape closes and focus returns; no request', async () => {
    const calls = backend('admin', (req) => {
      if (req.url === '/api/alerts/status') return json(200, status({ admin: adminBlock, delivery: { enabled: false } }));
      if (isList(req, 'active')) return json(200, { items: [inc(1, { rule: 'process_cpu', severity: 'warning', detail: { value: 126, threshold: 90 }, notification: { notify: true, state: 'sent', attempts: 2, lastError: null } })], nextBefore: null });
      return undefined;
    });
    renderApp('/alerts');
    const u = userEvent.setup();
    const opener = within(await rowOf('api')).getByRole('button', { name: 'Високе CPU процесу (PM2)' });
    const before = calls.length;
    await u.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Високе CPU процесу (PM2)' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Закрити деталі' }));
    // Facts from the row only; nothing invented.
    expect(within(dialog).getByText('Останнє спостереження')).toBeTruthy();
    expect(within(dialog).getByText('126 % CPU')).toBeTruthy();
    expect(within(dialog).getByText('Під час відкриття').nextElementSibling?.textContent).toBe('—');
    expect(within(dialog).getByText(/Значення під час відкриття не передається/)).toBeTruthy();
    expect(within(dialog).getByText('Не передано: поточний стан PM2 дивіться в «Застосунках»')).toBeTruthy();
    expect(within(dialog).getByText('Сторінку отримано браузером')).toBeTruthy();
    expect(within(dialog).getByText('Останнє спостереження рушієм')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Доставка повідомлення' })).toBeTruthy();
    expect(within(dialog).getByText(/не що його прочитали/)).toBeTruthy();
    expect(within(dialog).getByText(/повідомлення могло бути надіслане раніше/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Перезапустити|Повторити|Підтвердити|Закрити проблему/ })).toBeNull();
    // Focus trap: from the footer «Закрити» Tab wraps to the header button.
    within(dialog).getByRole('button', { name: 'Закрити' }).focus();
    await u.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Закрити деталі' }));
    await u.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Закрити' }));
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(calls.slice(before)).toEqual([]); // opening and closing send nothing
  });

  it('both close buttons close; a viewer gets no delivery section; a server problem names no process', async () => {
    backend('viewer', (req) => (isList(req, 'active') ? json(200, { items: [inc(1, { rule: 'server_offline', processName: null, pmId: null, serverStatus: 'offline', detail: { lastSeenAt: '2026-10-14T09:58:00.000Z' } })], nextBefore: null }) : undefined));
    renderApp('/alerts');
    const u = userEvent.setup();
    const opener = within(await rowOf('alpha')).getByRole('button', { name: 'Сервер не звітує' });
    await u.click(opener);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('— (проблема сервера)')).toBeTruthy();
    expect(within(dialog).queryByText('Стан процесу')).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: 'Доставка повідомлення' })).toBeNull();
    await u.click(within(dialog).getByRole('button', { name: 'Закрити' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    await u.click(opener);
    dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'Закрити деталі' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resolved: closing reason, «не означає відновлення», closing metric label', async () => {
    backend('viewer', (req) => (isList(req, 'resolved') ? json(200, { items: [closed(1, { resolution: 'process_gone', detail: { status: 'stopped' } }), closed(2, { processName: 'ok-proc', rule: 'process_cpu', severity: 'warning', detail: { value: 40, threshold: 90 } })], nextBefore: null }) : undefined));
    renderApp('/alerts');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Історія' }));
    await u.click(within(await rowOf('api')).getByRole('button', { name: 'PM2-процес не працює' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Процес зник з PM2 (відновлення не підтверджено)')).toBeTruthy();
    expect(within(dialog).getByText('Закриття не означає, що процес відновився.')).toBeTruthy();
    expect(within(dialog).getByText('Останнє спостереження до закриття')).toBeTruthy();
    await u.keyboard('{Escape}');
    await u.click(within(await rowOf('ok-proc')).getByRole('button', { name: 'Високе CPU процесу (PM2)' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('На момент закриття')).toBeTruthy();
    expect(within(dialog).queryByText('Закриття не означає, що процес відновився.')).toBeNull();
  });

  it('the incident disappears from a refresh (closed / access changed): the drawer closes, says why, focus goes to the page title', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gone = false;
    backend('viewer', (req) => (isList(req, 'active') ? json(200, { items: gone ? [inc(2, { processName: 'other' })] : [inc(1), inc(2, { processName: 'other' })], nextBefore: null }) : undefined));
    renderApp('/alerts');
    const u = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await u.click(within(await rowOf('api')).getByRole('button', { name: 'PM2-процес не працює' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    gone = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByText(/Проблеми більше немає на цій сторінці/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Сповіщення' }));
    expect(screen.queryByText('api')).toBeNull();
  });

  it('access revoked (403 on refresh): the page becomes «forbidden», no drawer or rows remain', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let revoked = false;
    backend('viewer', (req) => (isList(req, 'active') ? (revoked ? json(403, {}) : json(200, { items: [inc(1)], nextBefore: null })) : undefined));
    renderApp('/alerts');
    const u = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    await u.click(within(await rowOf('api')).getByRole('button', { name: 'PM2-процес не працює' }));
    revoked = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.queryByText('api')).toBeNull();
  });
});

describe('alerts: late answers', () => {
  it('a late answer of the previous tab never shows up in the new one', async () => {
    const slow = deferred<Response>();
    backend('viewer', (req) => {
      if (isList(req, 'active')) return slow.promise;
      if (isList(req, 'resolved')) return json(200, { items: [closed(2, { processName: 'history-proc' })], nextBefore: null });
      return undefined;
    });
    renderApp('/alerts');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('tab', { name: 'Історія' }));
    await rowOf('history-proc');
    await act(async () => { slow.resolve(json(200, { items: [inc(1, { processName: 'late-active' })], nextBefore: null })); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('late-active')).toBeNull();
    expect(await rowOf('history-proc')).toBeTruthy();
  });

  it('a late answer after logout is never shown', async () => {
    const late = deferred<Response>();
    backend('viewer', (req) => (isList(req, 'active') ? late.promise : undefined));
    renderApp('/alerts');
    await screen.findByText('Завантаження проблем…');
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Вийти' }));
    await act(async () => { late.resolve(json(200, { items: [inc(9)], nextBefore: null })); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('errored')).toBeNull();
    expect(await screen.findByLabelText('Email')).toBeTruthy();
  });
});

describe('alerts: contract', () => {
  it('the parser accepts every delivery state of the API, including cancelled', () => {
    const page = parseIncidentPage({ items: [inc(1, { notification: { notify: true, state: 'cancelled', attempts: 0, lastError: null } })], nextBefore: null });
    expect(page.items[0]?.notification?.state).toBe('cancelled');
  });
});
