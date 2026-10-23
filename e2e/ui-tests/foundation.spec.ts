import { expect, type Page, test } from '@playwright/test';

// Redesign stage 1 (2026-10-22): design tokens and shared primitives, real browser, synthetic API data only (no DB,
// credentials, PM2 or Slack). Checks what the stage promises: WCAG contrast of the actual tokens in both themes,
// navigation width, type scale, no page overflow at the required widths and at 200 % zoom (720 CSS px), keyboard
// operation (Tab/Shift+Tab, Enter/Space, Escape, focus return) and a visible focus ring. Screenshots only with
// NC_UI_SHOTS (synthetic names).

const shots = process.env.NC_UI_SHOTS;
const ME = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OP = 'aaaaaaaa-0000-4000-8000-000000000001';
const SRV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const old = '2026-10-14T08:00:00.000Z';

async function api(page: Page) {
  const mutations: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const now = new Date(Date.now() - 20_000).toISOString();
    if (req.method() !== 'GET') { mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    let data: unknown;
    if (path === '/api/auth/me') {
      data = { user: { id: ME, email: 'admin@example.com', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] };
    } else if (path === '/api/dashboard') {
      data = {
        generatedAt: now, windows: { onlineSeconds: 90, inventoryFreshSeconds: 180 },
        servers: { total: 1, inactive: 0, active: 1, online: 1, offline: 0, neverConnected: 0 }, inventory: { current: 1, stale: 0, unavailable: 0, notReported: 0 },
        processes: { live: { total: 3, online: 2, problem: 1, transitional: 0 }, notLive: 0 },
        attentionServers: { items: [], total: 0, limit: 20 },
        attentionProcesses: { items: [{ serverId: SRV, serverName: 'app-server', pmId: 2, name: 'reports-worker', status: 'errored', restarts: 4, uptimeSeconds: null }], total: 1, limit: 20 },
        serverList: { items: [{ id: SRV, name: 'app-server', status: 'online', lastSeenAt: now, metrics: { hostname: 'app-server', loadAverage: [0.4, 0.3, 0.2] }, inventory: { state: 'current', collectedAt: now }, processes: { total: 3, online: 2, problem: 1 } }], total: 1, limit: 50 },
        recentActions: { limit: 10, items: [] },
      };
    } else if (path === '/api/users') {
      data = { items: [
        { id: ME, email: 'admin@example.com', role: 'admin', isActive: true, createdAt: old, updatedAt: old },
        { id: OP, email: 'operator@example.com', role: 'operator', isActive: true, createdAt: old, updatedAt: old },
      ], nextAfter: null };
    } else if (path === `/api/users/${OP}/access`) {
      data = { userId: OP, email: 'operator@example.com', role: 'operator', isActive: true, global: false, revision: 1, servers: [
        { serverId: SRV, serverName: 'app-server', serverActive: true, mode: 'selected', grantedAt: old, services: [{ name: 'catalog-api', available: true }] },
      ] };
    } else if (path === '/api/access/servers') data = { items: [{ id: SRV, name: 'app-server', isActive: true }], nextAfterName: null };
    else if (path === `/api/access/servers/${SRV}/services`) data = { serverId: SRV, items: [{ name: 'catalog-api', processes: 1 }, { name: 'billing-api', processes: 1 }], truncated: false };
    else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return mutations;
}

/** WCAG contrast of the page's own tokens (computed in the browser from the active theme). */
const contrastReport = (page: Page) => page.evaluate(() => {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const probe = document.createElement('span');
  document.body.append(probe);
  const rgb = (color: string): [number, number, number, number] => {
    probe.style.color = color;
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).color);
    const p = (m?.[1] ?? '0,0,0').split(',').map((x) => Number(x.trim()));
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const over = (fg: string, bg: string): [number, number, number] => {
    const [r, g, b, a] = rgb(fg);
    const [R, G, B] = rgb(bg);
    return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  };
  const lum = ([r, g, b]: [number, number, number]) => {
    const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg: string, bg: string, base?: string) => {
    const back: [number, number, number] = base ? over(bg, base) : over(bg, 'rgb(255,255,255)');
    const front = over(fg, `rgb(${back.join(',')})`);
    const [x, y] = [lum(front), lum(back)].sort((a, b) => b - a) as [number, number];
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  };
  const failures: string[] = [];
  const need = (label: string, value: number, min: number) => { if (value < min) failures.push(`${label}=${String(value)} (<${String(min)})`); };
  for (const bg of ['--nav', '--bg', '--surface', '--surface-2', '--elevated']) {
    for (const fg of ['--text', '--text-muted', '--primary', '--success', '--warning', '--danger']) need(`${fg} on ${bg}`, ratio(v(fg), v(bg)), 4.5);
    need(`--control-border on ${bg}`, ratio(v('--control-border'), v(bg)), 3);
    need(`--focus on ${bg}`, ratio(v('--focus'), v(bg)), 3);
  }
  for (const [fg, soft] of [['--warning', '--warning-soft'], ['--danger', '--danger-soft'], ['--success', '--success-soft'], ['--primary', '--primary-soft']] as const) {
    need(`${fg} on ${soft}`, ratio(v(fg), v(soft), v('--surface')), 4.5);
  }
  need('--primary-text on --primary', ratio(v('--primary-text'), v('--primary')), 4.5);
  need('--log-text on --log-bg', ratio(v('--log-text'), v('--log-bg')), 4.5);
  probe.remove();
  return failures;
});

const noPageOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };

for (const theme of ['dark', 'light'] as const) {
  test.describe(theme, () => {
    test.use({ colorScheme: theme });

    test('tokens: text ≥ 4.5:1, control borders and focus ≥ 3:1 on every surface', async ({ page }) => {
      await api(page);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Огляд' })).toBeVisible();
      expect(await contrastReport(page)).toEqual([]);
      // The check is not vacuous: a low-contrast muted text token is reported.
      await page.addStyleTag({ content: ':root { --text-muted: #777f8a !important; }' });
      expect((await contrastReport(page)).some((f) => f.startsWith('--text-muted on'))).toBe(true);
      // The theme follows the OS setting (no forced theme): the page background is the theme's own.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe(theme === 'dark' ? 'rgb(20, 27, 36)' : 'rgb(244, 246, 248)');
    });

    for (const width of [1440, 1366, 1024, 720, 390] as const) {
      test(`layout at ${String(width)} px: navigation, type scale, no page overflow`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await api(page);
        await page.goto('/');
        const h1 = page.getByRole('heading', { level: 1, name: 'Огляд' });
        await expect(h1).toBeVisible();
        expect(await h1.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).lineHeight])).toEqual(['26px', '32px']);
        expect(await page.evaluate(() => [getComputedStyle(document.body).fontSize, getComputedStyle(document.body).lineHeight])).toEqual(['14px', '20px']);
        const navLinks = page.getByRole('navigation', { name: 'Основна навігація' }).getByRole('link');
        if (width >= 1280) {
          const nav = await page.locator('.sidebar').boundingBox();
          expect(nav?.width ?? 0).toBeGreaterThanOrEqual(184);
          expect(nav?.width ?? 999).toBeLessThanOrEqual(208);
          // Every route of the navigation is reachable (admin sees all seven).
          await expect(navLinks).toHaveCount(7);
        } else if (width > 600) {
          // Design reference 1.0 (APP-15): a 68 px icon rail. Every link keeps its text as the accessible name, is at
          // least 44 px tall and shows its label as a tooltip on keyboard focus (never an unnamed icon).
          expect((await page.locator('.sidebar').boundingBox())?.width).toBe(68);
          await expect(navLinks).toHaveCount(7);
          for (const name of ['Огляд', 'Сервери', 'Застосунки', 'Сповіщення', 'Користувачі', 'Журнал аудиту', 'Налаштування']) {
            const link = navLinks.filter({ hasText: name });
            await expect(link).toHaveAccessibleName(name);
            expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
          }
          await navLinks.first().focus();
          await page.keyboard.press('Tab');
          // The tooltip is an overlay outside the rail's scroll (review 71b9f84): see navigation-rail.spec.ts.
          await expect(page.locator('.rail-tip')).toHaveText('Сервери');
          await expect(page.getByRole('button', { name: 'Вийти' })).toBeVisible();
          await expect(page.getByRole('link', { name: 'Обліковий запис' })).toBeVisible();
        } else {
          const toggle = page.getByRole('button', { name: 'Меню' });
          expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target
          await toggle.click();
          await expect(page.getByRole('navigation', { name: 'Основна навігація' }).getByRole('link')).toHaveCount(7);
          await page.keyboard.press('Escape');
          await expect(toggle).toBeFocused();
        }
        await noPageOverflow(page);
        if (shots) await page.screenshot({ path: `${shots}/foundation-overview-${theme}-${String(width)}.png`, fullPage: true });
      });
    }

    test('login uses the same tokens: fields one control height, no overflow at 390 and 1440', async ({ page }) => {
      await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: {} }));
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/');
        const email = page.getByLabel('Email');
        await expect(email).toBeVisible();
        expect(Math.round((await email.boundingBox())?.height ?? 0)).toBe(width < 761 ? 44 : 36);
        await noPageOverflow(page);
        if (shots) await page.screenshot({ path: `${shots}/foundation-login-${theme}-${String(width)}.png` });
      }
    });

    test('keyboard: Tab/Shift+Tab through navigation with a visible 2 px focus ring; Enter follows the link', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await api(page);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Огляд' })).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Основна навігація' });
      const overview = nav.getByRole('link', { name: 'Огляд' });
      const servers = nav.getByRole('link', { name: 'Сервери' });
      await overview.focus();
      await page.keyboard.press('Tab');
      await expect(servers).toBeFocused();
      const ring = await servers.evaluate((e) => {
        const s = getComputedStyle(e);
        return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, focus: getComputedStyle(document.documentElement).getPropertyValue('--focus').trim() };
      });
      expect(ring.width).toBe('2px');
      expect(ring.style).toBe('solid');
      await page.keyboard.press('Shift+Tab');
      await expect(overview).toBeFocused();
      // The active item is marked by more than colour (an inset bar and weight).
      expect(await overview.evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe('none');
      await nav.getByRole('link', { name: 'Користувачі' }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Користувачі' })).toBeVisible();
    });

    test('dialog and menu primitives: Enter/Space, Escape, focus return; compact choices unchanged; nothing saved', async ({ page }) => {
      await page.setViewportSize({ width: 1366, height: 768 });
      const mutations = await api(page);
      await page.goto('/users');
      const trigger = page.getByRole('button', { name: 'Дії: operator@example.com' });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'Доступи' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Space');
      await page.getByRole('menuitem', { name: 'Доступи' }).press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Доступи: operator@example.com' });
      const box = dialog.getByRole('checkbox', { name: /^billing-api/ });
      await expect(box).toBeVisible();
      const size = await box.boundingBox();
      expect([Math.round(size?.width ?? 0), Math.round(size?.height ?? 0)]).toEqual([16, 16]);
      await box.focus();
      await page.keyboard.press('Space');
      await expect(box).toBeChecked();
      if (shots) await page.screenshot({ path: `${shots}/foundation-access-${theme}-1366.png` });
      // Escape with unsaved input asks first (input is never lost silently), "back" keeps it, closing returns focus.
      await page.keyboard.press('Escape');
      await expect(dialog.getByText(/Введені дані не збережено/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Закрити без збереження' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(mutations).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Hit areas by INPUT, not only by width (review dca7703): a touch tablet at 1024 px gets 44 px controls and 44×44
// icon buttons; a wide fine-pointer desktop stays compact (36/32); a narrow window keeps 44. Measured on real elements
// in the browser. Checkbox/radio stay 16×16 (their label is the hit area). Hybrid devices cannot be emulated here.

/** A real `.button.icon-button` (the shared primitive; no screen uses it yet in stage 1) measured with the page CSS. */
const iconButton = (page: Page) => page.evaluate(() => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'button icon-button';
  b.setAttribute('aria-label', 'Синтетична іконкова кнопка');
  b.textContent = '⋯';
  document.body.append(b);
  const r = b.getBoundingClientRect();
  b.remove();
  return [Math.round(r.width), Math.round(r.height)];
});
const height = async (page: Page, locator: ReturnType<Page['locator']>) => Math.round((await locator.boundingBox())?.height ?? 0);

const MODALITIES = [
  { name: 'touch tablet 1024×768 (hasTouch, coarse pointer)', viewport: { width: 1024, height: 768 }, touch: true, regular: 44, compact: 44, icon: [44, 44] },
  { name: 'fine-pointer desktop 1440×900', viewport: { width: 1440, height: 900 }, touch: false, regular: 36, compact: 32, icon: [32, 32] },
  { name: 'narrow window 390×844 (fine pointer)', viewport: { width: 390, height: 844 }, touch: false, regular: 44, compact: 44, icon: [44, 44] },
] as const;

for (const theme of ['dark', 'light'] as const) {
  for (const m of MODALITIES) {
    test.describe(`${theme} · ${m.name}`, () => {
      test.use({ colorScheme: theme, viewport: m.viewport, hasTouch: m.touch, isMobile: m.touch });

      test('control hit areas follow the input method', async ({ page }) => {
        // The emulated input really is what the case says.
        await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: {} }));
        await page.goto('/');
        expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(m.touch);
        // Login: field and submit.
        await expect(page.getByLabel('Email')).toBeVisible();
        expect(await height(page, page.getByLabel('Email'))).toBe(m.regular);
        expect(await height(page, page.getByRole('button', { name: 'Увійти' }))).toBe(m.regular);
        // Icon primitive: both dimensions.
        const [w, h] = await iconButton(page);
        expect(w).toBeGreaterThanOrEqual(m.icon[0]);
        expect(h).toBeGreaterThanOrEqual(m.icon[1]);
        await noPageOverflow(page);
        await page.unrouteAll();

        // Signed in: navigation, row menu trigger, menu items, dialog controls; compact choices; no overflow.
        const mutations = await api(page);
        await page.goto('/users');
        const trigger = page.getByRole('button', { name: 'Дії: operator@example.com' });
        await expect(trigger).toBeVisible();
        expect(await height(page, trigger)).toBe(m.compact);
        expect(await height(page, page.getByRole('button', { name: 'Новий користувач' }))).toBe(m.regular);
        const pager = page.getByRole('navigation', { name: 'Сторінки користувачів' }).getByRole('button', { name: 'Назад' });
        expect(await height(page, pager)).toBe(m.compact);
        if (m.viewport.width > 760) expect(await height(page, page.getByRole('navigation', { name: 'Основна навігація' }).getByRole('link', { name: 'Користувачі' }))).toBe(m.regular);
        await trigger.click();
        const item = page.getByRole('menuitem', { name: 'Доступи' });
        expect(await height(page, item)).toBeGreaterThanOrEqual(m.regular);
        await item.click();
        const dialog = page.getByRole('dialog', { name: 'Доступи: operator@example.com' });
        const box = dialog.getByRole('checkbox', { name: /^billing-api/ });
        await expect(box).toBeVisible();
        expect(await box.evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })).toEqual([16, 16]);
        // The label (the real hit area) is at least the compact size and toggles the box.
        const label = dialog.locator('label.check').filter({ hasText: 'billing-api' });
        expect(await height(page, label)).toBeGreaterThanOrEqual(32);
        await (m.touch ? label.tap() : label.click());
        await expect(box).toBeChecked();
        expect(await height(page, dialog.getByLabel('Пошук сервісу'))).toBe(m.regular);
        expect(await height(page, dialog.getByRole('button', { name: 'Зберегти доступи' }))).toBe(m.regular);
        await expect(dialog.getByRole('button', { name: 'Зберегти доступи' })).toBeInViewport();
        expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(true);
        await noPageOverflow(page);
        if (shots) await page.screenshot({ path: `${shots}/touch-${theme}-${String(m.viewport.width)}-${m.touch ? 'coarse' : 'fine'}.png` });
        expect(mutations).toEqual([]);
      });
    });
  }
}

test('hybrid policy (static): the touch sizes are bound to any-pointer: coarse, not to the primary pointer or width alone', async ({ page }) => {
  // Playwright/Chromium cannot emulate a device that has both a fine and a coarse pointer, so the hybrid case is checked
  // on the loaded stylesheet: a rule under a media query that includes `(any-pointer: coarse)` sets both size tokens.
  await page.route('**/api/**', (route) => route.fulfill({ status: 401, json: {} }));
  await page.goto('/');
  const conditions = await page.evaluate(() => {
    const out: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      for (const rule of [...sheet.cssRules]) {
        if (rule instanceof CSSMediaRule) {
          const sets = [...rule.cssRules].some((r) => r instanceof CSSStyleRule && r.selectorText === ':root'
            && r.style.getPropertyValue('--control-h').trim() === '44px' && r.style.getPropertyValue('--control-sm').trim() === '44px');
          if (sets) out.push(rule.media.mediaText);
        }
      }
    }
    return out;
  });
  expect(conditions.some((c) => c.includes('any-pointer: coarse'))).toBe(true);
  expect(conditions.some((c) => c.includes('max-width: 760px'))).toBe(true);
});
