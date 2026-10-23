import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

// Alerts redesign (NTF-01…07, docs/design/part-01) in a real browser with synthetic API data only: nothing is sent,
// no Slack, no PM2. A fixed clock and time zone make the screenshots comparable with the reference PNGs at the same
// viewports (NC_UI_SHOTS, named like the references: NTF-0x--<theme>--<viewport>.png). Checks: no page overflow in
// both themes at 1440×900 / 1366×768 / 1024×768 / 390×844, long names, the drawer geometry (540 / 520 / full screen)
// with header and footer in view and a scrolling middle, a low window, keyboard (Tab, focus trap, Escape, focus
// return), a coarse pointer, and that opening details sends no request.

const shots = process.env.NC_UI_SHOTS;
const NOW = new Date('2026-10-23T07:28:00.000Z'); // 10:28 Kyiv
const at = (hhmm: string, day = '2026-10-23') => new Date(`${day}T${hhmm}:00+03:00`).toISOString();
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LONG = 'worker-with-a-very-long-name-for-reports-and-exports-v2';
type Role = 'admin' | 'viewer';
type State = 'active' | 'history' | 'empty' | 'loading' | 'error' | 'stale';

const sent = (state: string) => ({ notify: true, state, attempts: state === 'none' ? 0 : 1, lastError: state === 'failed' ? 'http_500' : null });
const incident = (n: number, over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, rule: 'process_cpu', severity: 'warning', status: 'firing', resolution: null,
  serverId: A, serverName: 'node-a', serverStatus: 'online', processName: 'api-service', pmId: 1, detail: {},
  openedAt: at('10:16'), lastObservedAt: at('10:22'), resolvedAt: null, notification: null, ...over,
});
const ACTIVE = [
  incident(1, { detail: { value: 126, threshold: 90 }, notification: sent('sent') }),
  incident(2, { rule: 'process_down', serverId: B, serverName: 'node-b', processName: 'scheduled-worker', pmId: 4, detail: { status: 'stopped' }, openedAt: at('09:40'), notification: sent('queued') }),
  incident(3, { rule: 'server_offline', severity: 'critical', serverId: C, serverName: 'node-c', serverStatus: 'offline', processName: null, pmId: null, detail: { lastSeenAt: at('10:18') }, openedAt: at('10:20'), notification: sent('failed') }),
];
const HISTORY = [
  incident(11, { rule: 'process_restarts', status: 'resolved', resolution: 'recovered', processName: 'report-worker', detail: { delta: 0, spanSeconds: 600, threshold: 3 }, openedAt: at('08:10'), lastObservedAt: at('08:24'), resolvedAt: at('08:24'), notification: sent('sent') }),
  incident(12, { rule: 'inventory_stale', status: 'resolved', resolution: 'recovered', serverId: B, serverName: 'node-b', processName: null, pmId: null, detail: { state: 'stale' }, openedAt: at('18:20', '2026-10-22'), lastObservedAt: at('18:31', '2026-10-22'), resolvedAt: at('18:31', '2026-10-22'), notification: sent('none') }),
  incident(13, { rule: 'process_restarts', status: 'resolved', resolution: 'process_gone', serverId: B, serverName: 'node-b', processName: LONG, detail: { delta: 9, spanSeconds: 600, threshold: 3 }, openedAt: at('17:12', '2026-10-22'), lastObservedAt: at('17:45', '2026-10-22'), resolvedAt: at('17:45', '2026-10-22'), notification: sent('sent') }),
];

async function api(page: Page, role: Role, state: State) {
  const reads: string[] = [];
  let failNow = state === 'error';
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    reads.push(`${req.method()} ${url.pathname}${url.search}`);
    if (req.method() !== 'GET') { await route.fulfill({ status: 409, json: {} }); return; }
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: '00000000-0000-4000-8000-000000000001', email: `${role}@example.com`, role }, csrfToken: 'a'.repeat(43), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        permissions: role === 'admin' ? ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] : ['monitoring:read'] } });
      return;
    }
    if (url.pathname === '/api/alerts/status') {
      await route.fulfill({ json: { engine: { enabled: true, running: true, lastEvaluationAt: at('10:22'), lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: state === 'empty' ? 0 : 3,
        admin: role === 'admin' ? { webhookConfigured: true, publicUrlConfigured: true, intervalSeconds: 30, cooldownMinutes: 15, reminderMinutes: 0, maxAttempts: 6, queueMax: 100,
          thresholds: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
          queue: { queued: 1, sending: 0, sent: 7, failed: 1, unknown: 0, dropped: 0, cancelled: 0 }, lastSentAt: at('10:16'), lastDeliveryError: null, lastEvaluationError: null } : null } });
      return;
    }
    if (url.pathname === '/api/alerts') {
      if (state === 'loading') return; // never answered: the loading state stays
      if (failNow) { await route.fulfill({ status: 503, headers: { 'retry-after': '5' }, json: {} }); return; }
      if (state === 'stale') failNow = true; // the next refresh fails
      const resolved = url.searchParams.get('state') === 'resolved';
      const strip = (items: typeof ACTIVE) => (role === 'admin' ? items : items.map((i) => ({ ...i, notification: null })));
      await route.fulfill({ json: { items: state === 'empty' ? [] : strip(resolved ? HISTORY : ACTIVE), nextBefore: resolved ? HISTORY[2]?.id : null } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  return reads;
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, compact: { width: 1366, height: 768 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } } as const;
type Viewport = keyof typeof VIEWPORTS;

async function open(browser: Browser, o: { scheme: 'light' | 'dark'; viewport: { width: number; height: number }; role?: Role; state?: State; touch?: boolean }): Promise<{ context: BrowserContext; page: Page; reads: string[] }> {
  const context = await browser.newContext({ viewport: o.viewport, colorScheme: o.scheme, locale: 'uk-UA', timezoneId: 'Europe/Kyiv', hasTouch: o.touch ?? false, isMobile: false, baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const reads = await api(page, o.role ?? 'admin', o.state ?? 'active');
  return { context, page, reads };
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
const records = (page: Page) => page.viewportSize()?.width !== undefined && (page.viewportSize()?.width ?? 0) <= 760;
const firstRecord = (page: Page) => (records(page) ? page.getByRole('tabpanel').getByRole('article') : page.getByRole('tabpanel').locator('tbody tr')).first();

/** Brings the page into one NTF state. */
async function show(page: Page, id: string) {
  await page.goto('/alerts');
  await expect(page.getByRole('heading', { level: 1, name: 'Сповіщення' })).toBeVisible();
  if (id === 'NTF-05') { await expect(page.getByText('Завантаження проблем…')).toBeVisible(); return; }
  if (id === 'NTF-06') { await expect(page.getByRole('heading', { name: 'Не вдалося отримати проблеми' })).toBeVisible(); return; }
  if (id === 'NTF-04') { await expect(page.getByRole('heading', { name: 'Активних проблем немає' })).toBeVisible(); return; }
  await expect(firstRecord(page)).toBeVisible();
  if (id === 'NTF-02') { await page.getByRole('tab', { name: 'Історія' }).click(); await expect(page.getByRole('tabpanel').getByText(LONG)).toBeVisible(); }
  if (id === 'NTF-03') { await firstRecord(page).getByRole('button', { name: 'Високе CPU процесу (PM2)' }).click(); await expect(page.getByRole('dialog')).toBeVisible(); }
  if (id === 'NTF-07') {
    // Six minutes later the refresh fails (a visibility change triggers it at once): previous rows + one warning.
    await page.clock.setFixedTime(new Date(NOW.getTime() + 360_000));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText(/Дані застарілі · останнє отримання о 10:28:00 \(6 хв тому\)/)).toBeVisible();
  }
}

const STATES: { id: string; state: State; on: Viewport[] }[] = [
  { id: 'NTF-01', state: 'active', on: ['desktop', 'compact', 'tablet', 'mobile'] },
  { id: 'NTF-02', state: 'history', on: ['desktop', 'mobile'] },
  { id: 'NTF-03', state: 'active', on: ['desktop', 'compact', 'tablet', 'mobile'] },
  { id: 'NTF-04', state: 'empty', on: ['desktop', 'mobile'] },
  { id: 'NTF-05', state: 'loading', on: ['desktop', 'mobile'] },
  { id: 'NTF-06', state: 'error', on: ['desktop', 'mobile'] },
  { id: 'NTF-07', state: 'stale', on: ['desktop', 'mobile'] },
];

for (const scheme of ['dark', 'light'] as const) {
  for (const s of STATES) {
    test(`${s.id} ${scheme}: ${s.on.join(', ')} — no page overflow${shots ? ', screenshots' : ''}`, async ({ browser }) => {
      for (const v of s.on) {
        const { context, page } = await open(browser, { scheme, viewport: VIEWPORTS[v], state: s.state });
        await show(page, s.id);
        await noPageOverflow(page);
        if (s.id === 'NTF-03') {
          const box = await page.getByRole('dialog').boundingBox();
          expect(box).not.toBeNull();
          const expected = v === 'mobile' ? VIEWPORTS[v].width : v === 'tablet' ? 520 : 540;
          expect(Math.round(box?.width ?? 0)).toBe(expected);
          expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(VIEWPORTS[v].width); // anchored right
        }
        if (shots) await page.screenshot({ path: `${shots}/${s.id}--${scheme}--${v}.png` });
        await context.close();
      }
    });
  }
}

test('long names: one line with an ellipsis and the full name on hover; the table fits without page overflow', async ({ browser }) => {
  for (const v of ['desktop', 'tablet'] as const) {
    const { context, page } = await open(browser, { scheme: 'dark', viewport: VIEWPORTS[v] });
    await show(page, 'NTF-02');
    const cell = page.getByRole('tabpanel').locator('.incidents__app', { hasText: LONG });
    await expect(cell).toHaveAttribute('title', LONG);
    expect(await cell.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const widths = await page.locator('.incidents__scroll').evaluate((el) => [el.scrollWidth, el.clientWidth, ...Array.from(el.querySelectorAll('thead th')).map((t) => Math.round(t.getBoundingClientRect().width))]);
    expect(widths[0] ?? 0, `${v}: ${JSON.stringify(widths)}`).toBeLessThanOrEqual((widths[1] ?? 0) + 1);
    await noPageOverflow(page);
    await context.close();
  }
});

test('drawer by keyboard (1440 and 390): Enter opens, focus on «Закрити деталі», Tab stays inside, Escape returns focus; background inert; no request', async ({ browser }) => {
  for (const v of ['desktop', 'mobile'] as const) {
    const { context, page, reads } = await open(browser, { scheme: 'dark', viewport: VIEWPORTS[v] });
    await show(page, 'NTF-01');
    const opener = firstRecord(page).getByRole('button', { name: 'Високе CPU процесу (PM2)' });
    await opener.focus();
    const before = reads.length;
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Високе CPU процесу (PM2)' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Закрити деталі' })).toBeFocused();
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(false);
    expect(reads.slice(before).filter((r) => !r.startsWith('GET /api/alerts'))).toEqual([]);
    await context.close();
  }
});

test('low windows (1280×600, 720×450 = 1440×900 at 200 %): header and footer of the drawer stay in view, only the middle scrolls', async ({ browser }) => {
  for (const viewport of [{ width: 1280, height: 600 }, { width: 720, height: 450 }]) {
    const { context, page } = await open(browser, { scheme: 'light', viewport });
    await show(page, 'NTF-03');
    const dialog = page.getByRole('dialog');
    for (const part of [dialog.getByRole('button', { name: 'Закрити деталі' }), dialog.getByRole('button', { name: 'Закрити', exact: true })]) {
      const box = await part.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.y ?? -1)).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 0.5);
    }
    const body = dialog.locator('.dialog__body');
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(dialog.getByRole('heading', { name: 'Доставка повідомлення' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Закрити деталі' })).toBeInViewport();
    await noPageOverflow(page);
    if (shots) await page.screenshot({ path: `${shots}/NTF-03--light--low-${String(viewport.width)}x${String(viewport.height)}.png` });
    await context.close();
  }
});

test('coarse pointer at 1440 px: row openers, tabs, filters, pager and drawer buttons are at least 44 px high', async ({ browser }) => {
  const { context, page } = await open(browser, { scheme: 'dark', viewport: VIEWPORTS.desktop, touch: true });
  expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
  await show(page, 'NTF-02');
  const heights = async (selector: string) => page.locator(selector).evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => Math.round(el.getBoundingClientRect().height)));
  for (const sel of ['.incidents__open', '[role="tab"]', '.alerts__filters select', '.alerts__filters input', '.incidents__pager .button']) {
    const hs = await heights(sel);
    expect(hs.length, sel).toBeGreaterThan(0);
    for (const h of hs) expect(h, sel).toBeGreaterThanOrEqual(44);
  }
  await page.locator('.incidents__open').first().click();
  for (const h of await heights('[role="dialog"] .button')) expect(h).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('viewer: no delivery column, no settings link, drawer without delivery', async ({ browser }) => {
  const { context, page } = await open(browser, { scheme: 'dark', viewport: VIEWPORTS.desktop, role: 'viewer' });
  await show(page, 'NTF-01');
  await expect(page.getByRole('columnheader', { name: 'Доставка' })).toHaveCount(0);
  await expect(page.locator('.page-header__actions')).toHaveCount(0);
  await firstRecord(page).getByRole('button', { name: 'Високе CPU процесу (PM2)' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Доставка повідомлення' })).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/NTF-03--dark--desktop-viewer.png` });
  await context.close();
});
