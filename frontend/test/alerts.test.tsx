import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// Alerts page (Task 013, ADR-021): honest engine/delivery state, never "all good" when off or unknown, delivery details
// only where the API provides them (admin), resolved history paging, late answers ignored.

const S = '22222222-2222-4222-8222-222222222222';
const inc = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, rule: 'process_down', severity: 'critical', status: 'firing', resolution: null,
  serverId: S, serverName: 'alpha', serverStatus: 'online', processName: 'api', pmId: 3, detail: { status: 'errored' },
  openedAt: '2026-10-14T10:00:00.000Z', lastObservedAt: '2026-10-14T10:05:00.000Z', resolvedAt: null, notification: null, ...over,
});
const status = (over: Record<string, unknown> = {}) => ({
  engine: { enabled: true, running: true, lastEvaluationAt: '2026-10-14T10:06:00.000Z', lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: 0, admin: null, ...over,
});
const adminBlock = {
  webhookConfigured: true, publicUrlConfigured: true, intervalSeconds: 30, cooldownMinutes: 15, reminderMinutes: 0, maxAttempts: 6, queueMax: 100,
  thresholds: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
  queue: { queued: 1, sending: 0, sent: 7, failed: 1, unknown: 1, dropped: 0 }, lastSentAt: '2026-10-14T10:00:00.000Z', lastDeliveryError: 'http_500', lastEvaluationError: null,
};

afterEach(() => { vi.unstubAllGlobals(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'admin' | 'operator' | 'viewer', route: Route) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url === '/api/auth/login') return json(200, session(role));
    if (req.url === '/api/alerts/status') return json(200, status());
    if (req.url.startsWith('/api/alerts?')) return json(200, { items: [], nextBefore: null });
    return json(404, {});
  });
}

describe('alerts page', () => {
  it('engine disabled: explicit banner and an empty state that does not claim "no problems"', async () => {
    backend('viewer', (req) => (req.url === '/api/alerts/status' ? json(200, status({ engine: { enabled: false, running: false, lastEvaluationAt: null, lastEvaluationOk: null }, delivery: { enabled: false } })) : undefined));
    renderApp('/alerts');
    expect(await screen.findByText(/Рушій сповіщень вимкнено/)).toBeTruthy();
    expect(screen.getByText('Рушій вимкнено — це не означає, що проблем немає.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/усе добре|все добре|все працює/i);
  });

  it('viewer: navigation item, active incidents with human wording, no delivery column and no admin panel', async () => {
    backend('viewer', (req) => (req.url.startsWith('/api/alerts?state=active') ? json(200, {
      items: [inc(1), inc(2, { rule: 'process_cpu', severity: 'warning', detail: { value: 312, threshold: 90 }, serverStatus: 'offline' })], nextBefore: null,
    }) : undefined));
    renderApp('/');
    await userEvent.setup().click(await screen.findByRole('link', { name: 'Сповіщення' }));
    const active = (await screen.findByRole('heading', { name: /Активні проблеми/ })).closest('section') as HTMLElement;
    expect(await within(active).findByText('Статус errored')).toBeTruthy();
    expect(within(active).getByText('Критично')).toBeTruthy();
    expect(within(active).getByText('CPU 312 % (поріг 90 %)')).toBeTruthy(); // PM2 CPU may exceed 100 %
    expect(within(active).getByText('Сервер не звітує: стан не оновлюється')).toBeTruthy(); // stale data is labelled
    expect(within(active).queryByRole('columnheader', { name: 'Сповіщення' })).toBeNull();
    expect(screen.queryByText(/Доставка й налаштування/)).toBeNull();
    expect(screen.getByText('Надсилання в Slack увімкнено.')).toBeTruthy();
  });

  it('admin: delivery state per incident (failed / unknown / suppressed by cooldown) and the panel without any webhook value', async () => {
    backend('admin', (req) => {
      if (req.url === '/api/alerts/status') return json(200, status({ admin: adminBlock }));
      if (req.url.startsWith('/api/alerts?state=active')) {
        return json(200, { items: [
          inc(1, { notification: { notify: true, state: 'failed', attempts: 6, lastError: 'http_500' } }),
          inc(2, { notification: { notify: true, state: 'unknown', attempts: 6, lastError: 'timeout' } }),
          inc(3, { notification: { notify: false, state: 'none', attempts: 0, lastError: null } }),
        ], nextBefore: null });
      }
      return undefined;
    });
    renderApp('/alerts');
    const active = (await screen.findByRole('heading', { name: /Активні проблеми/ })).closest('section') as HTMLElement;
    expect(await within(active).findByText('Не доставлено')).toBeTruthy();
    expect(within(active).getByText('Результат невідомий')).toBeTruthy();
    expect(within(active).getByText('Без сповіщення (повтор у межах cooldown)')).toBeTruthy();
    expect(screen.getByText('Налаштовано (значення не показується)')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/hooks\.slack\.com/);
  });

  it('Slack switched off now vs the delivery result of each incident: queued is never "sent", the column is explained', async () => {
    backend('admin', (req) => {
      if (req.url === '/api/alerts/status') return json(200, status({ admin: adminBlock, delivery: { enabled: false } }));
      if (req.url.startsWith('/api/alerts?state=active')) {
        return json(200, { items: [
          inc(1, { processName: 'billing-api', notification: { notify: true, state: 'sent', attempts: 1, lastError: null } }),
          inc(2, { processName: 'mailer', notification: { notify: true, state: 'queued', attempts: 0, lastError: null } }),
        ], nextBefore: null });
      }
      return undefined;
    });
    renderApp('/alerts');
    const active = (await screen.findByRole('heading', { name: /Активні проблеми/ })).closest('section') as HTMLElement;
    expect(await screen.findByText(/Надсилання в Slack зараз вимкнено/)).toBeTruthy();
    const row = (name: string) => (within(active).getByText(name).closest('tr') as HTMLElement);
    expect(within(row('billing-api')).getByText('Надіслано')).toBeTruthy(); // delivered earlier: kept as a fact
    expect(within(row('mailer')).getByText('У черзі')).toBeTruthy();
    expect(within(row('mailer')).queryByText('Надіслано')).toBeNull();
    expect(within(row('mailer')).getByText(/надсилання зараз вимкнено/)).toBeTruthy();
    expect(within(active).getByText(/результат доставки саме цього інциденту/)).toBeTruthy();
    // The application leads the row; the server is under it.
    const first = row('billing-api').querySelector('th');
    expect(first?.firstElementChild?.textContent).toBe('billing-api');
  });

  it('enabled with no active incidents: the empty state names the time of the last evaluation', async () => {
    backend('operator', () => undefined);
    renderApp('/alerts');
    expect(await screen.findByText(/За останньою перевіркою .* відкритих проблем немає\./)).toBeTruthy();
  });

  it('history keeps a retired server_memory incident readable and never calls its closing a recovery (ADR-023)', async () => {
    backend('viewer', (req) => (req.url.startsWith('/api/alerts?state=resolved') ? json(200, {
      items: [inc(5, { rule: 'server_memory', severity: 'warning', processName: null, pmId: null, detail: { value: 93.5, threshold: 90 }, status: 'resolved', resolution: 'retired', resolvedAt: '2026-10-14T11:00:00.000Z' })],
      nextBefore: null,
    }) : undefined));
    renderApp('/alerts');
    const history = (await screen.findByRole('heading', { name: 'Закриті інциденти' })).closest('section') as HTMLElement;
    expect(await within(history).findByText('Правило виведено з експлуатації (не відновлення)')).toBeTruthy();
    expect(within(history).getByText(/Висока пам’ять ОС \(правило виведено\)/)).toBeTruthy();
    expect(within(history).queryByText('Відновлено')).toBeNull();
  });

  it('resolved history pages with the cursor ("Старіші" / "Новіші")', async () => {
    const calls = backend('viewer', (req) => {
      if (!req.url.startsWith('/api/alerts?state=resolved')) return undefined;
      const before = new URL(req.url, 'http://x').searchParams.get('before');
      const resolved = (n: number) => inc(n, { status: 'resolved', resolution: 'recovered', resolvedAt: '2026-10-14T11:00:00.000Z' });
      return json(200, before === null ? { items: [resolved(1)], nextBefore: inc(1).id } : { items: [resolved(2)], nextBefore: null });
    });
    renderApp('/alerts');
    const history = (await screen.findByRole('heading', { name: 'Закриті інциденти' })).closest('section') as HTMLElement;
    expect(await within(history).findByText('Відновлено')).toBeTruthy();
    const pager = within(history).getByRole('navigation', { name: 'Сторінки історії' });
    await userEvent.setup().click(within(pager).getByRole('button', { name: 'Старіші' }));
    await waitFor(() => { expect(within(pager).getByText('Сторінка 2')).toBeTruthy(); });
    expect(calls.some((c) => c.url.includes(`before=${inc(1).id}`))).toBe(true);
    await waitFor(() => { expect(within(pager).getByRole<HTMLButtonElement>('button', { name: 'Старіші' }).disabled).toBe(true); });
    await userEvent.setup().click(within(pager).getByRole('button', { name: 'Новіші' }));
    await waitFor(() => { expect(within(pager).getByText('Сторінка 1')).toBeTruthy(); });
  });

  it('status failure → "unknown" with retry; a late answer after logout is never shown', async () => {
    const late = deferred<Response>();
    let first = true;
    backend('viewer', (req) => {
      if (req.url === '/api/alerts/status' && first) { first = false; return json(503, {}, { 'retry-after': '5' }); }
      if (req.url.startsWith('/api/alerts?state=active')) return late.promise;
      return undefined;
    });
    renderApp('/alerts');
    expect(await screen.findByRole('heading', { name: 'Не вдалося отримати стан рушія' })).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Вийти' }));
    await act(async () => { late.resolve(json(200, { items: [inc(9)], nextBefore: null })); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('Статус errored')).toBeNull();
    expect(await screen.findByLabelText('Email')).toBeTruthy();
  });
});
