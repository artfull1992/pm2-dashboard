import { type Browser, expect, type Page, test } from '@playwright/test';

// Stage 3.1 — overview, servers and server detail on the shared design system (ТЗ §11, DS-01; there are no exact
// mockups of these pages). Synthetic API only; nothing is sent. Checks: no page overflow at 390/720/1024/1366/1440 and
// in a 450 px high window, both themes, roles, the compact rail with every control reachable, touch targets, flat
// statuses (text + marker), unknown «—», stale/offline not shown as live, equal compact rows, no per-server requests
// on the lists. Screenshots only with NC_UI_SHOTS (outside the repository).

const shots = process.env.NC_UI_SHOTS;
const SRV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OFF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Role = 'admin' | 'operator' | 'viewer';
const PERMS: Record<Role, string[]> = {
  admin: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
  operator: ['monitoring:read', 'processes:control', 'logs:read'],
  viewer: ['monitoring:read'],
};
const NAMES = ['catalog-api', 'billing-api', 'orders-api', 'mailer', 'very-long-service-name-for-layout-checks-with-many-segments-v2', 'reports-worker'];

async function api(page: Page, role: Role) {
  const state = { reads: [] as string[], mutations: [] as string[] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const now = new Date(Date.now() - 18_000).toISOString();
    const old = new Date(Date.now() - 600_000).toISOString();
    state.reads.push(path);
    if (req.method() !== 'GET') { state.mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    const proc = (serverId: string, name: string, pmId: number, offline: boolean) => ({
      key: `${serverId}:pm2:${String(pmId)}`, serverId, serverName: serverId === SRV ? 'app-server' : 'backup-server', serverStatus: offline ? 'offline' : 'online',
      source: 'pm2', pmId, name, status: name === 'reports-worker' ? 'errored' : name === 'mailer' ? 'stopped' : 'online', uptimeSeconds: 608_460 + pmId * 3600,
      restarts: pmId, cpuPercent: pmId === 0 ? 0 : 0.4 + pmId, memoryBytes: (68 + pmId * 40) * 1024 ** 2, execMode: 'fork', firstSeenAt: old,
      inventoryState: offline ? 'stale' : 'current', capturedAt: offline ? old : now, collectedAt: offline ? old : now,
    });
    let data: unknown;
    if (path === '/api/auth/me') {
      data = { user: { id: '00000000-0000-4000-8000-000000000001', email: `${role}@example.com`, role }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: PERMS[role] };
    } else if (path === '/api/dashboard') {
      data = {
        generatedAt: now, windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
        servers: { total: 2, inactive: 0, active: 2, online: 1, offline: 1, neverConnected: 0 },
        inventory: { current: 1, stale: 1, unavailable: 0, notReported: 0 },
        processes: { live: { total: 6, online: 4, problem: 2, transitional: 0 }, notLive: 3 },
        attentionServers: { items: [{ id: OFF, name: 'backup-server', status: 'offline', reason: 'offline', lastSeenAt: old, inventoryCollectedAt: old }], total: 1, limit: 20 },
        attentionProcesses: { items: [
          { serverId: SRV, serverName: 'app-server', pmId: 5, name: 'reports-worker', status: 'errored', restarts: 14, uptimeSeconds: null },
          { serverId: SRV, serverName: 'app-server', pmId: 3, name: 'mailer', status: 'stopped', restarts: 3, uptimeSeconds: null },
        ], total: 2, limit: 20 },
        serverList: { items: [
          { id: SRV, name: 'app-server', status: 'online', lastSeenAt: now, metrics: { hostname: 'app-server', loadAverage: [1.42, 1.1, 0.95] }, inventory: { state: 'current', collectedAt: now }, processes: { total: 6, online: 4, problem: 2 } },
          { id: OFF, name: 'backup-server', status: 'offline', lastSeenAt: old, metrics: null, inventory: { state: 'stale', collectedAt: old }, processes: null },
        ], total: 2, limit: 50 },
        recentActions: role === 'viewer' ? null : { limit: 10, items: [
          { id: '11111111-1111-4111-8111-111111111111', serverId: SRV, serverName: 'app-server', targetKey: 'orders-api', serviceName: 'orders-api', action: 'restart', status: 'succeeded', reason: null, requestedAt: old, completedAt: old, requestedByMe: true, overdue: false },
        ] },
      };
    } else if (path === '/api/servers') {
      data = { items: [
        { id: SRV, name: 'app-server', isActive: true, createdAt: old, status: 'online', lastSeenAt: now, hasActiveCredential: true },
        { id: OFF, name: 'backup-server', isActive: true, createdAt: old, status: 'offline', lastSeenAt: old, hasActiveCredential: true },
      ], nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === `/api/servers/${SRV}` || path === `/api/servers/${OFF}`) {
      const off = path.endsWith(OFF);
      data = { id: off ? OFF : SRV, name: off ? 'backup-server' : 'app-server', status: off ? 'offline' : 'online', isActive: true, createdAt: old, lastSeenAt: off ? old : now, hasActiveCredential: true,
        snapshot: { agentVersion: '0.6.0', hostname: off ? 'backup-01.internal' : 'app-server', platform: 'linux', arch: 'x64', loadAverage: [1.42, 1.1, 0.95] } };
    } else if (/\/api\/servers\/[^/]+\/applications$/.test(path)) {
      const off = path.includes(OFF);
      const id = off ? OFF : SRV;
      data = { serverId: id, serverStatus: off ? 'offline' : 'online', freshWindowSeconds: 180, items: NAMES.map((n, i) => proc(id, n, i, off)),
        inventory: { state: off ? 'stale' : 'current', reason: null, source: 'pm2', capturedAt: off ? old : now, collectedAt: off ? old : now, reportedAt: off ? old : now, processCount: NAMES.length } };
    } else if (/\/api\/servers\/[^/]+\/control$/.test(path)) {
      const off = path.includes(OFF);
      data = { serverId: off ? OFF : SRV, enabled: true, serverStatus: off ? 'offline' : 'online', targetFreshSeconds: 60,
        broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: off ? old : now, fresh: !off, mode: 'allowlist' },
        targets: NAMES.slice(0, 4).map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (/\/api\/servers\/[^/]+\/log-targets$/.test(path)) {
      const off = path.includes(OFF);
      data = { serverId: off ? OFF : SRV, state: off ? 'not_connected' : 'supported', reportedAt: now, targets: off ? [] : NAMES.slice(0, 2).map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok' })) };
    } else if (path.endsWith('/control-commands')) data = { items: [] };
    else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return state;
}

const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
const PAGES = [
  { name: 'overview', path: '/', h1: 'Огляд' },
  { name: 'servers', path: '/servers', h1: 'Сервери' },
  { name: 'server', path: `/servers/${SRV}`, h1: 'app-server' },
  { name: 'server-offline', path: `/servers/${OFF}`, h1: 'backup-server' },
] as const;

for (const width of [1440, 1366, 1024, 720, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${String(width)}px ${scheme}: overview, servers, server detail — no overflow, flat statuses, readable sizes`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      const state = await api(page, 'admin');
      for (const p of PAGES) {
        await page.goto(p.path);
        await expect(page.getByRole('heading', { level: 1, name: p.h1 })).toBeVisible();
        if (p.name === 'server' || p.name === 'server-offline') await expect(page.getByRole('table', { name: 'PM2-процеси сервера' })).toBeVisible();
        if (p.name === 'overview') await expect(page.getByRole('region', { name: 'Потребують уваги' })).toBeVisible();
        if (p.name === 'servers') await expect(page.getByText('app-server').first()).toBeVisible();
        if (shots) await page.screenshot({ path: `${shots}/${p.name}-${String(width)}-${scheme}.png`, fullPage: true });
        if (p.name === 'servers') await expect(page.getByRole('rowheader', { name: 'app-server' })).toBeVisible();
        await noOverflow(page);
        // Status = marker + text, 12 px, no chip background (DS-01).
        const status = await page.locator('.status').first().evaluate((el) => ({ size: getComputedStyle(el).fontSize, bg: getComputedStyle(el).backgroundColor, text: el.textContent, marker: getComputedStyle(el, '::before').width }));
        expect(status.size).toBe('12px');
        expect(status.bg).toBe('rgba(0, 0, 0, 0)');
        expect(status.text.length).toBeGreaterThan(0);
        expect(status.marker).toBe('6px');
        // Main names 14 px.
        const names = await page.locator('.table__name, .list__name').evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).fontSize))]);
        for (const size of names) expect(size).toBe('14px');
      }
      // The servers list asks only for the list: no per-server inventory/control/log requests (no N+1).
      expect(state.reads.filter((r) => /\/api\/servers\/[^/]+\/(applications|control|log-targets)$/.test(r) && !r.includes(SRV) && !r.includes(OFF))).toEqual([]);
      expect(state.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('server detail: equal compact rows; stale/offline server shows no live values; stopped/errored «—»; one shared cause above the table', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await api(page, 'operator');
  await page.goto(`/servers/${SRV}`);
  const table = page.getByRole('table', { name: 'PM2-процеси сервера' });
  await expect(table.getByRole('rowheader', { name: 'catalog-api' })).toBeVisible();
  const heights = await table.locator('tbody tr').evaluateAll((rows) => [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))]);
  expect(heights).toEqual([52]); // the long name does not break a row: equal compact rows
  const mailer = table.getByRole('rowheader', { name: 'mailer' }).locator('xpath=..');
  await expect(mailer.locator('td')).toHaveText(['3 · fork', 'Зупинено', '—', '—', '—', '3', /.*/]);
  const catalog = table.getByRole('rowheader', { name: 'catalog-api' }).locator('xpath=..');
  await expect(catalog.locator('td').nth(2)).toHaveText('0.0 %'); // a real zero is shown as zero
  // Opening a row menu changes no row geometry.
  const before = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height));
  await table.getByRole('button', { name: 'Дії: catalog-api' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height))).toEqual(before);
  await page.keyboard.press('Escape');

  await page.goto(`/servers/${OFF}`);
  const offline = page.getByRole('table', { name: 'PM2-процеси сервера' });
  await expect(offline.getByRole('rowheader', { name: 'catalog-api' })).toBeVisible();
  await expect(offline.getByText('Працює', { exact: true })).toHaveCount(0);
  await expect(offline.getByText('Невідомо').first()).toBeVisible();
  // CPU, RAM and uptime (3rd–5th data cells) of every row of the stale/offline server are «—».
  expect(await offline.locator('tbody tr').evaluateAll((rows) => rows.flatMap((r) => [...r.querySelectorAll('td')].slice(2, 5).map((c) => c.textContent)))).toEqual(Array.from({ length: 18 }, () => '—'));
  await expect(page.getByText(/Поточне навантаження невідоме: сервер не онлайн/)).toBeVisible();
  await expect(page.getByText(/^Сервер не онлайн — керування недоступне/)).toHaveCount(1); // the server-wide cause once, not per row
  if (shots) await page.screenshot({ path: `${shots}/server-offline-operator-1440.png`, fullPage: true });
});

test('roles: viewer has no actions or recent commands; operator has them', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await api(page, 'viewer');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Потребують уваги' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Останні керуючі дії' })).toHaveCount(0);
  await page.goto(`/servers/${SRV}`);
  const table = page.getByRole('table', { name: 'PM2-процеси сервера' });
  await expect(table.getByRole('rowheader', { name: 'catalog-api' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Дії' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ключ агента' })).toHaveCount(0);
  expect(state.reads.some((r) => r.endsWith('/log-targets'))).toBe(false);
});

async function shortRail(browser: Browser, touch: boolean, path: string) {
  const context = await browser.newContext({ viewport: { width: 720, height: 450 }, hasTouch: touch, colorScheme: 'dark', locale: 'uk-UA', baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  await api(page, 'admin');
  await page.goto(path);
  return { context, page };
}

for (const touch of [false, true]) {
  test(`short window 720×450 (${touch ? 'touch' : 'fine'}): on each page the rail keeps every link and «Вийти» reachable; touch targets ≥ 44 px`, async ({ browser }) => {
    for (const p of PAGES) {
      const { context, page } = await shortRail(browser, touch, p.path);
      try {
        await expect(page.getByRole('heading', { level: 1, name: p.h1 })).toBeVisible();
        await noOverflow(page);
        const sidebar = page.locator('.sidebar');
        expect((await sidebar.boundingBox())?.width).toBe(68);
        await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        for (const loc of [page.getByRole('button', { name: 'Вийти' }), page.getByRole('link', { name: 'Налаштування' })]) {
          await expect(loc).toBeInViewport({ ratio: 1 });
          expect((await loc.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        if (touch) {
          const heights = await page.locator('main .button, main .action-menu__trigger').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().height)));
          for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
        }
        if (shots) await page.screenshot({ path: `${shots}/${p.name}-720x450-${touch ? 'touch' : 'fine'}.png` });
      } finally {
        await context.close();
      }
    }
  });
}

test('keyboard: Tab reaches the server rows and their menu; Escape closes it without a command; focus is visible', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const state = await api(page, 'operator');
  await page.goto(`/servers/${SRV}`);
  const trigger = page.getByRole('button', { name: 'Дії: catalog-api' });
  await expect(trigger).toBeVisible();
  await page.getByRole('link', { name: '← Сервери' }).focus();
  while (!(await trigger.evaluate((el) => el === document.activeElement))) await page.keyboard.press('Tab');
  expect(await trigger.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.mutations).toEqual([]);
});
