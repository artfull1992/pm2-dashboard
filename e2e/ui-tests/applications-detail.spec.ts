import { expect, type Page, test } from '@playwright/test';

// Applications: name search → expanded panel → overview / inline logs / target history → confirmed action. Synthetic
// API only (no DB, credentials or PM2). Screenshots are written only when NC_UI_SHOTS is set.

const shots = process.env.NC_UI_SHOTS;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CMD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SERVERS = { [A]: 'app-server', [B]: 'backup-server' } as const;
const LONG = 'very-long-service-name-for-layout-checks-with-many-segments-v2';
const NAMES = ['billing-api', 'catalog-api', LONG, 'orders-api', 'reports-worker'];

interface Api { mutations: string[]; reads: string[] }
async function api(page: Page): Promise<Api> {
  const state: Api = { mutations: [], reads: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const now = new Date(Date.now() - 20_000).toISOString();
    state.reads.push(`${req.method()} ${path}${url.search}`);
    const item = (serverId: string, name: string, pmId: number) => ({
      key: `${serverId}:pm2:${String(pmId)}`, serverId, serverName: SERVERS[serverId as keyof typeof SERVERS], serverStatus: serverId === B ? 'offline' : 'online',
      source: 'pm2', pmId, name, status: name === 'reports-worker' ? 'errored' : 'online', uptimeSeconds: 608_460, restarts: pmId, cpuPercent: 1.5 + pmId,
      memoryBytes: (80 + pmId * 10) * 1024 ** 2, execMode: 'fork', firstSeenAt: now, inventoryState: serverId === B ? 'stale' : 'current', capturedAt: now, collectedAt: now,
    });
    let data: unknown;
    if (req.method() === 'POST' && path === `/api/servers/${A}/control-commands`) {
      state.mutations.push(`${req.method()} ${path} ${JSON.stringify((req.postDataJSON() as { targetKey: string; action: string }))}`);
      data = { id: CMD, serverId: A, targetKey: 'orders-api', action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
        requestedAt: now, deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: null };
      await route.fulfill({ status: 201, json: data });
      return;
    }
    if (req.method() === 'POST' && path === `/api/servers/${A}/log-requests`) {
      await route.fulfill({ status: 202, json: { requestId: LOG, deadlineAt: new Date(Date.now() + 15_000).toISOString() } });
      return;
    }
    if (req.method() !== 'GET') { state.mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    if (path === '/api/auth/me') {
      data = { user: { id: '00000000-0000-4000-8000-000000000001', email: 'operator@example.com', role: 'operator' }, csrfToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: ['monitoring:read', 'processes:control', 'logs:read'] };
    } else if (path === '/api/servers') {
      data = { items: [A, B].map((id) => ({ id, name: SERVERS[id as keyof typeof SERVERS], isActive: true, createdAt: now, status: id === B ? 'offline' : 'online', lastSeenAt: now, hasActiveCredential: true })), nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/applications') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const all = [...NAMES.map((n, i) => item(A, n, i)), item(B, 'orders-api', 0)].filter((a) => a.name.toLowerCase().includes(q))
        .sort((x, y) => x.name.localeCompare(y.name) || x.serverId.localeCompare(y.serverId));
      data = { items: all, nextCursor: null, freshWindowSeconds: 180 };
    } else if (/^\/api\/servers\/[^/]+\/control$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      data = { serverId: id, enabled: true, serverStatus: id === B ? 'offline' : 'online', targetFreshSeconds: 60,
        broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: id !== B },
        targets: NAMES.slice(0, 4).map((name, pmId) => ({ targetKey: name.slice(0, 40), name, pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (/^\/api\/servers\/[^/]+\/log-targets$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      data = id === B ? { serverId: id, state: 'not_connected', reportedAt: now, targets: [] }
        : { serverId: id, state: 'supported', reportedAt: now, targets: ['orders-api', 'billing-api'].map((name) => ({ targetKey: name, name, pmId: NAMES.indexOf(name), matchStatus: 'ok' })) };
    } else if (path === `/api/servers/${A}/control-commands` && url.searchParams.get('targetKey')) {
      const key = url.searchParams.get('targetKey');
      data = { items: key === 'orders-api' ? [
        { id: '11111111-1111-4111-8111-111111111111', serverId: A, targetKey: 'orders-api', action: 'restart', status: 'succeeded', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
          requestedAt: now, deadlineAt: now, dispatchedAt: now, completedAt: now, attempts: 1, before: { status: 'online' }, after: { status: 'online' } },
        { id: '22222222-2222-4222-8222-222222222222', serverId: A, targetKey: 'orders-api', action: 'stop', status: 'unknown', reason: 'timeout', requestedBy: '00000000-0000-4000-8000-000000000001',
          requestedAt: now, deadlineAt: now, dispatchedAt: now, completedAt: now, attempts: 1, before: null, after: null },
      ] : [] };
    } else if (path.endsWith('/control-commands')) data = { items: [] };
    else if (path === `/api/log-requests/${LOG}`) {
      const text = Array.from({ length: 80 }, (_, i) => `2026-10-16T10:00:${String(i % 60).padStart(2, '0')}Z GET /api/orders/${String(i)} 200 ${'payload '.repeat(10)}`).join('\n');
      data = { requestId: LOG, serverId: A, targetKey: 'orders-api', status: 'done', deadlineAt: now, result: { outcome: 'ok', reason: null, readAt: now,
        stdout: { state: 'ok', text, lines: 80, truncated: true, sizeBytes: 900_000, modifiedAt: now }, stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: now } } };
    } else if (path === `/api/control-commands/${CMD}`) {
      data = { id: CMD, serverId: A, targetKey: 'orders-api', action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
        requestedAt: now, deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: null };
    } else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return state;
}

const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
const rowCount = (page: Page) => page.locator('table tbody tr').count();

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`search → panel → overview/logs/history at ${String(viewport.width)}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      const state = await api(page);
      const tag = `${String(viewport.width)}-${scheme}`;
      await page.goto('/applications');
      await expect(page.getByRole('button', { name: `Розгорнути деталі: ${LONG} на app-server` })).toBeVisible();

      // Search narrows the list server-side.
      await page.getByLabel('Пошук за назвою').fill('orders');
      await expect(page).toHaveURL(/\?q=orders$/);
      await expect(page.locator('table tbody tr')).toHaveCount(2);
      const rowsBefore = await rowCount(page);

      // Expand: exactly one extra row; Overview without any log or history read.
      const toggle = page.getByRole('button', { name: 'Розгорнути деталі: orders-api на app-server' });
      await toggle.click();
      const panel = page.getByRole('region', { name: 'Деталі: orders-api на app-server' });
      await expect(panel.getByRole('tab', { name: 'Огляд' })).toHaveAttribute('aria-selected', 'true');
      expect(await rowCount(page)).toBe(rowsBefore + 1);
      await expect(panel.getByText(/Доступно: Запустити, Зупинити, Перезапустити/)).toBeVisible();
      expect(state.reads.some((r) => r.includes('/log-requests') || r.includes('targetKey='))).toBe(false);
      await noOverflow(page);
      if (shots) await page.screenshot({ path: `${shots}/apps-overview-${tag}.png` });

      // Logs: bounded box with inner scroll, no page overflow.
      await panel.getByRole('tab', { name: 'Логи' }).click();
      const log = panel.locator('.log-text');
      await expect(log).toContainText('GET /api/orders/79 200');
      const box = await log.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight }));
      expect(box.h).toBeLessThanOrEqual(322);
      expect(box.sh).toBeGreaterThan(box.h);
      await noOverflow(page);
      if (shots) await page.screenshot({ path: `${shots}/apps-logs-${tag}.png` });

      // History of the confirmed target, with its scope.
      await panel.getByRole('tab', { name: 'Історія дій' }).click();
      await expect(panel.getByText(/Команди цілі «orders-api» з allowlist цього сервера/)).toBeVisible();
      await expect(panel.getByText(/Результат невідомий/)).toBeVisible();
      if (shots) await page.screenshot({ path: `${shots}/apps-history-${tag}.png` });

      // The offline/stale row on the other server: logs unavailable, explained; its history is not mixed in.
      await page.getByRole('button', { name: 'Розгорнути деталі: orders-api на backup-server' }).click();
      const other = page.getByRole('region', { name: 'Деталі: orders-api на backup-server' });
      await expect(panel).toHaveCount(0);
      await other.getByRole('tab', { name: 'Логи' }).click();
      await expect(other.getByText('Агент не на зв’язку — логи недоступні.')).toBeVisible();
      await expect(other.getByText(/Сервер не онлайн — керування недоступне/)).toBeVisible();
      await noOverflow(page);

      expect(state.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('keyboard, focus return, empty history, long names and a confirmed action from the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await api(page);
  await page.goto('/applications');
  const toggle = page.getByRole('button', { name: `Розгорнути деталі: ${LONG} на app-server` });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: `Деталі: ${LONG} на app-server` });
  await expect(panel).toBeVisible();
  await panel.getByRole('tab', { name: 'Огляд' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(panel.getByRole('tab', { name: 'Історія дій' })).toBeFocused();
  await expect(panel.getByText('Команд для цієї цілі ще не було.')).toBeVisible();
  await panel.getByRole('button', { name: 'Згорнути' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Розгорнути деталі: ${LONG} на app-server` })).toBeFocused();

  // The floating row menu is still an overlay: opening it does not move the table.
  const before = await page.locator('table').boundingBox();
  await page.getByRole('button', { name: 'Дії: orders-api на app-server' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await page.locator('table').boundingBox()).toEqual(before);
  await page.keyboard.press('Escape');

  // A confirmed action from the panel: the same dialog and exactly one POST for the right server/target.
  await page.getByRole('button', { name: 'Розгорнути деталі: orders-api на app-server' }).click();
  const orders = page.getByRole('region', { name: 'Деталі: orders-api на app-server' });
  await orders.getByRole('button', { name: 'Перезапустити' }).click();
  const dialog = page.getByRole('dialog', { name: 'Перезапустити процес?' });
  await expect(dialog).toContainText('«orders-api» (orders-api) на сервері «app-server»');
  await dialog.getByRole('button', { name: 'Перезапустити' }).click();
  await expect(page.getByRole('status').filter({ hasText: /«orders-api» на сервері «app-server»: У черзі/ })).toBeVisible();
  expect(state.mutations).toHaveLength(1);
  expect(state.mutations[0]).toMatch(new RegExp(`^POST /api/servers/${A}/control-commands \\{"targetKey":"orders-api","action":"restart","idempotencyKey":"[0-9a-f-]{36}"\\}$`));
});
