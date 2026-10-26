import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';

// The access page (ACL-01…15, docs/design/part-02, ADR-035) in a real browser with synthetic API data only: the save
// is answered by the fixture, nothing is sent anywhere. Screenshots (NC_UI_SHOTS) are named like the references,
// ACL-xx--<theme>--<viewport>.png. Checks: no page overflow in both themes at 1440×900 / 1366×768 / 1024×768 /
// 390×844; the save bar and its buttons stay in view; lists scroll inside their panes (no page scroll on a desktop
// window); 16 px choice controls with large labels; keyboard (radio arrows, Enter in search, dialogs' Escape and focus
// return); browser Back and closing the tab with a draft; a short window; exactly one PUT per save.

const shots = process.env.NC_UI_SHOTS;
const NOW = new Date('2026-10-26T08:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = id(1);
const SRV = { a: id(101), b: id(102), c: id(103), d: id(104), e: id(105), f: id(106) };
const NAMES: Record<string, string> = { [SRV.a]: 'node-a', [SRV.b]: 'node-b', [SRV.c]: 'node-c', [SRV.d]: 'node-d', [SRV.e]: 'node-e', [SRV.f]: 'node-f' };
const WORDS = ['api-service', 'auth-service', 'billing-worker', 'cache-updater', 'catalog-worker', 'delivery-api', 'email-sender', 'export-job', 'gateway', 'import-job'];
const SERVICES = Array.from({ length: 100 }, (_, i) => (i < WORDS.length ? WORDS[i] ?? '' : `service-${String(i).padStart(3, '0')}`));
const at = '2026-10-20T09:00:00.000Z';
type Acl = 'ACL-01' | 'ACL-02' | 'ACL-03' | 'ACL-04' | 'ACL-05' | 'ACL-06' | 'ACL-07' | 'ACL-08' | 'ACL-09' | 'ACL-10' | 'ACL-11' | 'ACL-12' | 'ACL-13' | 'ACL-14' | 'ACL-15';

const grant = (serverId: string, mode: 'all' | 'selected', services: string[] = []) =>
  ({ serverId, serverName: NAMES[serverId], serverActive: true, mode, grantedAt: at, services: services.map((name) => ({ name, available: true })) });
function initial(acl: Acl) {
  const base = { userId: USER, email: 'operator01@example.invalid', role: acl === 'ACL-13' ? 'viewer' : 'operator', isActive: true, global: false, revision: 3 };
  if (acl === 'ACL-01') return { ...base, servers: [] };
  if (acl === 'ACL-02') return { ...base, servers: [grant(SRV.a, 'all')] };
  if (acl === 'ACL-03') return { ...base, servers: [grant(SRV.a, 'selected', ['api-service', 'billing-worker', 'gateway'])] };
  return { ...base, servers: [grant(SRV.a, 'selected', ['api-service', 'billing-worker', 'gateway']), grant(SRV.b, 'all'), grant(SRV.c, 'selected', ['auth-service', 'export-job'])] };
}

interface Api { puts: string[]; reads: string[] }
async function api(page: Page, acl: Acl): Promise<Api> {
  const log: Api = { puts: [], reads: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.reads.push(`${req.method()} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: id(0), email: 'admin@example.invalid', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] } });
      return;
    }
    if (url.pathname === '/api/users') {
      await route.fulfill({ json: { items: [{ id: USER, email: 'operator01@example.invalid', role: 'operator', isActive: true, createdAt: at, updatedAt: at }], nextAfter: null } });
      return;
    }
    if (url.pathname === `/api/users/${USER}/access` && req.method() === 'GET') {
      if (acl === 'ACL-08') { await route.fulfill({ status: 503, json: {} }); return; }
      await route.fulfill({ json: initial(acl) });
      return;
    }
    if (url.pathname === `/api/users/${USER}/access` && req.method() === 'PUT') {
      log.puts.push(req.postData() ?? '');
      if (acl === 'ACL-10') return; // pending: never answered
      if (acl === 'ACL-09') { await route.fulfill({ status: 503, json: {} }); return; }
      await route.fulfill({ json: { ...initial(acl), revision: 4 } });
      return;
    }
    if (url.pathname === '/api/access/servers') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      await route.fulfill({ json: { items: Object.entries(NAMES).filter(([, n]) => n.includes(q)).map(([sid, name]) => ({ id: sid, name, isActive: true })), nextAfterName: null } });
      return;
    }
    const svc = /^\/api\/access\/servers\/([0-9a-f-]{36})\/services$/.exec(url.pathname);
    if (svc) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      await route.fulfill({ json: { serverId: svc[1], items: SERVICES.filter((n) => n.includes(q)).map((name) => ({ name, processes: 1 })), truncated: false } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  return log;
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, compact: { width: 1366, height: 768 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } } as const;
type Viewport = keyof typeof VIEWPORTS;

async function open(browser: Browser, o: { scheme?: 'light' | 'dark'; viewport: { width: number; height: number }; acl: Acl; touch?: boolean }) {
  const context = await browser.newContext({ viewport: o.viewport, colorScheme: o.scheme ?? 'dark', locale: 'uk-UA', timezoneId: 'Europe/Kyiv', hasTouch: o.touch ?? false, baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const log = await api(page, o.acl);
  return { context, page, log };
}
const noPageOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
const inViewport = async (page: Page, l: Locator) => {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  const v = page.viewportSize() ?? { width: 0, height: 0 };
  expect((b?.y ?? -1)).toBeGreaterThanOrEqual(-0.5);
  expect((b?.y ?? 0) + (b?.height ?? 0)).toBeLessThanOrEqual(v.height + 0.5);
  expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(v.width + 0.5);
};
const save = (page: Page) => page.getByRole('button', { name: /^(Зберегти|Збереження…)$/ });
const status = (page: Page) => page.getByRole('group', { name: 'Збереження доступів' }).getByRole('status');

async function show(page: Page, acl: Acl) {
  await page.goto(`/users/${USER}/access`);
  await expect(page.getByRole('heading', { level: 1, name: 'Доступи користувача' })).toBeVisible();
  if (acl === 'ACL-08') { await expect(page.getByRole('heading', { name: 'Не вдалося отримати доступи' })).toBeVisible(); return; }
  if (acl === 'ACL-01') { await expect(page.getByRole('heading', { name: 'Доступів немає' })).toBeVisible(); return; }
  await expect(page.getByRole('heading', { level: 2, name: 'node-a' })).toBeVisible();
  if (acl === 'ACL-02') { await expect(page.getByText('Доступ до всіх сервісів сервера')).toBeVisible(); return; }
  await expect(page.getByRole('checkbox', { name: 'service-099' })).toBeAttached();
  if (acl === 'ACL-05') { await page.locator('.acl-service', { hasText: 'service-050' }).scrollIntoViewIfNeeded(); return; }
  if (acl === 'ACL-06') { await page.getByLabel('Пошук сервісів цього сервера').fill('zzz'); await expect(page.getByText(/Сервісів за запитом «zzz» не знайдено/)).toBeVisible(); return; }
  if (acl === 'ACL-07' || acl === 'ACL-09' || acl === 'ACL-10' || acl === 'ACL-12') {
    await page.getByRole('checkbox', { name: 'auth-service' }).check();
    await expect(status(page)).toHaveText('Є незбережені зміни');
    if (acl === 'ACL-09') { await save(page).click(); await expect(page.getByText('Не вдалося зберегти доступи')).toBeVisible(); }
    if (acl === 'ACL-10') { await save(page).click(); await expect(page.getByRole('button', { name: 'Збереження…' })).toBeDisabled(); }
    if (acl === 'ACL-12') { await page.getByRole('button', { name: 'Скасувати', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Скасувати зміни?' })).toBeVisible(); }
    return;
  }
  if (acl === 'ACL-11') { await page.getByRole('button', { name: 'Прибрати доступ до node-a' }).click(); await expect(page.getByRole('dialog', { name: 'Прибрати доступ до сервера?' })).toBeVisible(); return; }
  if (acl === 'ACL-14' || acl === 'ACL-15') {
    await page.getByRole('button', { name: '+ Додати сервер' }).click();
    const dialog = page.getByRole('dialog', { name: 'Додати сервер' });
    await expect(dialog.getByRole('button', { name: 'Додати node-d' })).toBeVisible();
    if (acl === 'ACL-15') { await dialog.getByLabel('Пошук серверів для призначення').fill('zzz'); await expect(dialog.getByText('Серверів за запитом «zzz» не знайдено.')).toBeVisible(); }
  }
}

const STATES: { acl: Acl; on: Viewport[] }[] = [
  { acl: 'ACL-01', on: ['desktop', 'mobile'] }, { acl: 'ACL-02', on: ['desktop', 'mobile'] }, { acl: 'ACL-03', on: ['desktop', 'mobile'] },
  { acl: 'ACL-04', on: ['desktop', 'compact', 'tablet', 'mobile'] }, { acl: 'ACL-05', on: ['desktop', 'compact', 'tablet', 'mobile'] },
  { acl: 'ACL-06', on: ['desktop', 'mobile'] }, { acl: 'ACL-07', on: ['desktop', 'mobile'] }, { acl: 'ACL-08', on: ['desktop', 'mobile'] },
  { acl: 'ACL-09', on: ['desktop', 'mobile'] }, { acl: 'ACL-10', on: ['desktop', 'mobile'] }, { acl: 'ACL-11', on: ['desktop', 'mobile'] },
  { acl: 'ACL-12', on: ['desktop', 'mobile'] }, { acl: 'ACL-13', on: ['desktop', 'mobile'] }, { acl: 'ACL-14', on: ['desktop', 'mobile'] },
  { acl: 'ACL-15', on: ['desktop', 'mobile'] },
];

for (const scheme of ['dark', 'light'] as const) {
  test(`ACL-01…15 states (${scheme}): layout, save bar in view, no overflow, screenshots`, async ({ browser }) => {
    test.setTimeout(240_000);
    for (const { acl, on } of STATES) {
      for (const vp of on) {
        const { context, page, log } = await open(browser, { scheme, viewport: VIEWPORTS[vp], acl });
        await show(page, acl);
        await noPageOverflow(page);
        const dialog = page.getByRole('dialog');
        if (await dialog.count() > 0) {
          await inViewport(page, dialog);
          expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
        } else {
          await inViewport(page, save(page)); // the save bar never leaves the window
          await inViewport(page, page.getByRole('button', { name: 'Скасувати', exact: true }));
          if (vp !== 'mobile') {
            // Desktop/tablet: the panes scroll inside; the page itself is as high as the window.
            expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
          }
        }
        if (acl !== 'ACL-08' && acl !== 'ACL-01') {
          // Choice controls keep their own 16 px size.
          const sizes = await page.locator('main input[type="checkbox"], main input[type="radio"]').evaluateAll((els) => els.slice(0, 6).map((e) => {
            const r = e.getBoundingClientRect();
            return [Math.round(r.width), Math.round(r.height)];
          }));
          for (const [w, h] of sizes) { expect(w).toBe(16); expect(h).toBe(16); }
        }
        if (acl === 'ACL-10') expect(log.puts).toHaveLength(1);
        else if (acl !== 'ACL-09') expect(log.puts).toEqual([]);
        if (shots) await page.screenshot({ path: `${shots}/${acl}--${scheme}--${vp}.png` });
        await context.close();
      }
    }
  });
}

test('mobile: compact server strip with full names, editor below, sticky save bar, 48 px service rows', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: VIEWPORTS.mobile, acl: 'ACL-04', scheme: 'light' });
  await show(page, 'ACL-04');
  const strip = page.locator('.acl-servers__list');
  const a = await page.getByRole('button', { name: /^node-a:/ }).boundingBox();
  const b = await page.getByRole('button', { name: /^node-b:/ }).boundingBox();
  expect(Math.round(a?.y ?? 0)).toBe(Math.round(b?.y ?? 1)); // side by side
  const editor = await page.locator('.acl-editor').boundingBox();
  expect((editor?.y ?? 0)).toBeGreaterThan((a?.y ?? 0) + (a?.height ?? 0) - 1);
  expect(await strip.evaluate((s) => getComputedStyle(s).overflowX)).toBe('auto');
  const row = await page.locator('.acl-service').first().boundingBox();
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(48);
  await page.mouse.wheel(0, 1500);
  await inViewport(page, save(page));
  await noPageOverflow(page);
  await context.close();
});

test('short window 1280×600: the page scrolls by a bounded amount, the save bar sticks in view', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: { width: 1280, height: 600 }, acl: 'ACL-04' });
  await show(page, 'ACL-04');
  await inViewport(page, save(page));
  await page.mouse.wheel(0, 800);
  await inViewport(page, save(page));
  // The 100 services scroll inside their list (bounded), not by the length of the page.
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThan(2000);
  await noPageOverflow(page);
  await context.close();
});

test('keyboard: radios with arrows, Enter in a search never saves, dialogs trap focus and return it, labels toggle', async ({ browser }) => {
  const { context, page, log } = await open(browser, { viewport: VIEWPORTS.compact, acl: 'ACL-04' });
  await show(page, 'ACL-04');
  const selected = page.getByRole('radio', { name: /Вибрані сервіси/ });
  await selected.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('radio', { name: /Усі сервіси/ })).toBeChecked();
  await expect(status(page)).toHaveText('Є незбережені зміни');
  await page.keyboard.press('ArrowDown');
  await expect(selected).toBeChecked();
  await expect(status(page)).toHaveText('Змін немає');
  const search = page.getByLabel('Пошук сервісів цього сервера');
  await page.locator('label.acl-service', { hasText: 'cache-updater' }).click();
  await search.fill('cache');
  await search.press('Enter');
  expect(log.puts).toEqual([]);
  // ACL-14 dialog: focus inside, Escape closes, focus back on the opener.
  const opener = page.getByRole('button', { name: '+ Додати сервер' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Додати сервер' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // Add with the keyboard: the new server is «selected» with nothing chosen, Save stays off and says why.
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Пошук серверів для призначення').fill('node-d');
  await dialog.getByRole('button', { name: 'Додати node-d' }).press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'node-d' })).toBeFocused();
  await expect(save(page)).toBeDisabled();
  await expect(status(page)).toContainText('node-d: виберіть сервіси або приберіть сервер');
  expect(log.puts).toEqual([]);
  await context.close();
});

test('browser Back and closing the tab with a draft ask first', async ({ browser }) => {
  const { context, page, log } = await open(browser, { viewport: VIEWPORTS.desktop, acl: 'ACL-04' });
  await page.goto('/users');
  await page.getByRole('button', { name: 'Дії: operator01@example.invalid' }).click();
  await page.getByRole('menuitem', { name: 'Сервери та сервіси' }).click();
  await expect(page).toHaveURL(new RegExp(`/users/${USER}/access$`));
  await page.getByRole('checkbox', { name: 'auth-service' }).check();
  await page.goBack();
  const dialog = page.getByRole('dialog', { name: 'Скасувати зміни?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Продовжити редагування' }).click();
  await expect(page).toHaveURL(new RegExp(`/users/${USER}/access$`));
  await expect(page.getByRole('checkbox', { name: 'auth-service' })).toBeChecked();
  // Closing the tab: the browser's own confirmation (beforeunload).
  const asked = new Promise<string>((resolve) => { page.once('dialog', (d) => { resolve(d.type()); void d.dismiss(); }); });
  await page.close({ runBeforeUnload: true });
  expect(await asked).toBe('beforeunload');
  expect(log.puts).toEqual([]);
  await context.close();
});

test('a direct URL and a reload work without the users list; an invalid id asks nothing of the API', async ({ browser }) => {
  const { context, page, log } = await open(browser, { viewport: VIEWPORTS.desktop, acl: 'ACL-03' });
  await show(page, 'ACL-03');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'node-a' })).toBeVisible();
  expect(log.reads.some((r) => r.startsWith('GET /api/users?') || r === 'GET /api/users')).toBe(false);
  await page.goto('/users/not-a-uuid/access');
  await expect(page.getByRole('heading', { level: 1, name: 'Користувача не знайдено' })).toBeVisible();
  expect(log.reads.some((r) => r.includes('not-a-uuid'))).toBe(false);
  await context.close();
});
