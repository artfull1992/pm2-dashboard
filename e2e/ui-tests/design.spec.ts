import { expect, type Page, test } from '@playwright/test';

// Unified UI (design task) with synthetic API data only: no DB, credentials, webhook or PM2. Checks what a screenshot
// cannot prove on its own — no page overflow, one shared control height, navigation without hidden focus targets —
// at 1440 and 390 px in light and dark. Screenshots are written only when NC_UI_SHOTS is set.

const shots = process.env.NC_UI_SHOTS;
const SERVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OFFLINE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const fresh = () => new Date(Date.now() - 20_000).toISOString();
const old = '2026-10-14T08:00:00.000Z';
const LONG = 'very-long-service-name-for-layout-checks-with-many-segments-v2';
const names = ['catalog-api', 'billing-api', 'orders-api', 'public-api', LONG, 'reports-worker'];

const settings = {
  revision: 3, updatedAt: old, engineEnabled: true, deliveryEnabled: true,
  rules: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
  timing: { intervalSeconds: 30, cooldownMinutes: 15, reminderEnabled: false, reminderMinutes: 60 },
  advanced: { httpTimeoutMs: 5000, maxAttempts: 6, queueMax: 100 },
  ranges: Object.fromEntries(Object.entries({
    cpuOpenPercent: [1, 10000, 90], cpuClosePercent: [0, 10000, 70],
    confirmSamples: [1, 20, 3], recoverSamples: [1, 20, 2], statusConfirmSamples: [1, 20, 2], restartsThreshold: [1, 1000, 3], restartsWindowMinutes: [2, 1440, 10],
    intervalSeconds: [10, 600, 30], cooldownMinutes: [0, 1440, 15], reminderMinutes: [1, 10080, 60], httpTimeoutMs: [1000, 30000, 5000], maxAttempts: [1, 15, 6], queueMax: [10, 1000, 100],
  }).map(([k, [min, max, d]]) => [k, { min, max, default: d }])),
  slack: { state: 'configured', error: null, generation: 1, configuredAt: old, keyAvailable: true, lastTest: { outcome: 'success', code: null, at: old } },
  queue: { queued: 0, sending: 0, sent: 12, failed: 0, unknown: 0, dropped: 0, cancelled: 0 }, publicUrlConfigured: true,
};

function dashboard() {
  const now = fresh();
  return {
    generatedAt: now, windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
    servers: { total: 3, inactive: 0, active: 3, online: 2, offline: 1, neverConnected: 0 },
    inventory: { current: 2, stale: 0, unavailable: 0, notReported: 1 },
    processes: { live: { total: 9, online: 8, problem: 1, transitional: 0 }, notLive: 0 },
    attentionServers: { items: [{ id: OFFLINE, name: 'backup-server', status: 'offline', reason: 'offline', lastSeenAt: old, inventoryCollectedAt: null }], total: 1, limit: 20 },
    attentionProcesses: { items: [{ serverId: SERVER, serverName: 'app-server', pmId: 5, name: 'reports-worker', status: 'errored', restarts: 14, uptimeSeconds: null }], total: 1, limit: 20 },
    serverList: {
      items: [
        { id: SERVER, name: 'app-server', status: 'online', lastSeenAt: now, metrics: { hostname: 'app-server.example.com', loadAverage: [1.42, 1.1, 0.95] }, inventory: { state: 'current', collectedAt: now }, processes: { total: 6, online: 5, problem: 1 } },
        { id: OFFLINE, name: 'backup-server', status: 'offline', lastSeenAt: old, metrics: null, inventory: { state: 'stale', collectedAt: old }, processes: null },
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'control-server', status: 'online', lastSeenAt: now, metrics: { hostname: 'control-server.example.com', loadAverage: [0.12, 0.2, 0.18] }, inventory: { state: 'current', collectedAt: now }, processes: { total: 3, online: 3, problem: 0 } },
      ],
      total: 3, limit: 50,
    },
    recentActions: { limit: 10, items: [
      { id: '11111111-1111-4111-8111-111111111111', serverId: SERVER, serverName: 'app-server', targetKey: 'orders-api', action: 'restart', status: 'succeeded', reason: null, requestedAt: old, completedAt: old, requestedByMe: true, overdue: false },
    ] },
  };
}

async function api(page: Page, { usersCount = 3 } = {}) {
  const mutations: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const now = fresh();
    if (req.method() !== 'GET') { mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    let data: unknown;
    if (path === '/api/auth/me') {
      data = {
        user: { id: ME, email: 'admin@example.com', role: 'admin' },
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
        csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    } else if (path === '/api/dashboard') data = dashboard();
    else if (path === '/api/servers') {
      data = { items: [
        { id: SERVER, name: 'app-server', isActive: true, createdAt: old, status: 'online', lastSeenAt: now, hasActiveCredential: true },
        { id: OFFLINE, name: 'backup-server', isActive: true, createdAt: old, status: 'offline', lastSeenAt: old, hasActiveCredential: true },
      ], nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === `/api/servers/${SERVER}`) {
      data = { id: SERVER, name: 'app-server', status: 'online', isActive: true, createdAt: old, lastSeenAt: now, hasActiveCredential: true,
        snapshot: { agentVersion: '0.5.0', hostname: 'app-server.example.com', platform: 'linux', arch: 'x64', loadAverage: [1.42, 1.1, 0.95] } };
    } else if (path.endsWith('/applications')) {
      data = {
        serverId: SERVER, serverStatus: 'online', freshWindowSeconds: 180,
        inventory: { state: 'current', source: 'pm2', reason: null, capturedAt: now, collectedAt: now, reportedAt: now, processCount: names.length },
        items: names.map((name, pmId) => ({
          key: `${SERVER}:pm2:${String(pmId)}`, serverId: SERVER, serverName: 'app-server', serverStatus: 'online', source: 'pm2', pmId, name,
          status: name === 'reports-worker' ? 'errored' : 'online', uptimeSeconds: name === 'reports-worker' ? null : 608_460 + pmId * 1000,
          restarts: name === 'reports-worker' ? 14 : pmId, cpuPercent: name === 'reports-worker' ? null : 0.4 + pmId * 3.1, memoryBytes: (68 + pmId * 40) * 1024 ** 2,
          execMode: 'fork', firstSeenAt: old, inventoryState: 'current', capturedAt: now, collectedAt: now,
        })),
      };
    } else if (path.endsWith('/control')) {
      data = { serverId: SERVER, enabled: true, serverStatus: 'online', targetFreshSeconds: 60,
        broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: true },
        targets: names.slice(0, 4).map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (path.endsWith('/log-targets')) {
      data = { serverId: SERVER, state: 'supported', reportedAt: now, targets: names.slice(0, 2).map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok' })) };
    } else if (path.endsWith('/control-commands')) data = { items: [] };
    else if (path === '/api/alerts/status') {
      data = { engine: { enabled: true, running: true, lastEvaluationAt: now, lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: 2,
        admin: { webhookConfigured: true, publicUrlConfigured: true, intervalSeconds: 30, cooldownMinutes: 15, reminderMinutes: 0, maxAttempts: 6, queueMax: 100,
          thresholds: settings.rules, queue: { queued: 0, sending: 0, sent: 12, failed: 0, unknown: 0, dropped: 0 }, lastSentAt: old, lastDeliveryError: null, lastEvaluationError: null } };
    } else if (path === '/api/alerts') {
      const resolved = new URL(req.url()).searchParams.get('state') === 'resolved';
      const inc = (n: number, over: Record<string, unknown>) => ({
        id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, rule: 'process_down', severity: 'critical', status: resolved ? 'resolved' : 'firing',
        resolution: resolved ? 'recovered' : null, serverId: SERVER, serverName: 'app-server', serverStatus: 'online', processName: 'reports-worker', pmId: 5,
        detail: { status: 'errored' }, openedAt: old, lastObservedAt: now, resolvedAt: resolved ? now : null,
        notification: { notify: true, state: 'sent', attempts: 1, lastError: null }, ...over,
      });
      data = { items: resolved ? [inc(9, { rule: 'process_cpu', severity: 'warning', processName: 'orders-api', pmId: 2, detail: { value: 312, threshold: 90 } })] : [
        inc(1, {}),
        inc(2, { rule: 'server_offline', serverId: OFFLINE, serverName: 'backup-server', serverStatus: 'offline', processName: null, pmId: null, detail: { lastSeenAt: old } }),
      ], nextBefore: null };
    } else if (path === '/api/users') {
      data = { items: Array.from({ length: usersCount }, (_, i) => ({
        id: i === 0 ? ME : `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
        email: i === 0 ? 'admin@example.com' : i === 2 ? 'a.very.long.email.address.for.layout@example.com' : `user${String(i)}@example.com`,
        role: i === 0 ? 'admin' : i % 2 ? 'operator' : 'viewer', isActive: i !== 2, createdAt: old, updatedAt: old,
      })), nextAfter: null };
    } else if (path === '/api/settings/alerts') data = settings;
    else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return mutations;
}

const noOverflow = async (page: Page) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
};
/** Visible controls use exactly two height tokens: regular (buttons, inputs, selects) and compact (row/pager). */
const controlHeights = async (page: Page, selector: string) => page.evaluate((sel) => {
  const els = [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.offsetParent !== null && !el.closest('.log-toolbar'));
  return [...new Set(els.map((el) => Math.round(el.getBoundingClientRect().height)))];
}, selector);
const REGULAR = '.button:not(.button--small):not(.action-menu__trigger):not(.rules-form__limits), .field input:not([type="checkbox"]), .field select';
const COMPACT = '.button--small, .action-menu__trigger';

const PAGES = [
  { name: 'overview', path: '/', heading: 'Огляд', ready: (p: Page) => expect(p.getByRole('region', { name: 'Потребують уваги' })).toBeVisible() },
  { name: 'server-services', path: `/servers/${SERVER}`, heading: 'app-server', ready: (p: Page) => expect(p.getByRole('rowheader', { name: LONG })).toBeVisible() },
  { name: 'alerts', path: '/alerts', heading: 'Сповіщення', ready: (p: Page) => expect(p.getByRole('region', { name: /Активні проблеми/ }).getByRole('row')).toHaveCount(3) },
  { name: 'users-create', path: '/users', heading: 'Користувачі', ready: async (p: Page) => {
    await expect(p.getByRole('rowheader', { name: /admin@example.com/ })).toBeVisible();
    await p.getByRole('button', { name: 'Новий користувач' }).click();
    await expect(p.getByRole('dialog', { name: 'Новий користувач' })).toBeVisible();
  } },
  { name: 'settings', path: '/settings/integrations', heading: 'Налаштування', ready: (p: Page) => expect(p.getByRole('heading', { name: 'Slack' })).toBeVisible() },
] as const;

for (const width of [1440, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`pages at ${String(width)}px, ${scheme}: no overflow, one control height, nothing sent`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const mutations = await api(page);
      for (const p of PAGES) {
        await page.goto(p.path);
        await expect(page.getByRole('heading', { level: 1, name: p.heading })).toBeVisible();
        await p.ready(page);
        await noOverflow(page);
        const regular = await controlHeights(page, REGULAR);
        expect(regular, `${p.name}: regular control heights`).toEqual([width < 761 ? 44 : 40]);
        const compact = await controlHeights(page, COMPACT);
        if (compact.length > 0) expect(compact, `${p.name}: compact control heights`).toEqual([width < 761 ? 40 : 32]);
        // Switches keep their own fixed geometry (a generic form rule must never resize them).
        const switches = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.switch input[type="checkbox"]')]
          .filter((el) => el.offsetParent !== null).map((el) => `${String(Math.round(el.getBoundingClientRect().width))}x${String(Math.round(el.getBoundingClientRect().height))}`));
        for (const size of switches) expect(size, `${p.name}: switch size`).toBe('40x24');
        if (shots) await page.screenshot({ path: `${shots}/${p.name}-${String(width)}-${scheme}.png`, fullPage: true });
      }
      expect(mutations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('mobile: a closed menu leaves no hidden links in the Tab order; open menu is reachable and closes with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await api(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Огляд' })).toBeVisible();
  const visited: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => (document.activeElement?.textContent ?? '').trim().slice(0, 30)));
  }
  expect(visited).not.toContain('Сервери');
  expect(visited).not.toContain('Журнал аудиту');
  const toggle = page.getByRole('button', { name: 'Меню' });
  await toggle.click();
  await expect(page.getByRole('link', { name: 'Журнал аудиту' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('link', { name: 'Журнал аудиту' })).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('create dialog: background is inert, Escape with input asks first, focus returns to the opener', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mutations = await api(page);
  await page.goto('/servers');
  const opener = page.getByRole('button', { name: 'Додати сервер' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Новий сервер' });
  await expect(dialog.getByLabel('Назва нового сервера')).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);
  await dialog.getByLabel('Назва нового сервера').fill('draft-server');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alert')).toContainText('не збережено');
  await dialog.getByRole('button', { name: 'Закрити без збереження' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(false);
  expect(mutations).toEqual([]);
});

test('server page: row menu stays open across a polling refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  const mutations = await api(page);
  await page.goto(`/servers/${SERVER}`);
  const trigger = page.getByRole('button', { name: 'Дії: catalog-api' });
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: 'Перезапустити', exact: true })).toBeVisible();
  await page.clock.runFor(16_000);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'Перезапустити', exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
});
