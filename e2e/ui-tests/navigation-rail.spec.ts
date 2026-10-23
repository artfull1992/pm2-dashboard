import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';

// Compact navigation rail (601–1279 px, design reference 1.0 APP-15) in short windows (review 71b9f84): every link,
// the account link and «Вийти» must be reachable by mouse, keyboard and touch whatever the height — the rail scrolls
// on its own, the page does not have to. Tooltips are an overlay outside the scroll container: never clipped, inside
// the viewport, next to (not over) their control, and never the only name. Synthetic API only; logout is answered by
// the synthetic API. Screenshots only with NC_UI_SHOTS.

const shots = process.env.NC_UI_SHOTS;
const ROLES = {
  admin: { permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
    links: ['Огляд', 'Сервери', 'Застосунки', 'Сповіщення', 'Користувачі', 'Журнал аудиту', 'Налаштування'], bottom: 'Налаштування', bottomPath: '/settings' },
  operator: { permissions: ['monitoring:read', 'processes:control', 'logs:read'],
    links: ['Огляд', 'Сервери', 'Застосунки', 'Сповіщення'], bottom: 'Сповіщення', bottomPath: '/alerts' },
} as const;
type Role = keyof typeof ROLES;

async function api(page: Page, role: Role) {
  const state = { loggedOut: false };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/auth/logout' && req.method() === 'POST') { state.loggedOut = true; await route.fulfill({ status: 204 }); return; }
    if (path === '/api/auth/me') {
      if (state.loggedOut) { await route.fulfill({ status: 401, json: {} }); return; }
      await route.fulfill({ json: { user: { id: '00000000-0000-4000-8000-000000000001', email: `${role}@example.com`, role }, csrfToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: ROLES[role].permissions } });
      return;
    }
    if (path === '/api/applications') { await route.fulfill({ json: { items: [], nextCursor: null, freshWindowSeconds: 180 } }); return; }
    if (path === '/api/servers') { await route.fulfill({ json: { items: [], nextAfterId: null, onlineWindowSeconds: 90 } }); return; }
    await route.fulfill({ status: 404, json: {} });
  });
  return state;
}

/** The element's box lies completely inside the viewport (toBeVisible alone would accept an element below it). */
async function fullyInViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  expect(box, 'element has a box').not.toBeNull();
  if (!box || !vp) return;
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
}

/** The visible tooltip: inside the viewport, beside its control (no overlap), showing the control's name. */
async function expectTooltip(page: Page, control: Locator, name: string) {
  const tip = page.locator('.rail-tip');
  await expect(tip).toHaveText(name);
  await fullyInViewport(page, tip);
  const [t, c] = await Promise.all([tip.boundingBox(), control.boundingBox()]);
  if (!t || !c) throw new Error('missing boxes');
  const overlap = t.x < c.x + c.width && c.x < t.x + t.width && t.y < c.y + c.height && c.y < t.y + t.height;
  expect(overlap, 'tooltip does not cover its control').toBe(false);
  // Never the only name: the control has its own accessible name.
  await expect(control).toHaveAccessibleName(name);
}

async function open(browser: Browser, viewport: { width: number; height: number }, touch: boolean, scheme: 'light' | 'dark', role: Role) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: false, colorScheme: scheme, locale: 'uk-UA', baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  const state = await api(page, role);
  await page.goto('/applications');
  await expect(page.getByRole('heading', { level: 1, name: 'Застосунки' })).toBeVisible();
  return { context, page, state };
}

const VIEWPORTS = [{ width: 720, height: 450 }, { width: 1024, height: 450 }, { width: 1024, height: 768 }];

for (const viewport of VIEWPORTS) {
  for (const role of ['admin', 'operator'] as const) {
    for (const touch of [false, true]) {
      for (const scheme of ['light', 'dark'] as const) {
        const tag = `${String(viewport.width)}×${String(viewport.height)} ${role} ${touch ? 'touch' : 'fine'} ${scheme}`;
        test(`rail ${tag}: every link, the account and «Вийти» reachable; tooltips visible and unclipped`, async ({ browser }) => {
          const { context, page, state } = await open(browser, viewport, touch, scheme, role);
          try {
            const r = ROLES[role];
            const nav = page.getByRole('navigation', { name: 'Основна навігація' });
            const sidebar = page.locator('.sidebar');
            expect((await sidebar.boundingBox())?.width).toBe(68);
            await expect(nav.getByRole('link')).toHaveCount(r.links.length);
            const logout = page.getByRole('button', { name: 'Вийти' });
            const account = page.getByRole('link', { name: 'Обліковий запис' });
            if (shots) await page.screenshot({ path: `${shots}/rail-${tag.replace(/[ ×]/g, '-')}-top.png` });

            const first = nav.getByRole('link', { name: r.links[0] });
            // 2. Scroll the navigation container itself to its end: the bottom controls are really in the viewport.
            await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            await fullyInViewport(page, logout);
            await fullyInViewport(page, account);
            await fullyInViewport(page, nav.getByRole('link', { name: r.bottom }));
            for (const control of [logout, account, nav.getByRole('link', { name: r.bottom })]) {
              expect((await control.boundingBox())?.height ?? 0, 'touch target').toBeGreaterThanOrEqual(44);
            }
            // The hit test at the centre of «Вийти» reaches the button (nothing covers it).
            const lb = await logout.boundingBox();
            if (!lb) throw new Error('no logout box');
            expect(await page.evaluate(([x, y]) => document.elementFromPoint(x ?? 0, y ?? 0)?.closest('button')?.textContent, [lb.x + lb.width / 2, lb.y + lb.height / 2])).toBe('Вийти');
            // 3. Tooltips: the first link before scrolling, «Вийти» after scrolling (hover; keyboard focus below).
            await sidebar.evaluate((el) => { el.scrollTop = 0; });
            await first.hover();
            await expectTooltip(page, first, r.links[0]);
            await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            await logout.hover();
            await expectTooltip(page, logout, 'Вийти');
            if (shots) await page.screenshot({ path: `${shots}/rail-${tag.replace(/[ ×]/g, '-')}-bottom.png` });

            // 4. Keyboard: from the top, Tab reaches every control; each focused one is inside the viewport and shows
            //    its tooltip.
            // (The pointer moves off the rail first: a pointer resting over another rail control would legitimately
            //  show that control's tooltip instead.)
            await page.mouse.move(viewport.width - 20, viewport.height - 20);
            await sidebar.evaluate((el) => { el.scrollTop = 0; });
            await first.focus();
            const order = [...r.links.slice(1), 'Обліковий запис', 'Вийти'];
            for (const name of order) {
              await page.keyboard.press('Tab');
              const focused = page.locator(':focus');
              await expect(focused).toHaveAccessibleName(name);
              await fullyInViewport(page, focused);
              expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
              await expectTooltip(page, focused, name);
            }

            // 5. Activate a bottom link (tap on touch, click otherwise) after scrolling the rail.
            await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            const bottomLink = nav.getByRole('link', { name: r.bottom });
            await (touch ? bottomLink.tap() : bottomLink.click());
            await expect(page).toHaveURL(new RegExp(`${r.bottomPath}$`));
            // The page itself never scrolls sideways.
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

            // 6. Logout (synthetic API only).
            await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
            await (touch ? logout.tap() : logout.click());
            await expect(page.getByRole('button', { name: 'Увійти' })).toBeVisible();
            expect(state.loggedOut).toBe(true);
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}

test('tooltip overlay: removed when the pointer leaves, on blur and when its control scrolls out of the rail; follows a control still in view; inside the viewport near the bottom edge', async ({ browser }) => {
  const { context, page } = await open(browser, { width: 720, height: 450 }, false, 'dark', 'admin');
  try {
    const sidebar = page.locator('.sidebar');
    const link = page.getByRole('link', { name: 'Огляд' });
    await link.hover();
    await expect(page.locator('.rail-tip')).toHaveCount(1);
    await page.mouse.move(500, 300);
    await expect(page.locator('.rail-tip')).toHaveCount(0);
    await page.keyboard.press('Tab'); // keyboard focus (from the rail's previous control) shows the tooltip
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('.rail-tip')).toHaveText('Огляд');
    // A small scroll keeps the control in view: the tooltip follows it (stays beside it).
    await sidebar.evaluate((el) => { el.scrollTop = 4; });
    await expectTooltip(page, link, 'Огляд');
    // The control scrolls out of the rail: the tooltip goes away.
    await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.rail-tip')).toHaveCount(0);
    await page.locator('h1').click();
    await expect(page.locator('.rail-tip')).toHaveCount(0); // blur
    // Near the bottom edge the tooltip stays inside the viewport.
    await sidebar.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const logout = page.getByRole('button', { name: 'Вийти' });
    await logout.hover();
    await fullyInViewport(page, page.locator('.rail-tip'));
  } finally {
    await context.close();
  }
});

test('outside the rail range there are no rail tooltips: desktop column and phone menu unchanged', async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 450 }, { width: 390, height: 600 }]) {
    const { context, page } = await open(browser, viewport, false, 'light', 'admin');
    try {
      if (viewport.width >= 1280) {
        expect((await page.locator('.sidebar').boundingBox())?.width).toBe(184);
        const settings = page.getByRole('link', { name: 'Налаштування' });
        await settings.hover();
        await expect(page.locator('.rail-tip')).toHaveCount(0);
        // The desktop column scrolls too: «Вийти» can be brought into view in a short window.
        await page.locator('.sidebar').evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await fullyInViewport(page, page.getByRole('button', { name: 'Вийти' }));
      } else {
        const toggle = page.getByRole('button', { name: 'Меню' });
        await toggle.click();
        await expect(page.getByRole('navigation', { name: 'Основна навігація' }).getByRole('link')).toHaveCount(7);
        await page.keyboard.press('Escape');
        await expect(toggle).toBeFocused();
      }
    } finally {
      await context.close();
    }
  }
});
