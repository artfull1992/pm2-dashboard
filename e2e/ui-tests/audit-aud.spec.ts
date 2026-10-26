import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';

// Audit log redesign (AUD-01…05, docs/design/part-01) in a real browser with synthetic API data only (nothing is
// sent). Fixed clock and time zone for screenshots comparable with the reference PNGs (NC_UI_SHOTS, named like the
// references: AUD-0x--<theme>--<viewport>.png). Checks: no page overflow at 1440×900 / 1366×768 / 1024×768 / 390×844
// in both themes; the list scrolls inside its card with 25, 100 and 500 loaded events (the document does not grow);
// «Показати старіші» stays outside the rows and keeps the reading position; details from a scrolled list return focus
// and position; short windows; a coarse pointer; opening details sends no request.

const shots = process.env.NC_UI_SHOTS;
const NOW = new Date('2026-10-23T07:22:00.000Z'); // 10:22 Kyiv
const at = (hms: string, day = '2026-10-23') => new Date(`${day}T${hms}+03:00`).toISOString();
const U1 = '0a1b2c3d-0000-4000-8000-000000000001';
const U2 = '0a1b2c3d-0000-4000-8000-000000000002';
const U3 = '0a1b2c3d-0000-4000-8000-000000000003';
const SA = '5e1f0000-0000-4000-8000-0000000000aa';
const SB = '5e1f0000-0000-4000-8000-0000000000bb';
const LONG = 'worker-with-a-very-long-name-for-reports-and-exports-v2';
const ADMIN = 'admin@example.com';
const OPERATOR = 'operator.with.a.rather.long.address.for.layout@example.com';
type State = 'list' | 'loading' | 'error' | 'empty' | 'chain';

// Read-time context of the API (ADR-033): current e-mails / server names and the linked command.
const ctx = (over: Record<string, unknown> = {}) => ({ actorEmail: null, serverName: null, targetUserEmail: null, command: null, ...over });
const ev = (id: string, over: Record<string, unknown>) => ({ id, occurredAt: at('10:21:48'), event: 'auth.login', outcome: 'success', actorUserId: U1, requestId: `req-${id}`, details: {}, context: ctx({ actorEmail: ADMIN }), ...over });
// The same kinds of events as the reference, in the shapes the API really sends.
const LIST = [
  ev('108', { event: 'process.command_requested', occurredAt: at('10:21:48'), details: { serverId: SA, commandId: 'c-1', targetKey: 'api', action: 'restart', serviceName: 'api-service' },
    context: ctx({ actorEmail: ADMIN, serverName: 'node-a', command: { requestedBy: U1, requestedByEmail: ADMIN, serviceName: 'api-service' } }) }),
  ev('107', { event: 'logs.view_opened', occurredAt: at('10:20:15'), actorUserId: U2, details: { serverId: SB, targetKey: 'n-0123456789abcdef01234567', serviceName: 'report-worker' }, context: ctx({ actorEmail: OPERATOR, serverName: 'node-b' }) }),
  ev('106', { event: 'process.command_rejected', outcome: 'failure', occurredAt: at('10:18:03'), actorUserId: null, requestId: null, details: { serverId: SB, commandId: 'c-2', targetKey: 'scheduled', action: 'stop', reason: 'not_allowed', serviceName: 'scheduled-worker' },
    context: ctx({ serverName: 'node-b', command: { requestedBy: U2, requestedByEmail: OPERATOR, serviceName: 'scheduled-worker' } }) }),
  ev('105', { event: 'access.updated', occurredAt: at('10:14:29'), details: { targetUserId: U3, revision: 4 }, context: ctx({ actorEmail: ADMIN, targetUserEmail: 'viewer@example.com' }) }),
  ev('104', { event: 'auth.login', outcome: 'failure', occurredAt: at('10:10:02'), actorUserId: null, details: { reason: 'invalid_credentials' }, context: ctx() }),
  ev('103', { event: 'auth.login', occurredAt: at('09:59:41') }),
  ev('102', { event: 'settings.alerts_changed', occurredAt: at('09:42:18'), details: { revision: 7, changed: 'rules' } }),
  ev('101', { event: 'logs.view_opened', occurredAt: at('19:35:04', '2026-10-22'), actorUserId: U2, details: { serverId: SB, targetKey: 'logs-target', serviceName: LONG }, context: ctx({ actorEmail: OPERATOR, serverName: 'node-b' }) }),
  // An old log row: no stored name, an opaque key — shown as «Назву застосунку не збережено», never decoded.
  ev('100', { event: 'logs.view_opened', occurredAt: at('19:30:00', '2026-10-22'), actorUserId: U2, details: { serverId: SB, targetKey: 'n-aaaaaaaaaaaaaaaaaaaaaaaa' }, context: ctx({ actorEmail: OPERATOR, serverName: 'node-b' }) }),
];

/** Chains of 25 newest-first by id; `total` events in all. */
function chain(beforeId: string | null, total: number) {
  const start = beforeId === null ? total : Number(beforeId) - 1;
  const items = Array.from({ length: Math.min(25, start) }, (_, k) => {
    const id = start - k;
    const name = `svc-${String(id).padStart(3, '0')}`;
    return ev(String(id), { event: id % 3 ? 'logs.view_opened' : 'process.command_succeeded', actorUserId: id % 3 ? U2 : null, occurredAt: new Date(NOW.getTime() - (total - id) * 60_000).toISOString(),
      details: { serverId: SA, targetKey: `k-${String(id)}`, serviceName: name, ...(id % 3 ? {} : { commandId: `c-${String(id)}`, action: 'restart' }) },
      context: ctx({ actorEmail: id % 3 ? OPERATOR : null, serverName: 'node-a', command: id % 3 ? null : { requestedBy: U1, requestedByEmail: ADMIN, serviceName: name } }) });
  });
  const last = items.at(-1);
  return { items, nextBeforeId: last && Number(last.id) > 1 ? last.id : null };
}

async function api(page: Page, state: State, total = 25) {
  const reads: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    reads.push(`${req.method()} ${url.pathname}${url.search}`);
    if (req.method() !== 'GET') { await route.fulfill({ status: 409, json: {} }); return; }
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: U1, email: 'admin@example.com', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] } });
      return;
    }
    if (url.pathname === '/api/audit') {
      if (state === 'loading') return; // never answered
      if (state === 'error') { await route.fulfill({ status: 503, headers: { 'retry-after': '10' }, json: {} }); return; }
      if (state === 'empty') { await route.fulfill({ json: { items: [], nextBeforeId: null } }); return; }
      if (state === 'list') { await route.fulfill({ json: { items: LIST, nextBeforeId: '100' } }); return; }
      await route.fulfill({ json: chain(url.searchParams.get('beforeId'), total) });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  return reads;
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, compact: { width: 1366, height: 768 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } } as const;
type Viewport = keyof typeof VIEWPORTS;

async function open(browser: Browser, o: { scheme?: 'light' | 'dark'; viewport: { width: number; height: number }; state?: State; total?: number; touch?: boolean }) {
  const context = await browser.newContext({ viewport: o.viewport, colorScheme: o.scheme ?? 'dark', locale: 'uk-UA', timezoneId: 'Europe/Kyiv', hasTouch: o.touch ?? false, isMobile: false, baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const reads = await api(page, o.state ?? 'list', o.total);
  return { context, page, reads };
}

const rows = (page: Page) => page.locator('.audit__scroll, .audit-records');
const openers = (page: Page) => page.locator('.audit__open');
const docHeight = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);
const noPageOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
const box = async (l: Locator) => { const b = await l.boundingBox(); expect(b).not.toBeNull(); return b ?? { x: 0, y: 0, width: 0, height: 0 }; };
const fitsWindow = (page: Page) => { const v = page.viewportSize(); return v !== null && v.width > 600 && v.height > 640; };

async function show(page: Page, id: string) {
  await page.goto('/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Журнал аудиту' })).toBeVisible();
  if (id === 'AUD-04') { await expect(page.getByText('Завантаження журналу…')).toBeVisible(); return; }
  if (id === 'AUD-05') { await expect(page.getByRole('heading', { name: 'Не вдалося завантажити журнал' })).toBeVisible(); return; }
  await expect(openers(page).first()).toBeVisible();
  if (id === 'AUD-02') { await openers(page).first().click(); await expect(page.getByRole('dialog')).toBeVisible(); }
  if (id === 'AUD-03') {
    await page.getByLabel('Пошук серед завантажених подій').fill('node-z');
    await expect(page.getByRole('heading', { name: 'Серед завантажених подій збігів немає' })).toBeVisible();
  }
}

const STATES: { id: string; state: State; on: Viewport[] }[] = [
  { id: 'AUD-01', state: 'list', on: ['desktop', 'compact', 'tablet', 'mobile'] },
  { id: 'AUD-02', state: 'list', on: ['desktop', 'tablet', 'mobile'] },
  { id: 'AUD-03', state: 'list', on: ['desktop', 'mobile'] },
  { id: 'AUD-04', state: 'loading', on: ['desktop', 'mobile'] },
  { id: 'AUD-05', state: 'error', on: ['desktop', 'mobile'] },
];

for (const scheme of ['dark', 'light'] as const) {
  for (const s of STATES) {
    test(`${s.id} ${scheme}: ${s.on.join(', ')} — no page overflow${shots ? ', screenshots' : ''}`, async ({ browser }) => {
      for (const v of s.on) {
        const { context, page } = await open(browser, { scheme, viewport: VIEWPORTS[v], state: s.state });
        await show(page, s.id);
        await noPageOverflow(page);
        if (s.id === 'AUD-02') {
          const b = await box(page.getByRole('dialog'));
          expect(Math.round(b.width)).toBe(v === 'mobile' ? VIEWPORTS[v].width : v === 'tablet' ? 520 : 540);
          await expect(page.getByRole('dialog').getByRole('button', { name: 'Закрити', exact: true })).toBeInViewport();
        }
        if (shots) await page.screenshot({ path: `${shots}/${s.id}--${scheme}--${v}.png` });
        await context.close();
      }
    });
  }
}

/** The list scrolls inside its card; «Показати старіші» outside the rows and reachable; the last record readable. */
async function contained(page: Page, label: string) {
  const vh = page.viewportSize()?.height ?? 0;
  const s = rows(page);
  const m = await s.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  expect(m.scrollHeight, `${label}: own scroll`).toBeGreaterThan(m.clientHeight);
  expect(m.clientHeight, `${label}: useful list area`).toBeGreaterThanOrEqual(250);
  if (fitsWindow(page)) expect(await docHeight(page), `${label}: document fits the window`).toBeLessThanOrEqual(vh + 1);
  await page.locator('.audit-card').evaluate((el) => { el.scrollIntoView({ block: 'end' }); });
  const pager = await box(page.getByRole('navigation', { name: 'Старіші події журналу' }));
  const list = await box(s);
  expect(pager.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  expect(pager.y + pager.height).toBeLessThanOrEqual(vh + 1);
  if (shots) console.log(`[metrics] ${label}: document=${String(await docHeight(page))} rows ${String(m.scrollHeight)}/${String(m.clientHeight)} pager.y=${String(pager.y)}`);
  await s.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(openers(page).last()).toBeInViewport();
}

async function loadTo(page: Page, count: number) {
  while ((await openers(page).count()) < count) {
    const before = await openers(page).count();
    await page.getByRole('button', { name: 'Показати старіші' }).click();
    await expect(openers(page)).toHaveCount(Math.min(before + 25, count));
  }
}

for (const v of ['desktop', 'compact', 'tablet', 'mobile'] as const) {
  test(`${v}: 25 → 100 loaded events scroll inside the card; loading older keeps the reading position`, async ({ browser }) => {
    const { context, page } = await open(browser, { viewport: VIEWPORTS[v], state: 'chain', total: 500 });
    await show(page, 'AUD-01');
    await contained(page, `${v} 25`);
    const s = rows(page);
    const top = await s.evaluate((el) => el.scrollTop);
    await page.getByRole('button', { name: 'Показати старіші' }).click();
    await expect(openers(page)).toHaveCount(50);
    expect(Math.abs((await s.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(1); // appended below, nothing jumps
    await loadTo(page, 100);
    await contained(page, `${v} 100`);
    if (shots) await page.screenshot({ path: `${shots}/aud-scroll-100-${v}.png` });
    await context.close();
  });
}

test('500 loaded events (20 chunks): the document stays as high as with 25; the last record and the end of the journal are reachable', async ({ browser }) => {
  const { context, page, reads } = await open(browser, { viewport: VIEWPORTS.desktop, state: 'chain', total: 500 });
  await show(page, 'AUD-01');
  const h25 = await docHeight(page);
  await loadTo(page, 500);
  expect(await docHeight(page)).toBe(h25);
  await expect(page.getByText('Старіших подій немає')).toBeVisible();
  await rows(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('tbody tr').last()).toContainText('svc-001');
  await expect(openers(page).last()).toBeInViewport();
  const audit = reads.filter((r) => r.includes('/api/audit'));
  expect(audit).toHaveLength(20); // one request per chunk, no per-row requests
  expect(reads.filter((r) => !/\/api\/(audit|auth\/me)/.test(r))).toEqual([]);
  await context.close();
});

test('the document height does not depend on the number of events in short windows and on phones', async ({ browser }) => {
  for (const viewport of [{ width: 1280, height: 600 }, { width: 720, height: 450 }, { width: 390, height: 844 }]) {
    const heights: number[] = [];
    for (const total of [3, 100]) {
      const { context, page } = await open(browser, { viewport, state: 'chain', total });
      await show(page, 'AUD-01');
      if (total === 100) await loadTo(page, 100);
      heights.push(await docHeight(page));
      if (total === 100) {
        await contained(page, `${String(viewport.width)}×${String(viewport.height)}`);
        if (shots) await page.screenshot({ path: `${shots}/aud-scroll-short-${String(viewport.width)}x${String(viewport.height)}.png` });
      }
      await context.close();
    }
    expect(heights[1], `${String(viewport.width)}×${String(viewport.height)}`).toBe(heights[0]);
  }
});

test('details from a scrolled list (1440 and 390): Escape and «Закрити» return focus and the list position; background inert; no request', async ({ browser }) => {
  for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
    const { context, page, reads } = await open(browser, { viewport, state: 'chain', total: 100 });
    await show(page, 'AUD-01');
    await loadTo(page, 50);
    const s = rows(page);
    const target = openers(page).nth(30);
    await target.evaluate((el) => { el.scrollIntoView({ block: 'center' }); });
    const position = await s.evaluate((el) => el.scrollTop);
    expect(position).toBeGreaterThan(0);
    const before = reads.length;
    await target.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Закрити деталі' })).toBeFocused();
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(target).toBeFocused();
    expect(await s.evaluate((el) => el.scrollTop)).toBe(position);
    await target.click();
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(target).toBeFocused();
    expect(await s.evaluate((el) => el.scrollTop)).toBe(position);
    expect(reads.slice(before)).toEqual([]);
    await context.close();
  }
});

test('details in a low window: header and footer in view, only the middle scrolls; the technical ids open by keyboard', async ({ browser }) => {
  for (const viewport of [{ width: 1280, height: 600 }, { width: 720, height: 450 }]) {
    const { context, page } = await open(browser, { viewport, scheme: 'light' });
    await show(page, 'AUD-02');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Закрити деталі' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeInViewport();
    const summary = dialog.getByText('Технічні ідентифікатори');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByText('Подія (ID)')).toBeVisible();
    expect(await dialog.locator('.dialog__body').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await noPageOverflow(page);
    if (shots) await page.screenshot({ path: `${shots}/AUD-02--light--low-${String(viewport.width)}x${String(viewport.height)}.png` });
    await context.close();
  }
});

test('coarse pointer at 1440 px: openers, filters, refresh and «Показати старіші» are at least 44 px high', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: VIEWPORTS.desktop, state: 'chain', total: 100, touch: true });
  await show(page, 'AUD-01');
  expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
  for (const sel of ['.audit__open', '.audit__filters select', '.audit__filters input', '.audit__pager .button', '.page-header__actions .button']) {
    const hs = await page.locator(sel).evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(hs.length, sel).toBeGreaterThan(0);
    for (const h of hs) expect(h, sel).toBeGreaterThanOrEqual(44);
  }
  await context.close();
});

test('long target names wrap inside the table, no horizontal scroll at 1024', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: VIEWPORTS.tablet });
  await show(page, 'AUD-01');
  await expect(page.locator('tbody').getByText(LONG)).toBeVisible();
  expect(await rows(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await noPageOverflow(page);
  await context.close();
});

// Review fc6f2e4: event codes that match Object.prototype properties are ordinary unknown codes. The journal must
// stay on screen with them (no TypeError in sorting the «Дія» options), show them as text, filter and open details.
test('unknown codes such as constructor / toString / __proto__ keep the journal: rows, filter, search and details work; no page error', async ({ browser }) => {
  const codes = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, colorScheme: 'dark', locale: 'uk-UA', timezoneId: 'Europe/Kyiv', baseURL: 'http://127.0.0.1:4175' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => { errors.push(e.message); });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: U1, email: 'admin@example.com', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: ['monitoring:read', 'audit:read'] } });
      return;
    }
    if (url.pathname === '/api/audit') {
      await route.fulfill({ json: { items: [ev('9', { event: 'auth.login' }), ...codes.map((code, k) => ev(String(8 - k), { event: code, details: { action: code, reason: code } }))], nextBeforeId: null } });
      return;
    }
    await route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/audit');
  const table = page.getByRole('table');
  await expect(table.getByRole('rowheader')).toHaveText(['Увійшов', ...codes]);
  await expect(page.getByRole('navigation', { name: 'Основна навігація' })).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0)).toBeGreaterThan(0);
  await page.getByLabel('Дія').selectOption('toString');
  await expect(table.getByRole('rowheader')).toHaveText(['toString']);
  await page.getByLabel('Дія').selectOption('');
  await page.getByLabel('Пошук серед завантажених подій').fill('__proto__');
  await expect(table.getByRole('rowheader')).toHaveText(['__proto__']);
  await table.getByRole('button', { name: '__proto__' }).click();
  const dialog = page.getByRole('dialog', { name: '__proto__' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

// ADR-033: the row itself says who did what on which application and server; a system step names the requester.
test('readable rows (1440 table, 390 records): who / action / application / server without opening details; old rows fall back; long e-mails fit', async ({ browser }) => {
  for (const v of ['desktop', 'mobile'] as const) {
    const { context, page } = await open(browser, { viewport: VIEWPORTS[v] });
    await show(page, 'AUD-01');
    const row = (action: string) => (v === 'desktop' ? page.locator('tbody tr', { has: page.getByRole('button', { name: action, exact: true }) }) : page.getByRole('article', { name: new RegExp(`^${action}:`) })).first();
    const req = row('Запросив перезапуск');
    for (const text of [ADMIN, 'api-service', 'node-a']) await expect(req).toContainText(text);
    const rejected = row('Зупинку відхилено');
    await expect(rejected).toContainText(OPERATOR);
    await expect(rejected).toContainText('Системна подія · за запитом користувача');
    await expect(rejected).toContainText('scheduled-worker');
    await expect(row('Змінив доступи')).toContainText('viewer@example.com');
    const logs = page.getByRole(v === 'desktop' ? 'row' : 'article').filter({ hasText: 'Назву застосунку не збережено' });
    await expect(logs).toHaveCount(1);
    await expect(logs).not.toContainText('n-aaaaaaaa');
    await noPageOverflow(page);
    expect(await rows(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/aud-readable-${v}.png` });
    await context.close();
  }
});

test('details of a system step: author of the row («Система») and the requester apart, names with their origin', async ({ browser }) => {
  const { context, page } = await open(browser, { viewport: VIEWPORTS.desktop });
  await show(page, 'AUD-01');
  await page.getByRole('button', { name: 'Зупинку відхилено', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Зупинку відхилено' });
  await expect(dialog).toContainText('Автор запису');
  await expect(dialog).toContainText('Замовник команди');
  await expect(dialog).toContainText(OPERATOR);
  await expect(dialog).toContainText('поточна назва на момент перегляду');
  await expect(dialog).toContainText('збережено в події під час операції');
  if (shots) await page.screenshot({ path: `${shots}/aud-readable-drawer-desktop.png` });
  await page.keyboard.press('Escape');
  await context.close();
});
