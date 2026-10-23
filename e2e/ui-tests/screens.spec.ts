import { expect, type Page, test } from '@playwright/test';

// Access dialog, service tables, overview and alerts (frontend task "repair access forms and streamline monitoring
// views") — real browser, synthetic API data only (no DB, credentials, PM2 or Slack). Measures what screenshots
// showed: form controls of a text field's size, service names broken into 3–4 letters, repeated row explanations,
// a half-empty attention block, and delivery semantics. Screenshots only when NC_UI_SHOTS is set (synthetic names).

const shots = process.env.NC_UI_SHOTS;
const ME = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OP = 'aaaaaaaa-0000-4000-8000-000000000001';
const SRV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SRV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LONG = 'very-long-service-name-without-any-spaces-for-layout-checks-and-wrapping-v2';
const SERVICES = ['catalog-api', 'billing-api', 'orders-api', 'public-api', 'reports-worker', 'mailer', 'search-api', 'media-api', 'auth-api', 'cron-worker', 'gateway', 'export-worker', LONG,
  ...Array.from({ length: 27 }, (_, i) => `queue-consumer-${String(i + 1).padStart(2, '0')}`)];
const fresh = () => new Date(Date.now() - 20_000).toISOString();
const old = '2026-10-14T08:00:00.000Z';

type Role = 'admin' | 'operator' | 'viewer';
interface Options { role: Role; dashboard?: 'processes-only' | 'none' | 'servers-only'; control?: 'allowlist-partial' | 'disabled' | 'broker-down'; logs?: 'supported' | 'unsupported' }

async function api(page: Page, o: Options) {
  const mutations: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const now = fresh();
    if (req.method() !== 'GET') { mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    const perms = o.role === 'admin' ? ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage']
      : o.role === 'operator' ? ['monitoring:read', 'processes:control', 'logs:read'] : ['monitoring:read'];
    const apps = SERVICES.slice(0, 14).map((name, pmId) => ({
      key: `${SRV}:pm2:${String(pmId)}`, serverId: SRV, serverName: 'app-server', serverStatus: 'online', source: 'pm2', pmId, name,
      status: pmId === 4 ? 'errored' : pmId === 5 ? 'stopped' : 'online', uptimeSeconds: 600_000 + pmId, restarts: pmId, cpuPercent: 0.4 + pmId, memoryBytes: (60 + pmId) * 1024 ** 2,
      execMode: 'fork', firstSeenAt: old, inventoryState: 'current', capturedAt: now, collectedAt: now,
    }));
    let data: unknown;
    if (path === '/api/auth/me') {
      data = { user: { id: o.role === 'admin' ? ME : OP, email: `${o.role}@example.com`, role: o.role }, permissions: perms, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    } else if (path === '/api/users') {
      data = { items: [
        { id: ME, email: 'admin@example.com', role: 'admin', isActive: true, createdAt: old, updatedAt: old },
        { id: OP, email: 'operator.with.a.long.address@example.com', role: 'operator', isActive: true, createdAt: old, updatedAt: old },
      ], nextAfter: null };
    } else if (path === `/api/users/${OP}/access`) {
      data = { userId: OP, email: 'operator.with.a.long.address@example.com', role: 'operator', isActive: true, global: false, revision: 4, servers: [
        { serverId: SRV, serverName: 'app-server', serverActive: true, mode: 'selected', grantedAt: old,
          services: [{ name: 'catalog-api', available: true }, { name: 'billing-api', available: true }, { name: 'legacy-importer', available: false }] },
        { serverId: SRV2, serverName: 'worker-server-with-a-rather-long-name', serverActive: true, mode: 'all', grantedAt: old, services: [] },
      ] };
    } else if (path === '/api/access/servers') {
      data = { items: [{ id: SRV, name: 'app-server', isActive: true }, { id: SRV2, name: 'worker-server-with-a-rather-long-name', isActive: true },
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'reporting-server', isActive: false }], nextAfterName: null };
    } else if (path === `/api/access/servers/${SRV}/services`) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      data = { serverId: SRV, items: SERVICES.filter((n) => n.toLowerCase().includes(q)).map((name) => ({ name, processes: 1 })), truncated: false };
    } else if (path === `/api/servers/${SRV}`) {
      data = { id: SRV, name: 'app-server', status: 'online', isActive: true, createdAt: old, lastSeenAt: now, hasActiveCredential: true,
        snapshot: { agentVersion: '0.5.0', hostname: 'app-server', platform: 'linux', arch: 'x64', loadAverage: [0.4, 0.3, 0.2] } };
    } else if (path === `/api/servers/${SRV}/applications`) {
      data = { serverId: SRV, serverStatus: 'online', freshWindowSeconds: 180, items: apps,
        inventory: { state: 'current', source: 'pm2', reason: null, capturedAt: now, collectedAt: now, reportedAt: now, processCount: apps.length } };
    } else if (path === `/api/servers/${SRV}/control`) {
      const c = o.control ?? 'allowlist-partial';
      data = { serverId: SRV, enabled: c !== 'disabled', serverStatus: 'online', targetFreshSeconds: 60,
        broker: { state: c === 'broker-down' ? 'unavailable' : 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: true, mode: 'allowlist', protocol: 1, total: null },
        targets: apps.slice(0, 2).map((a) => ({ targetKey: a.name, name: a.name, pmId: a.pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (path === `/api/servers/${SRV}/log-targets`) {
      data = { serverId: SRV, state: o.logs ?? 'unsupported', reportedAt: now, targets: [] };
    } else if (path.endsWith('/control-commands')) data = { items: [] };
    else if (path === '/api/servers') {
      data = { items: [{ id: SRV, name: 'app-server', isActive: true, createdAt: old, status: 'online', lastSeenAt: now, hasActiveCredential: true }], nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/dashboard') {
      const kind = o.dashboard ?? 'processes-only';
      const procs = kind === 'processes-only' ? [
        { serverId: SRV, serverName: 'app-server', pmId: 4, name: 'reports-worker', status: 'errored', restarts: 14, uptimeSeconds: null },
        { serverId: SRV, serverName: 'app-server', pmId: 5, name: 'mailer', status: 'stopped', restarts: 0, uptimeSeconds: null },
        { serverId: SRV, serverName: 'app-server', pmId: 6, name: 'search-api', status: 'waiting restart', restarts: 3, uptimeSeconds: null },
      ] : [];
      const srvs = kind === 'servers-only' ? [{ id: SRV2, name: 'backup-server', status: 'offline', reason: 'offline', lastSeenAt: old, inventoryCollectedAt: null }] : [];
      data = {
        generatedAt: now, windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
        servers: { total: 2, inactive: 0, active: 2, online: 2, offline: 0, neverConnected: 0 },
        inventory: { current: 2, stale: 0, unavailable: 0, notReported: 0 },
        processes: { live: { total: 20, online: 20 - procs.length, problem: procs.length, transitional: 0 }, notLive: 0 },
        attentionServers: { items: srvs, total: srvs.length, limit: 20 }, attentionProcesses: { items: procs, total: procs.length, limit: 20 },
        serverList: { items: [
          { id: SRV, name: 'app-server', status: 'online', lastSeenAt: now, metrics: { hostname: 'app-server', loadAverage: [0.4, 0.3, 0.2] }, inventory: { state: 'current', collectedAt: now }, processes: { total: 14, online: 12, problem: 2 } },
          { id: SRV2, name: 'worker-server', status: 'online', lastSeenAt: now, metrics: { hostname: 'ip-10-0-0-12.internal', loadAverage: [1.4, 1.1, 0.9] }, inventory: { state: 'current', collectedAt: now }, processes: { total: 6, online: 6, problem: 0 } },
        ], total: 2, limit: 50 },
        recentActions: o.role === 'viewer' ? null : { limit: 10, items: [] },
      };
    } else if (path === '/api/alerts/status') {
      data = { engine: { enabled: true, running: true, lastEvaluationAt: now, lastEvaluationOk: true }, delivery: { enabled: false }, activeCount: 3, admin: null };
    } else if (path === '/api/alerts') {
      const resolved = url.searchParams.get('state') === 'resolved';
      const inc = (n: number, over: Record<string, unknown>) => ({
        id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, rule: 'process_restarts', severity: 'warning', status: resolved ? 'resolved' : 'firing',
        resolution: resolved ? 'recovered' : null, serverId: SRV, serverName: 'app-server', serverStatus: 'online', processName: 'reports-worker', pmId: 4,
        detail: { delta: 7, spanSeconds: 600 }, openedAt: old, lastObservedAt: now, resolvedAt: resolved ? now : null,
        notification: { notify: true, state: 'sent', attempts: 1, lastError: null }, ...over,
      });
      data = { items: resolved ? [] : [
        inc(1, {}),
        inc(2, { rule: 'process_down', severity: 'critical', processName: 'mailer', pmId: 5, detail: { status: 'stopped' }, notification: { notify: true, state: 'queued', attempts: 0, lastError: null } }),
        inc(3, { rule: 'server_offline', severity: 'critical', serverId: SRV2, serverName: 'backup-server', serverStatus: 'offline', processName: null, pmId: null, detail: { lastSeenAt: old }, notification: { notify: true, state: 'unknown', attempts: 2, lastError: 'timeout' } }),
      ], nextBefore: null };
    } else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return mutations;
}

/** 720 CSS px = a 1440 px screen at 200 % zoom. */
const WIDTHS = [1440, 1024, 720, 390] as const;
const THEMES = ['light', 'dark'] as const;
const noPageOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
async function shot(page: Page, name: string) { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); }

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${theme} ${String(width)}`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: 900 } });

      test('access dialog: compact choices, readable names, selection kept while searching, nothing saved', async ({ page }) => {
        const mutations = await api(page, { role: 'admin' });
        await page.goto('/users');
        await page.getByRole('button', { name: /^Дії: operator/ }).click();
        await page.getByRole('menuitem', { name: 'Доступи' }).click();
        const dialog = page.getByRole('dialog', { name: /^Доступи:/ });
        await expect(dialog.getByRole('checkbox', { name: /^catalog-api/ })).toBeVisible();
        await shot(page, `access-${theme}-${String(width)}`);
        // Choice controls keep their own size (not the text field's 100 % width / 40 px height).
        const boxes = await dialog.locator('input[type="checkbox"], input[type="radio"]').evaluateAll((els) => els.map((e) => {
          const r = e.getBoundingClientRect();
          return [Math.round(r.width), Math.round(r.height)];
        }));
        if (shots) console.log(`[metrics] ${theme} ${String(width)} choice boxes`, JSON.stringify(boxes.slice(0, 3)));
        expect(boxes.length).toBeGreaterThan(10);
        for (const [w, h] of boxes) { expect(w).toBeLessThanOrEqual(20); expect(h).toBeLessThanOrEqual(20); }
        // An ordinary service name stays on one line, wide enough to read (no 3–4 letter columns).
        const name = dialog.getByText('catalog-api', { exact: true });
        const nb = await name.boundingBox();
        expect(nb?.width ?? 0).toBeGreaterThan(70);
        expect(nb?.height ?? 99).toBeLessThan(26);
        // The long name wraps inside the dialog and never widens it.
        const dialogBox = await dialog.boundingBox();
        const longBox = await dialog.getByText(LONG, { exact: true }).boundingBox();
        expect((longBox?.x ?? 0) + (longBox?.width ?? 0)).toBeLessThanOrEqual((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) + 1);
        await noPageOverflow(page);
        // Nothing inside the dialog overflows sideways (long e-mail in the title, long server/service names).
        expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
        // Searching does not drop the selection: choose one, search for another, the first is still counted.
        await dialog.getByRole('checkbox', { name: /^orders-api/ }).check();
        await expect(dialog.getByText('Вибрано: 4')).toBeVisible();
        await dialog.getByLabel('Пошук сервісу').fill('queue-consumer-1');
        await expect(dialog.getByRole('checkbox', { name: /^queue-consumer-10/ })).toBeVisible();
        await expect(dialog.getByText('Вибрано: 4')).toBeVisible();
        // The save button stays reachable without scrolling the page.
        const save = dialog.getByRole('button', { name: 'Зберегти доступи' });
        await expect(save).toBeInViewport();
        expect(mutations).toEqual([]);
      });

      test('server services as operator: compact equal rows, one shared explanation, reasons in the row menu', async ({ page }) => {
        await api(page, { role: 'operator', logs: 'unsupported' });
        await page.goto(`/servers/${SRV}`);
        const region = page.getByRole('region', { name: 'Сервіси сервера' });
        await expect(region.getByRole('rowheader', { name: 'catalog-api' })).toBeVisible();
        await shot(page, `services-operator-${theme}-${String(width)}`);
        // Every row with an ordinary name has one height (the deliberately long name may wrap).
        const heights = await region.locator('tbody tr').evaluateAll((rows, long) => rows.filter((r) => !r.textContent.includes(long)).map((r) => Math.round(r.getBoundingClientRect().height)), LONG);
        if (shots) console.log(`[metrics] ${theme} ${String(width)} row heights`, JSON.stringify([...new Set(heights)]));
        expect(new Set(heights).size).toBe(1);
        // ≤ 760 px rows hold a 44 px touch trigger.
        expect(heights[0] ?? 999).toBeLessThanOrEqual(width <= 720 ? 68 : 56);
        // The server-wide log limitation is said once, not on every row.
        await expect(page.getByText(/потрібні оновлені Agent і broker/)).toHaveCount(1);
        await expect(region.locator('tbody').getByText('Не дозволено керування')).toHaveCount(0);
        // A row without any usable action has one keyboard-reachable explanation.
        const why = region.getByRole('button', { name: 'Чому недоступно: billing-api' });
        await expect(why).toHaveCount(0); // billing-api is allowlisted: its menu is "Дії"
        const none = region.getByRole('button', { name: 'Чому недоступно: orders-api' });
        await none.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('.action-menu__popup')).toContainText('allowlist');
        expect(await region.locator('tbody tr').first().evaluate((r) => Math.round(r.getBoundingClientRect().height))).toBe(heights[0]);
        await page.keyboard.press('Escape');
        await expect(none).toBeFocused();
        await noPageOverflow(page);
      });

      test('overview: no empty half for a category without problems; hostname only when different', async ({ page }) => {
        await api(page, { role: 'admin', dashboard: 'processes-only' });
        await page.goto('/');
        const attention = page.getByRole('region', { name: 'Потребують уваги' });
        await expect(attention).toBeVisible();
        await shot(page, `overview-${theme}-${String(width)}`);
        const procs = attention.getByRole('heading', { name: /Сервіси з проблемним статусом/ });
        await expect(procs).toBeVisible();
        const sectionBox = await attention.boundingBox();
        const list = await attention.locator('.attention__group--processes').boundingBox();
        expect((list?.width ?? 0) / (sectionBox?.width ?? 1)).toBeGreaterThan(0.85);
        // Distinct statuses stay distinct.
        await expect(attention.getByText('Помилка', { exact: true })).toBeVisible();
        await expect(attention.getByText('Зупинено', { exact: true })).toBeVisible();
        await expect(attention.getByText('Очікує перезапуску', { exact: true })).toBeVisible();
        // Hostname equal to the name is not repeated; a different one is.
        const servers = page.getByRole('region', { name: 'Сервери' });
        await expect(servers.getByRole('rowheader', { name: 'app-server' }).locator('.cell-meta')).toHaveCount(0);
        await expect(servers.getByText('ip-10-0-0-12.internal')).toBeVisible();
        await noPageOverflow(page);
      });

      test('alerts: application first, delivery result per incident vs Slack switched off now', async ({ page }) => {
        await api(page, { role: 'admin' });
        await page.goto('/alerts');
        // NTF-01: a table on wide windows, records from 760 px down (incl. 720 = 200 % zoom of 1440).
        const active = page.getByRole('tabpanel');
        const records = width <= 760;
        await expect(records ? active.getByRole('article') : active.locator('tbody tr')).toHaveCount(3);
        await shot(page, `alerts-${theme}-${String(width)}`);
        await expect(page.getByText(/Надсилання в Slack зараз вимкнено/)).toBeVisible();
        if (!records) await expect(active.getByRole('columnheader', { name: 'Доставка' })).toBeVisible();
        // queued is never shown as delivered; unknown is said as unknown.
        const row = (name: string) => (records ? active.getByRole('article') : active.getByRole('row')).filter({ hasText: name });
        await expect(row('mailer')).toContainText('У черзі');
        await expect(row('mailer')).not.toContainText('Надіслано');
        await expect(row('backup-server')).toContainText('невідомий');
        const heights = await active.locator('tbody tr').evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
        for (const h of heights) expect(h).toBeLessThanOrEqual(width === 1440 ? 90 : 110);
        await noPageOverflow(page);
      });
    });
  }
}

test('overview: nothing to attend → one calm line; viewer sees no control explanations', async ({ page }) => {
  await api(page, { role: 'viewer', dashboard: 'none' });
  await page.goto('/');
  const attention = page.getByRole('region', { name: 'Потребують уваги' });
  await expect(attention.getByText(/Проблем немає/)).toBeVisible();
  await expect(attention.locator('h3')).toHaveCount(0);
  await page.goto(`/servers/${SRV}`);
  await expect(page.getByRole('rowheader', { name: 'catalog-api' })).toBeVisible();
  await expect(page.getByText(/Керування|allowlist|broker|логів/i)).toHaveCount(0);
});

test('services: role vs broker give different explanations (admin, broker down; control switched off)', async ({ page }) => {
  await api(page, { role: 'admin', control: 'broker-down', logs: 'supported' });
  await page.goto(`/servers/${SRV}`);
  await expect(page.getByText(/Broker недоступний/).first()).toBeVisible();
  await page.unrouteAll();
  await api(page, { role: 'admin', control: 'disabled', logs: 'supported' });
  await page.goto(`/servers/${SRV}`);
  await expect(page.getByText(/вимкнено на сервері API/).first()).toBeVisible();
});
