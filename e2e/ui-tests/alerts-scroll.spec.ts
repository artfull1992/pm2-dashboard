import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';

// Review 73bfd84 (P2): full pages of 25 alerts must scroll inside the list card — the document does not grow with the
// list, caption and pager stay outside the scrolling rows, the last record is reachable, details open from a scrolled
// list and return focus and position, refreshes keep the reading position, stale / error notices do not push the
// controls out. Synthetic API only (nothing is sent). Screenshots with NC_UI_SHOTS.

const shots = process.env.NC_UI_SHOTS;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Tab = 'active' | 'resolved';

interface Feed { extra: number; fail: boolean; count: number }

async function api(page: Page, feed: Feed) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const now = new Date(Date.now() - 60_000).toISOString();
    if (req.method() !== 'GET') { await route.fulfill({ status: 409, json: {} }); return; }
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: '00000000-0000-4000-8000-000000000001', email: 'admin@example.com', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] } });
      return;
    }
    if (url.pathname === '/api/alerts/status') {
      await route.fulfill({ json: { engine: { enabled: true, running: true, lastEvaluationAt: now, lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: 60, admin: null } });
      return;
    }
    if (url.pathname === '/api/alerts') {
      if (feed.fail) { await route.fulfill({ status: 503, json: {} }); return; }
      const resolved = url.searchParams.get('state') === 'resolved';
      const page2 = url.searchParams.get('before') !== null;
      const item = (n: number) => ({
        id: `00000000-0000-4000-8000-${String(n + (resolved ? 1000 : 0) + (page2 ? 500 : 0)).padStart(12, '0')}`, rule: n % 2 ? 'process_cpu' : 'process_down', severity: 'warning',
        status: resolved ? 'resolved' : 'firing', resolution: resolved ? 'recovered' : null, serverId: A, serverName: 'node-a', serverStatus: 'online',
        processName: `${page2 ? 'older' : resolved ? 'closed' : 'proc'}-${String(n).padStart(2, '0')}`, pmId: n, detail: n % 2 ? { value: 120, threshold: 90 } : { status: 'stopped' },
        openedAt: now, lastObservedAt: now, resolvedAt: resolved ? now : null, notification: { notify: true, state: 'sent', attempts: 1, lastError: null },
      });
      // `extra` newer records appear at the top of the first page (a refresh after new incidents).
      const numbers = [...Array.from({ length: page2 ? 0 : feed.extra }, (_, i) => 100 + i), ...Array.from({ length: feed.count }, (_, i) => i + 1)].slice(0, 25);
      const items = numbers.map(item);
      await route.fulfill({ json: { items, nextBefore: page2 ? null : items.at(-1)?.id ?? null } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
}

async function open(browser: Browser, o: { viewport: { width: number; height: number }; scheme?: 'light' | 'dark'; touch?: boolean; count?: number }) {
  const context = await browser.newContext({ viewport: o.viewport, colorScheme: o.scheme ?? 'dark', locale: 'uk-UA', hasTouch: o.touch ?? false, isMobile: false, baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  const feed: Feed = { extra: 0, fail: false, count: o.count ?? 25 };
  await api(page, feed);
  return { context, page, feed };
}

const scroller = (page: Page) => page.locator('.incidents__scroll, .incident-records');
const records = (page: Page) => page.locator('.incidents__open');
const docHeight = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);
const box = async (l: Locator) => { const b = await l.boundingBox(); expect(b).not.toBeNull(); return b ?? { x: 0, y: 0, width: 0, height: 0 }; };

async function show(page: Page, tab: Tab) {
  await page.goto('/alerts');
  if (tab === 'resolved') await page.getByRole('tab', { name: 'Історія' }).click();
  await expect(records(page)).toHaveCount(25);
}

/** Wide windows of normal height fit the page into the window; phones and short windows scroll the top blocks away. */
const fitsWindow = (page: Page) => { const v = page.viewportSize(); return v !== null && v.width > 600 && v.height > 640; };

/** The core checks for one viewport and tab. */
async function contained(page: Page, label: string) {
  const vh = page.viewportSize()?.height ?? 0;
  const s = scroller(page);
  const m = await s.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(m.scrollHeight, `${label}: the list scrolls inside its container`).toBeGreaterThan(m.clientHeight);
  expect(m.clientHeight, `${label}: a useful list area`).toBeGreaterThanOrEqual(fitsWindow(page) ? 300 : 280);
  if (fitsWindow(page)) expect(await docHeight(page), `${label}: document fits the window`).toBeLessThanOrEqual(vh + 1);
  if (shots) {
    const pagerBox = await page.getByRole('navigation', { name: /^Сторінки/ }).boundingBox();
    console.log(`[metrics] ${label}: document=${String(await docHeight(page))} list scrollHeight=${String(m.scrollHeight)} clientHeight=${String(m.clientHeight)} pager.y=${String(pagerBox?.y)}`);
  }
  // Phones / short windows: the card fits the window once the top blocks have scrolled away.
  await page.locator('.incidents-card').evaluate((el) => { el.scrollIntoView({ block: 'end' }); });
  // Pager below the scrolling rows, inside the window — not under all 25 records.
  const pager = await box(page.getByRole('navigation', { name: /^Сторінки/ }));
  const list = await box(s);
  expect(pager.y, `${label}: pager after the visible rows`).toBeGreaterThanOrEqual(list.y + list.height - 1);
  expect(pager.y + pager.height, `${label}: pager in the window`).toBeLessThanOrEqual(vh + 1);
  // The last record is reachable by the list's own scroll.
  await s.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(records(page).last()).toBeInViewport();
  const last = await box(records(page).last());
  expect(last.y + last.height).toBeLessThanOrEqual(list.y + list.height + 1);
  return { list, pager };
}

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'compact', viewport: { width: 1366, height: 768 } },
  { name: 'tablet', viewport: { width: 1024, height: 768 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const;

for (const scheme of ['dark', 'light'] as const) {
  for (const v of VIEWPORTS) {
    test(`${v.name} ${scheme}: 25 active and 25 closed records scroll inside the list; pager and last record reachable`, async ({ browser }) => {
      const { context, page } = await open(browser, { viewport: v.viewport, scheme });
      for (const tab of ['active', 'resolved'] as const) {
        await show(page, tab);
        await contained(page, `${v.name} ${tab}`);
        if (shots) await page.screenshot({ path: `${shots}/ntf-scroll-${tab}-${v.name}-${scheme}.png` });
      }
      await context.close();
    });
  }
}

test('the document height does not depend on the number of records (3 vs 25), also in a short window', async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }, { width: 720, height: 450 }, { width: 390, height: 844 }]) {
    const heights: number[] = [];
    for (const count of [3, 25]) {
      const { context, page } = await open(browser, { viewport, count });
      await page.goto('/alerts');
      await expect(records(page)).toHaveCount(count);
      heights.push(await docHeight(page));
      if (count === 25) {
        // Short windows: the card keeps a useful height and its controls are not clipped.
        const card = await box(page.locator('.incidents-card'));
        expect(card.height).toBeGreaterThanOrEqual(279);
        const s = scroller(page);
        expect(await s.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(150);
        const pager = page.getByRole('navigation', { name: /^Сторінки/ });
        await pager.scrollIntoViewIfNeeded();
        await expect(pager.getByRole('button', { name: 'Старіші' })).toBeInViewport();
        if (shots) await page.screenshot({ path: `${shots}/ntf-scroll-short-${String(viewport.width)}x${String(viewport.height)}.png` });
      }
      await context.close();
    }
    expect(heights[1], `${String(viewport.width)}×${String(viewport.height)}: 25 records do not make the page taller than 3`).toBe(heights[0]);
  }
});

test('details from a scrolled list: focus and list position come back after Escape and after «Закрити»', async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page } = await open(browser, { viewport });
    await show(page, 'active');
    const s = scroller(page);
    const target = records(page).nth(14);
    await target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); });
    const position = await s.evaluate((el) => el.scrollTop);
    expect(position).toBeGreaterThan(0);
    await expect(target).toBeInViewport();
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(target).toBeFocused();
    expect(await s.evaluate((el) => el.scrollTop)).toBe(position);
    await target.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(target).toBeFocused();
    expect(await s.evaluate((el) => el.scrollTop)).toBe(position);
    await context.close();
  }
});

test('a refresh that adds newer records at the top keeps the row being read in place', async ({ browser }) => {
  const { context, page, feed } = await open(browser, { viewport: { width: 1440, height: 900 } });
  await show(page, 'active');
  const s = scroller(page);
  // The row being read: proc-13 (identified by its application name, not by its position).
  const row = page.locator('tbody tr', { hasText: 'proc-13' });
  await row.evaluate((el) => { el.scrollIntoView({ block: 'center' }); });
  expect(await s.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(row).toBeInViewport();
  const y0 = (await box(row)).y;
  feed.extra = 2;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(records(page).first().locator('xpath=ancestor::tr')).toContainText('proc-100');
  expect(Math.abs((await box(row)).y - y0)).toBeLessThanOrEqual(2);
  await context.close();
});

test('stale and error notices do not push tabs, filters or the pager out of a 1366×768 window', async ({ browser }) => {
  const { context, page, feed } = await open(browser, { viewport: { width: 1366, height: 768 } });
  await show(page, 'active');
  feed.fail = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByText(/Дані застарілі/)).toBeVisible();
  for (const l of [page.getByRole('tab', { name: 'Історія' }), page.getByLabel('Пошук на цій сторінці'), page.getByRole('button', { name: 'Оновити' }), page.getByRole('navigation', { name: /^Сторінки/ })]) {
    await expect(l).toBeInViewport();
  }
  expect(await docHeight(page)).toBeLessThanOrEqual(769);
  expect(await scroller(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  if (shots) await page.screenshot({ path: `${shots}/ntf-scroll-stale-1366.png` });
  await context.close();
});

test('coarse pointer at 1440 px: 44 px controls, the list still scrolls inside and the pager stays in view', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: { width: 1440, height: 900 }, touch: true });
  await show(page, 'resolved');
  expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
  await contained(page, 'coarse 1440 resolved');
  for (const h of await page.locator('.incidents__pager .button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('«Старіші» from the bottom of a scrolled list opens the next page at its top; the pager stays outside the rows', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: { width: 1440, height: 900 } });
  await show(page, 'resolved');
  const s = scroller(page);
  await s.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await s.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Старіші' }).click();
  await expect(page.getByText('Сторінка 2')).toBeVisible();
  await expect(page.locator('tbody tr').first()).toContainText('older-01');
  expect(await scroller(page).evaluate((el) => el.scrollTop)).toBe(0);
  await context.close();
});
