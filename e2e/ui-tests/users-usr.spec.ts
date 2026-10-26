import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';

// Users redesign (USR-01…09, docs/design/part-02) in a real browser with synthetic API data only (nothing is
// changed: mutations are answered by the fixture, never sent anywhere). Screenshots (NC_UI_SHOTS) are named like the
// references, USR-0x--<theme>--<viewport>.png. Checks: no page overflow in both themes at 1440×900 / 1366×768 /
// 1024×768 / 390×844; the row menu is an overlay (row height unchanged, inside the viewport, not clipped); drawers
// 540 / 520 / full screen with the buttons in view; keyboard (menu arrows, Escape, focus return, focus trap); long
// e-mails on one line with the full address on focus; a short window; a coarse pointer; one list request per page.

const shots = process.env.NC_UI_SHOTS;
const NOW = new Date('2026-10-26T08:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = 'observer-with-a-long-synthetic-identifier-for-layout@example.com';
const users = [
  { id: id(0), email: 'admin@example.com', role: 'admin', isActive: true },
  { id: id(1), email: 'operator01@example.com', role: 'operator', isActive: true },
  { id: id(2), email: LONG, role: 'viewer', isActive: true },
  { id: id(3), email: 'operator02@example.com', role: 'operator', isActive: false },
].map((u) => ({ ...u, createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z' }));
type State = 'list' | 'loading' | 'error' | 'many';

async function api(page: Page, state: State, onPost: () => Promise<void> = () => Promise.resolve()) {
  const reads: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    reads.push(`${req.method()} ${url.pathname}`);
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: id(0), email: 'admin@example.com', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] } });
      return;
    }
    if (url.pathname === '/api/users' && req.method() === 'GET') {
      if (state === 'loading') return;
      if (state === 'error') { await route.fulfill({ status: 503, json: {} }); return; }
      if (state === 'many') {
        const after = url.searchParams.get('after');
        const all = Array.from({ length: 150 }, (_, n) => ({ ...users[1], id: id(10 + n), email: `user${String(n).padStart(3, '0')}@example.com` }));
        const start = after === null ? 0 : all.findIndex((u) => u.id === after) + 1;
        const items = all.slice(start, start + 100);
        await route.fulfill({ json: { items, nextAfter: start + 100 < all.length ? items.at(-1)?.id ?? null : null } });
        return;
      }
      await route.fulfill({ json: { items: users, nextAfter: null } });
      return;
    }
    if (url.pathname === '/api/users' && req.method() === 'POST') { await onPost(); await route.fulfill({ status: 409, json: {} }); return; }
    if (url.pathname.startsWith('/api/users/') && url.pathname.endsWith('/access')) {
      await route.fulfill({ json: { userId: id(1), email: 'operator01@example.com', role: 'operator', isActive: true, global: false, revision: 1, servers: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  return reads;
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, compact: { width: 1366, height: 768 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } } as const;
type Viewport = keyof typeof VIEWPORTS;

async function open(browser: Browser, o: { scheme?: 'light' | 'dark'; viewport: { width: number; height: number }; state?: State; touch?: boolean; onPost?: () => Promise<void> }) {
  const context = await browser.newContext({ viewport: o.viewport, colorScheme: o.scheme ?? 'dark', locale: 'uk-UA', timezoneId: 'Europe/Kyiv', hasTouch: o.touch ?? false, isMobile: false, baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const reads = await api(page, o.state ?? 'list', o.onPost);
  return { context, page, reads };
}
const noPageOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
const box = async (l: Locator) => { const b = await l.boundingBox(); expect(b).not.toBeNull(); return b ?? { x: 0, y: 0, width: 0, height: 0 }; };
const inViewport = async (page: Page, l: Locator) => {
  const b = await box(l);
  const v = page.viewportSize() ?? { width: 0, height: 0 };
  expect(b.x).toBeGreaterThanOrEqual(-0.5);
  expect(b.y).toBeGreaterThanOrEqual(-0.5);
  expect(b.x + b.width).toBeLessThanOrEqual(v.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(v.height + 0.5);
};
const menuOf = (page: Page, email: string) => page.getByRole('button', { name: `Дії: ${email}` });

async function show(page: Page, usr: string) {
  await page.goto('/users');
  await expect(page.getByRole('heading', { level: 1, name: 'Користувачі' })).toBeVisible();
  if (usr === 'USR-09') { await expect(page.getByText('Завантаження…')).toBeVisible(); return; }
  await expect(page.locator('.users__email', { hasText: 'admin@example.com' })).toBeVisible();
  if (usr === 'USR-04') { await menuOf(page, 'operator01@example.com').click(); await expect(page.getByRole('menu')).toBeVisible(); return; }
  if (usr === 'USR-02' || usr === 'USR-05' || usr === 'USR-06' || usr === 'USR-07') {
    await page.getByRole('button', { name: 'Створити користувача' }).click();
    const form = page.getByRole('form', { name: 'Створення користувача' });
    await form.getByLabel('Роль', { exact: true }).selectOption('operator');
    if (usr === 'USR-05') { await form.getByLabel('Email').fill('not-an-email'); await form.getByRole('button', { name: 'Створити', exact: true }).click(); await expect(form.getByText('Введіть коректний email.')).toBeVisible(); }
    if (usr === 'USR-06' || usr === 'USR-07') {
      await form.getByLabel('Email').fill('new-user@example.com');
      await form.getByLabel('Початковий пароль').fill('synthetic-Passw0rd-Not-Real');
      await form.getByRole('button', { name: 'Створити', exact: true }).click();
      if (usr === 'USR-06') await expect(form.getByRole('button', { name: 'Створення…' })).toBeDisabled();
      else await expect(form.getByText('Не вдалося створити користувача')).toBeVisible();
    }
    return;
  }
  if (usr === 'USR-03') {
    await menuOf(page, 'operator01@example.com').click();
    await page.getByRole('menuitem', { name: 'Роль і активність' }).click();
    await page.getByRole('form', { name: 'Роль і активність' }).getByLabel('Активний користувач').uncheck();
    return;
  }
  if (usr === 'USR-08') {
    await menuOf(page, 'admin@example.com').click();
    await page.getByRole('menuitem', { name: 'Роль і активність' }).click();
    await expect(page.getByRole('dialog', { name: 'Ваш обліковий запис' })).toBeVisible();
  }
}

const STATES: { usr: string; state: State; on: Viewport[] }[] = [
  { usr: 'USR-01', state: 'list', on: ['desktop', 'compact', 'tablet', 'mobile'] },
  { usr: 'USR-02', state: 'list', on: ['desktop', 'compact', 'tablet', 'mobile'] },
  { usr: 'USR-03', state: 'list', on: ['desktop', 'mobile'] },
  { usr: 'USR-04', state: 'list', on: ['desktop', 'mobile'] },
  { usr: 'USR-05', state: 'list', on: ['desktop', 'mobile'] },
  { usr: 'USR-06', state: 'list', on: ['desktop', 'mobile'] },
  { usr: 'USR-07', state: 'list', on: ['desktop', 'mobile'] },
  { usr: 'USR-08', state: 'list', on: ['desktop', 'mobile'] },
  { usr: 'USR-09', state: 'loading', on: ['desktop', 'mobile'] },
];

for (const scheme of ['dark', 'light'] as const) {
  for (const s of STATES) {
    test(`${s.usr} ${scheme}: ${s.on.join(', ')} — no page overflow${shots ? ', screenshots' : ''}`, async ({ browser }) => {
      for (const v of s.on) {
        let release: () => void = () => undefined;
        const held = new Promise<void>((r) => { release = r; });
        const { context, page } = await open(browser, { scheme, viewport: VIEWPORTS[v], state: s.state, ...(s.usr === 'USR-06' ? { onPost: () => held } : {}) });
        await show(page, s.usr);
        await noPageOverflow(page);
        const dialog = page.getByRole('dialog');
        if (await dialog.count() > 0) {
          const b = await box(dialog);
          expect(Math.round(b.width), `${s.usr} ${v}: drawer width`).toBe(v === 'mobile' ? VIEWPORTS[v].width : v === 'tablet' ? 520 : 540);
          await inViewport(page, dialog.getByRole('button', { name: /^(Створити|Зберегти|Закрити)$/ }).last());
        }
        if (shots) await page.screenshot({ path: `${shots}/${s.usr}--${scheme}--${v}.png` });
        release();
        await context.close();
      }
    });
  }
}

test('USR-04: the menu is an overlay — row height unchanged, inside the viewport, not clipped; arrows, Escape, focus return (1440 and 390)', async ({ browser }) => {
  for (const v of ['desktop', 'mobile'] as const) {
    const { context, page } = await open(browser, { viewport: VIEWPORTS[v] });
    await show(page, 'USR-01');
    const trigger = menuOf(page, LONG);
    const holder = v === 'desktop' ? page.locator('tbody tr').filter({ has: trigger }) : page.getByRole('article', { name: LONG });
    const before = (await box(holder)).height;
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(page.getByRole('menuitem', { name: 'Роль і активність' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Сервери та сервіси' })).toBeFocused();
    expect((await box(holder)).height).toBe(before);
    await inViewport(page, menu);
    // Not clipped by the scrolling list: the menu's middle point is the menu itself.
    const m = await box(menu);
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menu"]') !== null, { x: m.x + m.width / 2, y: m.y + m.height / 2 })).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await context.close();
  }
});

test('drawers by keyboard: focus on ✕, Tab stays inside, background inert; Escape returns focus to the menu trigger; nothing sent', async ({ browser }) => {
  const { context, page, reads } = await open(browser, { viewport: VIEWPORTS.desktop });
  await show(page, 'USR-01');
  const trigger = menuOf(page, 'operator01@example.com');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // «Роль і активність»
  const dialog = page.getByRole('dialog', { name: 'Роль і активність' });
  await expect(dialog.getByRole('button', { name: 'Закрити' })).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await expect(dialog.getByRole('button', { name: 'Зберегти' })).toBeDisabled(); // nothing changed yet
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(reads.filter((r) => !r.startsWith('GET'))).toEqual([]);
  await context.close();
});

test('long e-mails: one line with an ellipsis; keyboard focus shows the whole address; no horizontal scroll (1024)', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: VIEWPORTS.tablet });
  await show(page, 'USR-01');
  const cell = page.locator('.users__email', { hasText: LONG });
  const line = (await box(cell)).height;
  expect(await cell.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await cell.focus();
  expect((await box(cell)).height).toBeGreaterThan(line); // wraps to show everything while focused
  expect(await page.locator('.users__scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await noPageOverflow(page);
  await context.close();
});

test('a short window (1280×600) and 150 users: the list scrolls inside its card, the pager stays reachable; one request per page', async ({ browser }) => {
  const { context, page, reads } = await open(browser, { viewport: { width: 1280, height: 600 }, state: 'many' });
  await page.goto('/users');
  await expect(page.locator('.users__email').first()).toBeVisible();
  const list = page.locator('.users__scroll');
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.locator('.users-card').evaluate((el) => { el.scrollIntoView({ block: 'end' }); });
  const next = page.getByRole('navigation', { name: 'Сторінки користувачів' }).getByRole('button', { name: 'Далі' });
  await inViewport(page, next);
  await next.click();
  await expect(page.getByText('Сторінка 2')).toBeVisible();
  expect(reads.filter((r) => r === 'GET /api/users')).toHaveLength(2);
  expect(reads.some((r) => r.includes('/access'))).toBe(false);
  if (shots) await page.screenshot({ path: `${shots}/users-short-1280x600.png` });
  await context.close();
});

test('coarse pointer at 1440: menu triggers, menu items, drawer controls and pager buttons are at least 44 px', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: VIEWPORTS.desktop, touch: true });
  await show(page, 'USR-01');
  const heights = (sel: string) => page.locator(sel).evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => Math.round(el.getBoundingClientRect().height)));
  for (const sel of ['.action-menu__trigger', '.users__filters input', '.users__filters select', '.incidents__pager .button']) for (const h of await heights(sel)) expect(h, sel).toBeGreaterThanOrEqual(44);
  await menuOf(page, 'operator01@example.com').click();
  for (const h of await heights('[role="menuitem"]')) expect(h).toBeGreaterThanOrEqual(44);
  await page.getByRole('menuitem', { name: 'Роль і активність' }).click();
  for (const h of await heights('[role="dialog"] .button, [role="dialog"] select')) expect(h).toBeGreaterThanOrEqual(44);
  await context.close();
});
