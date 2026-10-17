import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF, deferred, installFetch, json, noContent, type RecordedRequest, renderApp, session } from './support';

// Admin settings UI (Task 013.1, ADR-022): admin-only, write-only webhook, test only for the saved integration,
// optimistic concurrency, unsaved-change protection, no automatic retries, stale responses ignored.

const WEBHOOK = `https://hooks.slack.com/services/T0SYNTH07/B0SYNTH07/${'u'.repeat(24)}`;
const ranges = Object.fromEntries(Object.entries({
  cpuOpenPercent: [1, 10000, 90], cpuClosePercent: [0, 10000, 70],
  confirmSamples: [1, 20, 3], recoverSamples: [1, 20, 2], statusConfirmSamples: [1, 20, 2], restartsThreshold: [1, 1000, 3], restartsWindowMinutes: [2, 1440, 10],
  intervalSeconds: [10, 600, 30], cooldownMinutes: [0, 1440, 15], reminderMinutes: [1, 10080, 60], httpTimeoutMs: [1000, 30000, 5000], maxAttempts: [1, 15, 6], queueMax: [10, 1000, 100],
}).map(([k, [min, max, d]]) => [k, { min, max, default: d }]));
function view(over: Record<string, unknown> = {}, slack: Record<string, unknown> = {}) {
  return {
    revision: 1, updatedAt: '2026-10-15T09:00:00.000Z', engineEnabled: false, deliveryEnabled: false,
    rules: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
    timing: { intervalSeconds: 30, cooldownMinutes: 15, reminderEnabled: false, reminderMinutes: 60 },
    advanced: { httpTimeoutMs: 5000, maxAttempts: 6, queueMax: 100 }, ranges,
    slack: { state: 'not_configured', error: null, generation: 0, configuredAt: null, keyAvailable: true, lastTest: null, ...slack },
    queue: { queued: 0, sending: 0, sent: 0, failed: 0, unknown: 0, dropped: 0, cancelled: 0 }, publicUrlConfigured: true, ...over,
  };
}
const configured = (over: Record<string, unknown> = {}) => view(over, { state: 'configured', generation: 1, configuredAt: '2026-10-15T09:10:00.000Z' });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;
function backend(role: 'admin' | 'operator' | 'viewer', route: Route = () => undefined, current: () => unknown = () => view()) {
  return installFetch((req) => {
    const r = route(req);
    if (r) return r;
    if (req.url === '/api/auth/me') return json(200, session(role));
    if (req.url === '/api/auth/logout') return noContent();
    if (req.url === '/api/auth/login') return json(200, session(role));
    if (req.url === '/api/settings/alerts' && req.method === 'GET') return json(200, current());
    return json(404, {});
  });
}
const sentTo = (calls: RecordedRequest[], method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);

describe('access', () => {
  it.each(['operator', 'viewer'] as const)('%s: no navigation item; direct routes forbidden; no settings request', async (role) => {
    const calls = backend(role);
    renderApp('/settings/rules');
    expect(await screen.findByRole('heading', { name: 'Недостатньо прав' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Налаштування' })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/settings'))).toBe(false);
  });
});

describe('Slack integration tab', () => {
  it('not configured: test disabled; saving sends the webhook once with CSRF, clears the field, never shows it back', async () => {
    const calls = backend('admin', (req) => (req.method === 'PUT' ? json(200, configured()) : undefined));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('link', { name: 'Налаштування' }));
    expect(await screen.findByText('Не налаштовано')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Надіслати тестове повідомлення' }).disabled).toBe(true);
    const input = screen.getByLabelText<HTMLInputElement>('Webhook URL');
    expect(input.type).toBe('password');
    await u.type(input, WEBHOOK);
    expect(screen.getByText(/Спочатку збережіть webhook/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Зберегти webhook' }));
    expect(await screen.findByText(/Webhook налаштовано .* — значення не показується/)).toBeTruthy();
    const put = sentTo(calls, 'PUT', '/api/settings/integrations/slack');
    expect(put).toHaveLength(1);
    expect(put[0]?.headers.get('x-csrf-token')).toBe(CSRF);
    expect(JSON.parse(put[0]?.body ?? '{}')).toEqual({ generation: 0, webhookUrl: WEBHOOK });
    expect(document.body.innerHTML).not.toContain('u'.repeat(24));
    expect(screen.queryByLabelText('Webhook URL')).toBeNull();
  });

  it('an invalid URL is refused locally (no request)', async () => {
    const calls = backend('admin');
    renderApp('/settings/integrations');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Webhook URL'), 'https://evil.test/services/x');
    await u.click(screen.getByRole('button', { name: 'Зберегти webhook' }));
    expect(screen.getByText(/Це не Slack Incoming Webhook URL/)).toBeTruthy();
    expect(sentTo(calls, 'PUT', '/api/settings/integrations/slack')).toHaveLength(0);
  });

  it('test: one click → one request for the saved generation; pending blocks a second click; outcome shown', async () => {
    const answer = deferred<Response>();
    const calls = backend('admin', (req) => (req.url.endsWith('/test') ? answer.promise : undefined), () => configured());
    renderApp('/settings/integrations');
    const u = userEvent.setup();
    const btn = await screen.findByRole('button', { name: 'Надіслати тестове повідомлення' });
    await u.click(btn);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Надсилання…' }).disabled).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Надсилання…' }));
    const posts = sentTo(calls, 'POST', '/api/settings/integrations/slack/test');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ generation: 1 });
    await act(async () => { answer.resolve(json(200, { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: 1, outcome: 'unknown', code: 'timeout', at: '2026-10-15T09:20:00.000Z', stored: true })); await Promise.resolve(); });
    expect(await screen.findByText(/результат невідомий \(timeout\)/)).toBeTruthy();
  });

  it.each([
    ['failed', 'network', /не вдалося \(network\)/],
    ['unknown', 'connection_lost', /результат невідомий \(connection_lost\)/],
  ] as const)('test outcome %s (%s) is shown as reported, never as success', async (outcome, code, text) => {
    backend('admin', (req) => (req.url.endsWith('/test') ? json(200, { operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation: 1, outcome, code, at: '2026-10-15T09:20:00.000Z', stored: true }) : undefined), () => configured());
    renderApp('/settings/integrations');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Надіслати тестове повідомлення' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText(/успішно/)).toBeNull();
  });

  it('replace warns that the queue is cancelled; remove asks for confirmation and sends the generation; delivery toggle uses the revision', async () => {
    let state = configured();
    const calls = backend('admin', (req) => {
      if (req.method === 'DELETE') { state = view({ revision: 2 }, { generation: 2 }); return json(200, state); }
      if (req.method === 'PATCH') { state = configured({ revision: 2, deliveryEnabled: true }); return json(200, state); }
      return undefined;
    }, () => state);
    renderApp('/settings/integrations');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Замінити webhook' }));
    expect(screen.getByText(/буде скасовано, а не переслано новому адресату/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Скасувати' }));
    await u.click(screen.getByLabelText(/Автоматична доставка/));
    expect(await screen.findByText('Автоматичну доставку увімкнено.')).toBeTruthy();
    expect(JSON.parse(sentTo(calls, 'PATCH', '/api/settings/alerts')[0]?.body ?? '{}')).toEqual({ revision: 1, deliveryEnabled: true });
    await u.click(screen.getByRole('button', { name: 'Видалити інтеграцію' }));
    const dialog = screen.getByRole('dialog', { name: 'Видалити Slack-інтеграцію?' });
    expect(within(dialog).getByText(/повідомлення в черзі — скасовано/)).toBeTruthy();
    await u.click(within(dialog).getByRole('button', { name: 'Видалити' }));
    await waitFor(() => { expect(screen.getByText('Не налаштовано')).toBeTruthy(); });
    expect(JSON.parse(sentTo(calls, 'DELETE', '/api/settings/integrations/slack')[0]?.body ?? '{}')).toEqual({ generation: 1 });
  });

  it('an encryption-key problem is shown as an error state, without any secret', async () => {
    backend('admin', undefined, () => view({}, { state: 'error', error: 'key_missing', generation: 4, configuredAt: '2026-10-15T09:10:00.000Z', keyAvailable: false }));
    renderApp('/settings/integrations');
    expect(await screen.findByText('Помилка: на сервері не задано ключ шифрування')).toBeTruthy();
    expect(screen.getByText(/ALERTS_SECRET_KEY/)).toBeTruthy();
  });

  it('a response that would contain a webhook is a contract violation and is never displayed', async () => {
    backend('admin', undefined, () => ({ ...configured(), slack: { ...configured().slack, webhookUrl: WEBHOOK } }));
    renderApp('/settings/integrations');
    expect(await screen.findByRole('heading', { name: 'Не вдалося завантажити налаштування' })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('hooks.slack.com');
  });
});

describe('rules tab', () => {
  it('client validation (range, recovery below opening) sends nothing; a valid save sends the revision and all groups', async () => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? json(200, view({ revision: 2, rules: { ...view().rules, cpuOpenPercent: 250, cpuClosePercent: 180 } })) : undefined));
    renderApp('/settings/rules');
    const u = userEvent.setup();
    const open = await screen.findByLabelText(/CPU процесу — поріг проблеми/);
    const close = screen.getByLabelText(/CPU процесу — поріг відновлення/);
    await u.clear(close);
    await u.type(close, '95');
    expect(screen.getByText('Є незбережені зміни.')).toBeTruthy();
    await u.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(screen.getByText('Має бути нижче порогу проблеми.')).toBeTruthy();
    await u.clear(open);
    await u.type(open, '250'); // PM2 CPU may exceed 100 %
    await u.clear(close);
    await u.type(close, '180');
    await u.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByText(/Збережено. Нові правила діють з наступного циклу/)).toBeTruthy();
    const patch = sentTo(calls, 'PATCH', '/api/settings/alerts');
    expect(patch).toHaveLength(1);
    expect(JSON.parse(patch[0]?.body ?? '{}')).toMatchObject({ revision: 1, engineEnabled: false, rules: { cpuOpenPercent: 250, cpuClosePercent: 180 }, timing: { intervalSeconds: 30, reminderEnabled: false }, advanced: { queueMax: 100 } });
  });

  it('layout (Task 013.2): short visible labels keep full names, limits on demand, error replaces help, switches send the same payload', async () => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? json(200, view({ revision: 2, engineEnabled: true, timing: { ...view().timing, reminderEnabled: true } })) : undefined));
    renderApp('/settings/rules');
    const u = userEvent.setup();
    const close = await screen.findByLabelText<HTMLInputElement>('CPU процесу — поріг відновлення, %');
    expect(screen.getAllByText('Відновлення', { selector: 'label' })).toHaveLength(2); // short visible labels (CPU, confirmations)
    expect(screen.queryByLabelText(/Пам[’']ять ОС/)).toBeNull(); // OS memory thresholds are gone (ADR-023)
    expect(close.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText('0–10000, типово 70')).toBeNull();
    const limits = screen.getByRole('button', { name: 'Показати межі й типові' });
    await u.click(limits);
    expect(screen.getByRole('button', { name: 'Сховати межі' }).getAttribute('aria-pressed')).toBe('true');
    const help = screen.getByText('0–10000, типово 70');
    expect(close.getAttribute('aria-describedby')).toBe(help.id);
    await u.clear(close);
    await u.type(close, '95');
    await u.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(screen.queryByText('0–10000, типово 70')).toBeNull();
    expect(document.getElementById(close.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Має бути нижче порогу проблеми.');
    await u.click(screen.getByRole('button', { name: 'Скасувати зміни' })); // restores the saved values and clears the errors
    expect(close.value).toBe('70');
    expect(screen.queryByText('Має бути нижче порогу проблеми.')).toBeNull();
    expect(screen.getByText('Змін немає.')).toBeTruthy();
    await u.click(screen.getByRole('switch', { name: 'Рушій сповіщень (перевірка проблем)' }));
    await u.click(screen.getByRole('switch', { name: 'Нагадування про незакриті проблеми' }));
    await u.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByText(/Збережено/)).toBeTruthy();
    const patch = sentTo(calls, 'PATCH', '/api/settings/alerts');
    expect(JSON.parse(patch[0]?.body ?? '{}')).toEqual({
      revision: 1, engineEnabled: true, rules: view().rules,
      timing: { intervalSeconds: 30, cooldownMinutes: 15, reminderMinutes: 60, reminderEnabled: true }, advanced: view().advanced,
    });
  });

  it('409 conflict: explained, edits not applied, "Перечитати стан" reloads', async () => {
    const calls = backend('admin', (req) => (req.method === 'PATCH' ? json(409, {}) : undefined));
    renderApp('/settings/rules');
    const u = userEvent.setup();
    const interval = await screen.findByLabelText(/Інтервал перевірки/);
    await u.clear(interval);
    await u.type(interval, '60');
    await u.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByText(/змінив інший адміністратор/)).toBeTruthy();
    const gets = calls.filter((c) => c.url === '/api/settings/alerts' && c.method === 'GET').length;
    await u.click(screen.getByRole('button', { name: 'Перечитати стан' }));
    await waitFor(() => { expect(calls.filter((c) => c.url === '/api/settings/alerts' && c.method === 'GET').length).toBe(gets + 1); });
    expect(sentTo(calls, 'PATCH', '/api/settings/alerts')).toHaveLength(1); // never retried
  });

  it('leaving the tab with unsaved edits asks first; declining keeps the edits', async () => {
    backend('admin');
    renderApp('/settings/rules');
    const u = userEvent.setup();
    const interval = await screen.findByLabelText(/Інтервал перевірки/);
    await u.clear(interval);
    await u.type(interval, '45');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await u.click(screen.getByRole('link', { name: 'Інтеграції' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>(/Інтервал перевірки/).value).toBe('45');
  });

  it('a late settings answer after logout is ignored', async () => {
    const late = deferred<Response>();
    let first = true;
    backend('admin', (req) => { if (req.url === '/api/settings/alerts' && first) { first = false; return late.promise; } return undefined; });
    renderApp('/settings/rules');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Вийти' }));
    await act(async () => { late.resolve(json(200, view())); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('Правила сповіщень')).toBeNull();
    expect(await screen.findByLabelText('Email')).toBeTruthy();
  });
});
