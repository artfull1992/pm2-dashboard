import { expect, type Page, test } from '@playwright/test';

// Design reference 1.0 (docs/design): the 17 reference states APP-01…APP-16 / DS-01 reproduced on synthetic fixtures
// shaped like the mockups (23 processes on node-a / node-b, fixed time, dark theme, DPR 1, no animations). The API
// order stays the server's (name, then server) — the mockups' order is a fixture, not a contract. Screenshots are
// written only with NC_UI_SHOTS=<dir outside the repo>; the checks below run always. Nothing is sent to a real API.

const shots = process.env.NC_UI_SHOTS;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // node-a
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // node-b
const LOG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NAMES = ['mail-bot', 'report-worker', 'scheduler', 'app-api', 'billing-worker', 'public-api', 'webhook-relay', 'auth-service', 'user-worker',
  'notification-svc', 'file-processor', 'image-worker', 'search-api', 'email-render', 'queue-consumer', 'payments-api', 'catalog-worker', 'seo-task',
  'analytics-api', 'import-worker', 'cleanup-job', 'thumbnailer', 'rss-collector'];
// The mockups' clock: PM2 collected 10:21:44, log read 10:22:02, file modified 10:21:58 (Kyiv time, 23.10.2026).
const NOW = new Date('2026-10-23T07:22:02.000Z');
const COLLECTED = '2026-10-23T07:21:44.000Z';
const LOG_TEXT = ['[10:21:48] Starting application', '[10:21:49] Configuration loaded', '[10:21:50] Worker ready', '[10:21:52] Health check OK',
  '[10:21:54] Job received: demo-001', '[10:21:55] Job completed', '[10:21:58] Queue idle'].join('\n');

test.use({ timezoneId: 'Europe/Kyiv', deviceScaleFactor: 1 });

interface Fixture {
  role?: 'operator' | 'viewer-logs';
  /** node-b's condition: agent offline, PM2 data stale, or fine. */
  nodeB?: 'ok' | 'offline' | 'stale';
  errored?: string;
  listPending?: boolean;
  /** Log result reads fail with this status after the first successful read. */
  logFailAfterFirst?: number;
}

async function api(page: Page, f: Fixture = {}) {
  let logReads = 0;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const iso = (d: Date) => d.toISOString();
    const item = (name: string, i: number) => {
      const serverId = i % 2 ? A : B;
      const offline = serverId === B && f.nodeB === 'offline';
      const stale = serverId === B && f.nodeB === 'stale';
      const status = name === f.errored ? 'errored' : i < 3 ? 'stopped' : 'online';
      const live = status === 'online';
      return {
        key: `${serverId}:pm2:${String(i + 4)}`, serverId, serverName: serverId === A ? 'node-a' : 'node-b', serverStatus: offline ? 'offline' : 'online',
        source: 'pm2', pmId: i + 4, name, status, uptimeSeconds: live ? [309_600, 108_000, 439_200, 43_200][i % 4] ?? null : null,
        restarts: 2, cpuPercent: live ? [0, 0.6, 1.2, 2.1][i % 4] ?? null : null, memoryBytes: live ? ([96, 128, 214, 286][i % 4] ?? 0) * 1024 ** 2 : null,
        execMode: 'fork', firstSeenAt: '2026-10-20T08:00:00.000Z', inventoryState: offline || stale ? 'stale' : 'current',
        capturedAt: offline || stale ? '2026-10-23T07:18:02.000Z' : COLLECTED, collectedAt: offline || stale ? '2026-10-23T07:18:02.000Z' : COLLECTED,
      };
    };
    const all = NAMES.map(item).sort((x, y) => x.name.localeCompare(y.name) || x.serverId.localeCompare(y.serverId));
    let data: unknown;
    if (req.method() === 'POST' && path.endsWith('/log-requests')) { await route.fulfill({ status: 202, json: { requestId: LOG, deadlineAt: iso(new Date(Date.now() + 15_000)) } }); return; }
    if (req.method() !== 'GET') { await route.fulfill({ status: 409, json: {} }); return; }
    if (path === '/api/auth/me') {
      const permissions = f.role === 'viewer-logs' ? ['monitoring:read', 'logs:read'] : ['monitoring:read', 'processes:control', 'logs:read'];
      data = { user: { id: '00000000-0000-4000-8000-000000000001', email: 'operator@example.com', role: f.role === 'viewer-logs' ? 'viewer' : 'operator' },
        csrfToken: 'a'.repeat(43), expiresAt: iso(new Date(Date.now() + 3_600_000)), permissions };
    } else if (path === '/api/servers') {
      data = { items: [[A, 'node-a'], [B, 'node-b']].map(([id, name]) => ({ id, name, isActive: true, createdAt: '2026-10-01T08:00:00.000Z',
        status: id === B && f.nodeB === 'offline' ? 'offline' : 'online',
        lastSeenAt: id === B && f.nodeB === 'offline' ? '2026-10-23T07:18:02.000Z' : '2026-10-23T07:21:44.000Z', hasActiveCredential: true })), nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/applications') {
      if (f.listPending) return; // never answered: initial loading
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      data = { items: all.filter((a) => a.name.includes(q)), nextCursor: null, freshWindowSeconds: 180 };
    } else if (/^\/api\/servers\/[^/]+\/applications$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      const items = all.filter((a) => a.serverId === id);
      data = { serverId: id, serverStatus: id === B && f.nodeB === 'offline' ? 'offline' : 'online', items, freshWindowSeconds: 180,
        inventory: { state: id === B && f.nodeB && f.nodeB !== 'ok' ? 'stale' : 'current', reason: null, source: 'pm2', capturedAt: COLLECTED, collectedAt: COLLECTED, reportedAt: COLLECTED, processCount: items.length } };
    } else if (/^\/api\/servers\/[^/]+\/control$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      const down = id === B && f.nodeB === 'offline';
      data = { serverId: id, enabled: true, serverStatus: down ? 'offline' : 'online', targetFreshSeconds: 60,
        broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: COLLECTED, fresh: !down, mode: 'auto' },
        targets: all.filter((a) => a.serverId === id).map((a) => ({ targetKey: a.name, name: a.name, pmId: a.pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (/^\/api\/servers\/[^/]+\/log-targets$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      data = id === B && f.nodeB === 'offline' ? { serverId: id, state: 'not_connected', reportedAt: COLLECTED, targets: [] }
        : { serverId: id, state: 'supported', reportedAt: COLLECTED, targets: all.filter((a) => a.serverId === id).map((a) => ({ targetKey: a.name, name: a.name, pmId: a.pmId, matchStatus: 'ok' })) };
    } else if (path.endsWith('/control-commands') && url.searchParams.get('targetKey')) {
      const cmd = (id: string, action: string, status: string, at: string, reason: string | null = null) => ({ id, serverId: path.split('/')[3], targetKey: url.searchParams.get('targetKey'), action, status, reason,
        requestedBy: '00000000-0000-4000-8000-000000000001', requestedAt: at, deadlineAt: at, dispatchedAt: at, completedAt: at, attempts: 1,
        before: { status: 'online' }, after: status === 'succeeded' ? { status: 'online' } : null });
      data = { items: [cmd('11111111-1111-4111-8111-111111111111', 'restart', 'succeeded', '2026-10-23T06:44:18.000Z'),
        cmd('22222222-2222-4222-8222-222222222222', 'start', 'succeeded', '2026-10-22T11:12:07.000Z'),
        cmd('33333333-3333-4333-8333-333333333333', 'stop', 'rejected', '2026-10-22T11:10:53.000Z', 'action_not_allowed')] };
    } else if (path === `/api/log-requests/${LOG}`) {
      logReads += 1;
      if (f.logFailAfterFirst && logReads > 1) { await route.fulfill({ status: f.logFailAfterFirst, json: {} }); return; }
      data = { requestId: LOG, serverId: B, targetKey: 'app-api', status: 'done', deadlineAt: iso(NOW), result: { outcome: 'ok', reason: null, readAt: '2026-10-23T07:22:02.000Z',
        stdout: { state: 'ok', text: LOG_TEXT, lines: 7, truncated: false, sizeBytes: LOG_TEXT.length, modifiedAt: '2026-10-23T07:21:58.000Z' },
        stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null } } };
    } else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
}

async function open(page: Page, viewport: { width: number; height: number }, f: Fixture = {}, path = '/applications') {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.clock.setFixedTime(NOW);
  await api(page, f);
  await page.goto(path);
}
const row = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name} на node-[ab]:`) });
const shot = async (page: Page, id: string) => { if (shots) await page.screenshot({ path: `${shots}/${id}.png` }); };
const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
async function select(page: Page, name: string, tab?: 'Логи' | 'Історія дій') {
  await row(page, name).click();
  const panel = page.getByRole('region', { name: new RegExp(`^Деталі: ${name} на `) });
  await expect(panel).toBeVisible();
  if (tab) await panel.getByRole('tab', { name: tab }).click();
  return panel;
}

const DESK = { width: 1440, height: 900 };

test('APP-01 logs', async ({ page }) => {
  await open(page, DESK);
  const panel = await select(page, 'app-api', 'Логи');
  await expect(panel.locator('.log-text')).toContainText('Queue idle');
  await shot(page, 'APP-01-logs');
  await noOverflow(page);
});

test('APP-02 overview', async ({ page }) => {
  await open(page, DESK);
  const panel = await select(page, 'app-api');
  await expect(panel.getByRole('tab', { name: 'Огляд' })).toHaveAttribute('aria-selected', 'true');
  await shot(page, 'APP-02-overview');
});

test('APP-03 history', async ({ page }) => {
  await open(page, DESK);
  const panel = await select(page, 'app-api', 'Історія дій');
  await expect(panel.getByText(/Відхилено|відхилено/).first()).toBeVisible();
  await shot(page, 'APP-03-history');
});

test('APP-04 stopped', async ({ page }) => {
  await open(page, DESK);
  await select(page, 'mail-bot');
  await shot(page, 'APP-04-stopped');
});

test('APP-05 error', async ({ page }) => {
  await open(page, DESK, { errored: 'billing-worker' });
  await select(page, 'billing-worker');
  await shot(page, 'APP-05-error');
});

test('APP-06 offline (agent of node-b does not report)', async ({ page }) => {
  await open(page, DESK, { nodeB: 'offline' });
  await select(page, 'billing-worker', 'Логи');
  await shot(page, 'APP-06-offline');
});

test('APP-07 stale (agent online, PM2 data stale)', async ({ page }) => {
  await open(page, DESK, { nodeB: 'stale' });
  const panel = await select(page, 'billing-worker', 'Логи');
  // The agent is online: the log is read now (not a cache), and the current PM2 state is shown as stale.
  await expect(panel.locator('.log-text')).toContainText('Queue idle');
  await expect(panel.getByText('Застаріло', { exact: true })).toBeVisible();
  await shot(page, 'APP-07-stale');
});

test('APP-08 loading', async ({ page }) => {
  await open(page, DESK, { listPending: true });
  await page.waitForTimeout(300);
  await shot(page, 'APP-08-loading');
});

test('APP-09 empty search', async ({ page }) => {
  await open(page, DESK, {}, '/applications?q=payment-archive');
  await expect(page.getByRole('heading', { name: 'Нічого не знайдено' })).toBeVisible();
  await shot(page, 'APP-09-empty');
});

test('APP-10 view without control', async ({ page }) => {
  await open(page, DESK, { role: 'viewer-logs' });
  await select(page, 'app-api');
  await shot(page, 'APP-10-no-access');
});

test('APP-11 nothing selected', async ({ page }) => {
  await open(page, DESK);
  await expect(row(page, 'app-api')).toBeVisible();
  await shot(page, 'APP-11-unselected');
});

test('APP-12 log read fails after a success', async ({ page }) => {
  await open(page, DESK, { logFailAfterFirst: 503 });
  const panel = await select(page, 'app-api', 'Логи');
  await expect(panel.locator('.log-text')).toContainText('Queue idle');
  await panel.getByRole('button', { name: 'Оновити' }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await shot(page, 'APP-12-network-error');
});

test('APP-13 mobile list', async ({ page }) => {
  await open(page, { width: 390, height: 844 });
  await expect(row(page, 'app-api')).toBeVisible();
  await shot(page, 'APP-13-mobile-list');
  await noOverflow(page);
});

test('APP-14 mobile details', async ({ page }) => {
  await open(page, { width: 390, height: 844 });
  const panel = await select(page, 'app-api', 'Логи');
  await expect(panel.locator('.log-text')).toContainText('Queue idle');
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await shot(page, 'APP-14-mobile-detail');
  await noOverflow(page);
});

test('APP-15 tablet details', async ({ page }) => {
  await open(page, { width: 1024, height: 768 });
  const panel = await select(page, 'app-api', 'Логи');
  await expect(panel.locator('.log-text')).toContainText('Queue idle');
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await shot(page, 'APP-15-tablet-detail');
  await noOverflow(page);
});

test('APP-16 compact desktop', async ({ page }) => {
  await open(page, { width: 1366, height: 768 });
  const panel = await select(page, 'app-api', 'Логи');
  await expect(panel.locator('.log-text')).toContainText('Queue idle');
  await shot(page, 'APP-16-compact-desktop');
  await noOverflow(page);
});

test('DS-01 production primitives (test harness, not a product page)', async ({ page }) => {
  await open(page, DESK);
  await expect(row(page, 'app-api')).toBeVisible();
  // Production classes only, rendered into the test page: statuses, buttons, notice, typography, a list row.
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return;
    main.innerHTML = `<section class="page page--workspace"><h1 class="page__title">Застосунки · 26 / 32</h1>
      <div class="app-detail"><div class="app-detail__top"><h2 class="app-detail__name">app-api · 20 / 28</h2><p>Основний текст · 14 / 20</p><p class="hint">Контекст і метадані · 12 / 18</p>
      <div class="button-row"><span class="status status--ok">Працює</span><span class="status status--warn">Зупинено</span><span class="status status--bad">Помилка</span><span class="status status--muted">Невідомо</span><span class="status status--muted">Застаріло</span></div>
      <div class="button-row"><button class="button">Перезапустити</button><button class="button">Оновити</button><button class="button" disabled>Недоступно</button></div>
      <div class="notice notice--warning"><p class="notice__title">Агент не звітує</p><p class="notice__text">Свіжість даних і стан процесу — різні поняття.</p></div>
      <pre class="log-text">[10:21:50] Worker ready · 12 / 22</pre>
      <div class="app-list"><ul class="app-list__rows"><li><button class="app-row app-row--selected"><span class="app-row__main"><span class="app-row__name">Рядок процесу · 56 px</span><span class="app-row__sub">node-a</span></span><span class="app-row__status"><span class="status status--ok">Працює</span></span><span class="app-row__metric num">2.1 %</span><span class="app-row__metric num">286 МіБ</span><span class="app-row__metric num">3 д 14 год</span></button></li></ul></div></div></div></section>`;
  });
  await shot(page, 'DS-01-components');
});
