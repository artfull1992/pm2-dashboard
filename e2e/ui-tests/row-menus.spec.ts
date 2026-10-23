import { expect, type Locator, type Page, test } from '@playwright/test';

// Floating row menus ("Дії") with synthetic API data only: no DB, credentials or PM2. The menu must be an overlay —
// opening it changes neither the row height nor the table box nor the scroll container — and must be fully visible
// (not clipped by the table's overflow) at the bottom row, at the right edge and in a horizontally scrolled table.
// Opening menus never sends a command. Screenshots are written only when NC_UI_SHOTS is set.

const shots = process.env.NC_UI_SHOTS;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SERVERS = { [A]: 'app-server', [B]: 'worker-server' } as const;
const NAMES = ['catalog-api', 'billing-api', 'orders-api', 'public-api', 'reports-worker', 'mailer', 'search-api', 'media-api', 'auth-api', 'cron-worker', 'gateway', 'export-worker'];

interface Api { mutations: string[]; capabilityReads: string[]; hide: Set<string> }

async function api(page: Page): Promise<Api> {
  const state: Api = { mutations: [], capabilityReads: [], hide: new Set() };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const now = new Date(Date.now() - 20_000).toISOString();
    if (req.method() !== 'GET') { state.mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    const item = (serverId: string, name: string, pmId: number) => ({
      key: `${serverId}:pm2:${String(pmId)}`, serverId, serverName: SERVERS[serverId as keyof typeof SERVERS], serverStatus: 'online', source: 'pm2', pmId, name,
      status: pmId === 4 ? 'errored' : 'online', uptimeSeconds: 608_460 + pmId * 1000, restarts: pmId, cpuPercent: 0.4 + pmId, memoryBytes: (68 + pmId * 9) * 1024 ** 2,
      execMode: 'fork', firstSeenAt: now, inventoryState: 'current', capturedAt: now, collectedAt: now,
    });
    const items = (serverId: string) => NAMES.map((n, i) => item(serverId, n, i)).filter((a) => !state.hide.has(a.key));
    let data: unknown;
    if (path === '/api/auth/me') {
      data = { user: { id: ME, email: 'admin@example.com', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] };
    } else if (path === '/api/servers') {
      data = { items: [A, B].map((id) => ({ id, name: SERVERS[id as keyof typeof SERVERS], isActive: true, createdAt: now, status: 'online', lastSeenAt: now, hasActiveCredential: true })), nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/applications') {
      const only = url.searchParams.get('serverId');
      data = { items: [...(only === B ? [] : items(A)), ...(only === A ? [] : items(B))], nextCursor: null, freshWindowSeconds: 180 };
    } else if (path === `/api/servers/${A}` || path === `/api/servers/${B}`) {
      const id = path.split('/')[3] ?? '';
      data = { id, name: SERVERS[id as keyof typeof SERVERS], status: 'online', isActive: true, createdAt: now, lastSeenAt: now, hasActiveCredential: true, snapshot: null };
    } else if (path === `/api/servers/${A}/applications` || path === `/api/servers/${B}/applications`) {
      const id = path.split('/')[3] ?? '';
      data = { serverId: id, serverStatus: 'online', freshWindowSeconds: 180, items: items(id),
        inventory: { state: 'current', source: 'pm2', reason: null, capturedAt: now, collectedAt: now, reportedAt: now, processCount: NAMES.length } };
    } else if (/^\/api\/servers\/[^/]+\/control$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      state.capabilityReads.push(path);
      data = { serverId: id, enabled: true, serverStatus: 'online', targetFreshSeconds: 60, broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: true },
        targets: NAMES.slice(0, 10).map((name, pmId) => ({ targetKey: `${name}-${id.slice(0, 1)}`, name, pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (/^\/api\/servers\/[^/]+\/log-targets$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      state.capabilityReads.push(path);
      data = { serverId: id, state: 'supported', reportedAt: now, targets: NAMES.map((name, pmId) => ({ targetKey: `${name}-${id.slice(0, 1)}`, name, pmId, matchStatus: 'ok' })) };
    } else if (path.endsWith('/control-commands')) data = { items: [] };
    else if (path === '/api/users') {
      data = { items: Array.from({ length: 14 }, (_, i) => ({
        id: i === 0 ? ME : `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, email: i === 0 ? 'admin@example.com' : `user${String(i)}@example.com`,
        role: i === 0 ? 'admin' : i % 2 ? 'operator' : 'viewer', isActive: true, createdAt: now, updatedAt: now,
      })), nextAfter: null };
    } else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return state;
}

/** Everything that would move if the menu were part of the table flow. */
const geometry = (page: Page) => page.evaluate(() => {
  const wrap = document.querySelector<HTMLElement>('.table-wrap');
  const table = wrap?.querySelector('table');
  const box = table?.getBoundingClientRect();
  return {
    rows: [...(table?.querySelectorAll('tbody tr') ?? [])].map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10),
    table: box ? [box.width, box.height] : null,
    wrap: wrap ? [wrap.scrollWidth, wrap.scrollHeight, wrap.clientWidth, wrap.clientHeight, wrap.scrollLeft] : null,
    page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
  };
});

/** The open menu lies inside the viewport, outside the table, and every item is the topmost element at its centre. */
async function expectVisibleOverlay(page: Page) {
  const popup = page.locator('.action-menu__popup');
  await expect(popup).toBeVisible();
  const report = await page.evaluate(() => {
    const p = document.querySelector<HTMLElement>('.action-menu__popup');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    const items = [...p.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    return {
      inBody: p.parentElement === document.body,
      inTable: Boolean(p.closest('.table-wrap')),
      box: [r.left, r.top, r.right, r.bottom],
      viewport: [document.documentElement.clientWidth, window.innerHeight],
      hits: items.map((el) => {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return hit === el || el.contains(hit);
      }),
      overflowing: p.scrollHeight > p.clientHeight + 1,
    };
  });
  expect(report).not.toBeNull();
  if (!report) return;
  expect(report.inBody).toBe(true);
  expect(report.inTable).toBe(false);
  const [left, top, right, bottom] = report.box as [number, number, number, number];
  const [vw, vh] = report.viewport as [number, number];
  expect(left).toBeGreaterThanOrEqual(0);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(right).toBeLessThanOrEqual(vw);
  expect(bottom).toBeLessThanOrEqual(vh);
  // Every item reachable: either fully shown or reachable by the menu's own scroll.
  if (!report.overflowing) expect(report.hits.every(Boolean)).toBe(true);
}

async function openAndCheck(page: Page, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  const before = await geometry(page);
  await trigger.click();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  await expectVisibleOverlay(page);
  expect(await geometry(page)).toEqual(before);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`row menus are overlays at ${String(viewport.width)}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      const state = await api(page);
      const tag = `${String(viewport.width)}-${scheme}`;

      // Server page: first row, then the bottom row of the page, then the horizontally scrolled table (mobile). The
      // all-applications list has no row menus since the master-detail workspace (its menu lives in the details).
      await page.goto(`/servers/${A}`);
      await expect(page.getByRole('heading', { name: 'Сервіси сервера' })).toBeVisible();
      const first = page.getByRole('button', { name: 'Дії: catalog-api' });
      await openAndCheck(page, first);
      expect(state.capabilityReads.sort()).toEqual([`/api/servers/${A}/control`, `/api/servers/${A}/log-targets`]);
      if (shots) await page.screenshot({ path: `${shots}/server-menu-first-${tag}.png` });
      await page.keyboard.press('Escape');
      await expect(first).toBeFocused();

      const last = page.getByRole('button', { name: 'Дії: export-worker' });
      // The bottom row placed right at the bottom edge of the viewport: the menu opens upwards.
      await last.evaluate((el) => { el.scrollIntoView({ block: 'end' }); });
      await openAndCheck(page, last);
      await expect(page.locator('.action-menu__popup')).toHaveAttribute('data-placement', 'top');
      if (shots) await page.screenshot({ path: `${shots}/server-menu-bottom-${tag}.png` });
      await page.keyboard.press('Escape');

      if (viewport.width === 390) {
        // The table scrolls horizontally inside its wrapper; the menu of a row at the right edge stays on screen.
        const scrolled = await page.evaluate(() => { const w = document.querySelector<HTMLElement>('.table-wrap'); if (!w) return 0; w.scrollLeft = w.scrollWidth; return w.scrollLeft; });
        expect(scrolled).toBeGreaterThan(0);
        await openAndCheck(page, page.getByRole('button', { name: 'Дії: gateway' }));
        if (shots) await page.screenshot({ path: `${shots}/server-menu-hscroll-${tag}.png` });
        await page.keyboard.press('Escape');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
;

      // The same menu, its items in order.
      await openAndCheck(page, page.getByRole('button', { name: 'Дії: orders-api' }));
      expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Запустити', 'Зупинити', 'Перезапустити', 'Переглянути логи']);
      if (shots) await page.screenshot({ path: `${shots}/server-menu-${tag}.png` });
      await page.keyboard.press('Escape');

      // Users: no regression of the shared menu.
      await page.goto('/users');
      await openAndCheck(page, page.getByRole('button', { name: 'Дії: user13@example.com' }));
      expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Доступи', 'Змінити роль', 'Деактивувати']);
      if (shots) await page.screenshot({ path: `${shots}/users-menu-${tag}.png` });
      await page.keyboard.press('Escape');

      expect(state.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test('keyboard, outside click, scroll re-placement, polling, navigation and a disappearing row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  const state = await api(page);
  await page.goto(`/servers/${A}`);
  const trigger = page.getByRole('button', { name: 'Дії: orders-api' });
  await expect(trigger).toBeVisible();

  // Keyboard: Enter opens on the first item, arrows move, Escape returns focus; Tab leaves the menu.
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Запустити', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Зупинити' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Переглянути логи' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Запустити', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Переглянути логи' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(trigger).not.toBeFocused();

  // Outside click and a second trigger click close it; one menu at a time.
  await trigger.click();
  await page.getByRole('heading', { name: 'Сервіси сервера' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.click();
  await trigger.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await trigger.click();
  await page.getByRole('button', { name: 'Дії: billing-api' }).click();
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(page.getByRole('menu')).toHaveAttribute('aria-label', 'Дії для billing-api');
  await page.keyboard.press('Escape');

  // Scrolling the page re-places the menu next to its trigger.
  await trigger.click();
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => {
    const [t, p] = await Promise.all([trigger.boundingBox(), page.locator('.action-menu__popup').boundingBox()]);
    return t && p ? Math.round(p.y - (t.y + t.height)) : null;
  }).toBe(4);

  // Polling refresh with the menu open: still open, focus kept, no command.
  await page.getByRole('menuitem', { name: 'Перезапустити' }).focus();
  await page.clock.runFor(16_000);
  await expect(page.getByRole('menuitem', { name: 'Перезапустити' })).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  // The row disappears on the next refresh: its menu goes with it.
  state.hide.add(`${A}:pm2:2`);
  await page.clock.runFor(16_000);
  await expect(trigger).toHaveCount(0);
  await expect(page.locator('.action-menu__popup')).toHaveCount(0);

  // Navigating to another server leaves no floating menu behind.
  await page.getByRole('button', { name: 'Дії: catalog-api' }).click();
  await expect(page.getByRole('menu')).toHaveCount(1);
  await page.evaluate((id) => { window.history.pushState({}, '', `/servers/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, B);
  await expect(page.locator('.action-menu__popup')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Дії: catalog-api' })).toBeVisible();
  expect(state.mutations).toEqual([]);
});
