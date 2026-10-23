import { type BrowserContext, expect, type Page, test } from '@playwright/test';

// Theme preference in a real browser (synthetic API; nothing is sent): the saved choice is applied before the first
// paint (before React, with the bundle held back), under a strict CSP `default-src 'self'` with no violations; an
// explicit choice beats the OS setting, «Як у системі» follows it live; tabs stay in sync; the dark tokens of the
// explicit and the system dark theme are identical; the switcher is reachable for every role in the sidebar, the
// compact rail, the mobile menu and on the login page. Screenshots only with NC_UI_SHOTS.

const shots = process.env.NC_UI_SHOTS;
const LIGHT_BG = 'rgb(244, 246, 248)';
const DARK_BG = 'rgb(20, 27, 36)';
type Role = 'admin' | 'viewer' | null;

async function api(page: Page, role: Role) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      if (!role) { await route.fulfill({ status: 401, json: {} }); return; }
      await route.fulfill({ json: { user: { id: '00000000-0000-4000-8000-000000000001', email: `${role}@example.com`, role }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: role === 'admin' ? ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] : ['monitoring:read'] } });
      return;
    }
    if (path === '/api/applications') { await route.fulfill({ json: { items: [], nextCursor: null, freshWindowSeconds: 180 } }); return; }
    if (path === '/api/servers') { await route.fulfill({ json: { items: [], nextAfterId: null, onlineWindowSeconds: 90 } }); return; }
    await route.fulfill({ status: 503, json: {} });
  });
}

/** Serves the documents with the strict CSP the production site is meant to send, and records any violation. */
async function strictCsp(page: Page) {
  const violations: string[] = [];
  await page.exposeFunction('__cspViolation', (v: string) => { violations.push(v); });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => { void (window as unknown as { __cspViolation: (v: string) => Promise<void> }).__cspViolation(`${e.violatedDirective} ${e.blockedURI}`); });
  });
  await page.route((url) => !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/assets/') && !url.pathname.endsWith('.js'), async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "default-src 'self'" } });
  });
  return violations;
}

/** The element's box lies inside the viewport (geometry, ±0.5 px for sub-pixel layout). */
async function fullyInViewport(page: Page, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  expect(box).not.toBeNull();
  if (!box || !vp) return;
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
}

const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const scheme = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
const store = (context: BrowserContext, value: string | null) => context.addInitScript((v) => {
  try { if (v === null) localStorage.removeItem('nc-theme'); else localStorage.setItem('nc-theme', v); } catch { /* ignore */ }
}, value);

test('the saved dark theme is applied before React (bundle held back), under CSP default-src \'self\' without violations', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await store(context, 'dark');
  const violations = await strictCsp(page);
  await api(page, 'admin');
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/assets/*.js', async (route) => { await held; await route.continue(); });
  await page.goto('/applications', { waitUntil: 'commit' });
  // React has not run yet (#root empty), yet the page is already dark.
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  expect(await page.evaluate(() => document.getElementById('root')?.childElementCount ?? -1)).toBe(0);
  expect(await bg(page)).toBe(DARK_BG);
  expect(await scheme(page)).toBe('dark');
  release();
  await expect(page.getByRole('heading', { level: 1, name: 'Застосунки' })).toBeVisible();
  expect(await bg(page)).toBe(DARK_BG);
  expect(violations).toEqual([]);
  await context.close();
});

test('explicit choice beats the OS; «Як у системі» follows live OS changes; color-scheme matches; dark tokens are one set', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await api(page, 'viewer');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Тема оформлення: / })).toBeVisible();
  // System (default) + OS dark → dark; OS light → light, without reload.
  expect(await bg(page)).toBe(DARK_BG);
  expect(await scheme(page)).toBe('dark');
  const systemDark = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return ['--bg', '--surface', '--text', '--text-muted', '--control-border', '--primary', '--warning', '--danger', '--success', '--selected-bg', '--surface-sunken', '--field-bg', '--log-bg'].map((t) => cs.getPropertyValue(t).trim()); });
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bg(page)).toBe(LIGHT_BG);
  expect(await scheme(page)).toBe('light');
  // Explicit dark while the OS is light: dark, and the same tokens as the system dark theme.
  await page.getByRole('button', { name: /^Тема оформлення: / }).click();
  await page.getByRole('menuitemradio', { name: 'Темна' }).click();
  expect(await bg(page)).toBe(DARK_BG);
  expect(await scheme(page)).toBe('dark');
  const explicitDark = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return ['--bg', '--surface', '--text', '--text-muted', '--control-border', '--primary', '--warning', '--danger', '--success', '--selected-bg', '--surface-sunken', '--field-bg', '--log-bg'].map((t) => cs.getPropertyValue(t).trim()); });
  expect(explicitDark).toEqual(systemDark);
  // OS changes do not override an explicit choice.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bg(page)).toBe(DARK_BG);
  // Explicit light while the OS is dark.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: /^Тема оформлення: / }).click();
  await page.getByRole('menuitemradio', { name: 'Світла' }).click();
  expect(await bg(page)).toBe(LIGHT_BG);
  expect(await scheme(page)).toBe('light');
  // Reload keeps it.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Тема оформлення: Світла' })).toBeVisible();
  expect(await bg(page)).toBe(LIGHT_BG);
  await context.close();
});

test('two tabs stay in sync through the storage event', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const a = await context.newPage();
  const b = await context.newPage();
  await api(a, 'viewer');
  await api(b, 'viewer');
  await a.goto('/');
  await b.goto('/');
  await b.getByRole('button', { name: /^Тема оформлення: / }).click();
  await b.getByRole('menuitemradio', { name: 'Темна' }).click();
  await expect.poll(() => bg(a)).toBe(DARK_BG);
  await expect(a.getByRole('button', { name: 'Тема оформлення: Темна' })).toBeVisible();
  await context.close();
});

const LAYOUTS = [
  { name: 'sidebar 1440', viewport: { width: 1440, height: 900 }, role: 'admin' as Role, path: '/' },
  { name: 'rail 1024×768', viewport: { width: 1024, height: 768 }, role: 'admin' as Role, path: '/applications' },
  { name: 'rail 720×450 (short)', viewport: { width: 720, height: 450 }, role: 'admin' as Role, path: '/applications' },
  { name: 'mobile 390', viewport: { width: 390, height: 844 }, role: 'viewer' as Role, path: '/' },
  { name: 'login 390', viewport: { width: 390, height: 844 }, role: null, path: '/login' },
  { name: 'login 1440', viewport: { width: 1440, height: 900 }, role: null, path: '/login' },
];

for (const l of LAYOUTS) {
  test(`switcher reachable and usable by keyboard: ${l.name}`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light', viewport: l.viewport });
    const page = await context.newPage();
    await api(page, l.role);
    await page.goto(l.path);
    if (l.name.startsWith('mobile')) await page.getByRole('button', { name: 'Меню' }).click();
    if (l.name.startsWith('rail')) await page.locator('.sidebar').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const trigger = page.getByRole('button', { name: /^Тема оформлення: / });
    await expect(trigger).toBeVisible();
    await fullyInViewport(page, trigger);
    expect((await trigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(l.viewport.width <= 760 ? 44 : 32);
    if (l.name.startsWith('rail')) {
      await trigger.hover();
      await expect(page.locator('.rail-tip')).toHaveText('Тема оформлення: Як у системі');
    }
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Тема оформлення' });
    await expect(menu).toBeVisible();
    await fullyInViewport(page, page.locator('.action-menu__popup'));
    await page.keyboard.press('ArrowDown'); // «Темна»
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    await expect(trigger).toBeFocused();
    expect(await bg(page)).toBe(DARK_BG);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/theme-${l.name.replace(/[ ×()]/g, '-')}.png` });
    // Escape closes the menu without a change.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    await context.close();
  });
}
