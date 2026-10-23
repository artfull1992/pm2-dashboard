import { type Browser, expect, type Page, test } from '@playwright/test';

// Applications master-detail workspace (redesign B, stage 2) in a real browser with a synthetic API only (no DB,
// credentials or PM2). Covers the split view from 1280 px (≥9 full rows at 1440×900 and 1366×768, independent scroll,
// one log scroll), separate views below 1280 px (back keeps filters and scroll), compact rows at 390 px, 23 and 120
// processes (keyset pages of 50), the same PM2 id on two servers, a selection outside the filter, logs read only on
// their tab, keyboard, touch targets, contrast and both themes. Screenshots are written only when NC_UI_SHOTS is set.

const shots = process.env.NC_UI_SHOTS;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CMD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SERVERS = { [A]: 'app-server', [B]: 'backup-server' } as const;
const LONG = 'very-long-service-name-for-layout-checks-with-many-segments-v2';
const PAGE = 50;

interface Api { mutations: string[]; reads: string[]; /** Log result reads answer 404 (ambiguous: e.g. access revoked). */ logGone: boolean }
interface Item { key: string; serverId: string; name: string; pmId: number; status: string }

/** `count` processes in total: a few named ones on both servers plus generated ones on app-server. */
function inventory(count: number): Item[] {
  const named: Item[] = [
    { key: `${A}:pm2:0`, serverId: A, name: 'orders-api', pmId: 0, status: 'online' },
    { key: `${B}:pm2:0`, serverId: B, name: 'orders-api', pmId: 0, status: 'online' }, // same name AND PM2 id
    { key: `${A}:pm2:1`, serverId: A, name: 'billing-api', pmId: 1, status: 'online' },
    { key: `${A}:pm2:2`, serverId: A, name: LONG, pmId: 2, status: 'online' },
    { key: `${A}:pm2:3`, serverId: A, name: 'reports-worker', pmId: 3, status: 'errored' },
    { key: `${A}:pm2:4`, serverId: A, name: 'export-worker', pmId: 4, status: 'stopped' },
  ];
  const generated = Array.from({ length: Math.max(0, count - named.length) }, (_, i): Item => ({
    key: `${A}:pm2:${String(10 + i)}`, serverId: A, name: `svc-${String(i).padStart(3, '0')}`, pmId: 10 + i, status: 'online',
  }));
  return [...named, ...generated].sort((x, y) => x.name.localeCompare(y.name) || x.serverId.localeCompare(y.serverId));
}

async function api(page: Page, count = 23): Promise<Api> {
  const state: Api = { mutations: [], reads: [], logGone: false };
  const all = inventory(count);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const now = new Date(Date.now() - 20_000).toISOString();
    state.reads.push(`${req.method()} ${path}${url.search}`);
    const row = (it: Item) => ({
      key: it.key, serverId: it.serverId, serverName: SERVERS[it.serverId as keyof typeof SERVERS], serverStatus: it.serverId === B ? 'offline' : 'online',
      source: 'pm2', pmId: it.pmId, name: it.name, status: it.status, uptimeSeconds: it.status === 'online' ? 608_460 + it.pmId * 3600 : null, restarts: it.pmId,
      cpuPercent: it.status === 'online' ? 1.5 + (it.pmId % 7) : null, memoryBytes: it.status === 'online' ? (80 + it.pmId * 10) * 1024 ** 2 : null,
      execMode: 'fork', firstSeenAt: now, inventoryState: it.serverId === B ? 'stale' : 'current', capturedAt: now, collectedAt: now,
    });
    let data: unknown;
    if (req.method() === 'POST' && path === `/api/servers/${A}/control-commands`) {
      state.mutations.push(`${req.method()} ${path} ${JSON.stringify(req.postDataJSON() as unknown)}`);
      data = { id: CMD, serverId: A, targetKey: 'orders-api', action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
        requestedAt: now, deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: null };
      await route.fulfill({ status: 201, json: data });
      return;
    }
    if (req.method() === 'POST' && path === `/api/servers/${A}/log-requests`) {
      await route.fulfill({ status: 202, json: { requestId: LOG, deadlineAt: new Date(Date.now() + 15_000).toISOString() } });
      return;
    }
    if (req.method() !== 'GET') { state.mutations.push(`${req.method()} ${path}`); await route.fulfill({ status: 409, json: {} }); return; }
    if (path === '/api/auth/me') {
      data = { user: { id: '00000000-0000-4000-8000-000000000001', email: 'operator@example.com', role: 'operator' }, csrfToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: ['monitoring:read', 'processes:control', 'logs:read'] };
    } else if (path === '/api/servers') {
      data = { items: [A, B].map((id) => ({ id, name: SERVERS[id as keyof typeof SERVERS], isActive: true, createdAt: now, status: id === B ? 'offline' : 'online', lastSeenAt: now, hasActiveCredential: true })), nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/applications') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const only = url.searchParams.get('serverId');
      const status = url.searchParams.get('status');
      const matching = all.filter((a) => a.name.toLowerCase().includes(q) && (!only || a.serverId === only) && (!status || a.status === status));
      const offset = Number((url.searchParams.get('cursor') ?? 'c0').slice(1));
      const slice = matching.slice(offset, offset + PAGE);
      data = { items: slice.map(row), nextCursor: offset + PAGE < matching.length ? `c${String(offset + PAGE)}` : null, freshWindowSeconds: 180 };
    } else if (/^\/api\/servers\/[^/]+\/applications$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      data = { serverId: id, serverStatus: id === B ? 'offline' : 'online', freshWindowSeconds: 180, items: all.filter((a) => a.serverId === id).map(row),
        inventory: { state: id === B ? 'stale' : 'current', reason: null, source: 'pm2', capturedAt: now, collectedAt: now, reportedAt: now, processCount: all.filter((a) => a.serverId === id).length } };
    } else if (/^\/api\/servers\/[^/]+\/control$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      data = { serverId: id, enabled: true, serverStatus: id === B ? 'offline' : 'online', targetFreshSeconds: 60,
        broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: id !== B },
        targets: all.filter((a) => a.serverId === id).map((a) => ({ targetKey: a.name.slice(0, 40), name: a.name, pmId: a.pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })) };
    } else if (/^\/api\/servers\/[^/]+\/log-targets$/.test(path)) {
      const id = path.split('/')[3] ?? '';
      data = id === B ? { serverId: id, state: 'not_connected', reportedAt: now, targets: [] }
        : { serverId: id, state: 'supported', reportedAt: now, targets: all.filter((a) => a.serverId === id).map((a) => ({ targetKey: a.name.slice(0, 40), name: a.name, pmId: a.pmId, matchStatus: 'ok' })) };
    } else if (path === `/api/servers/${A}/control-commands` && url.searchParams.get('targetKey')) {
      data = { items: url.searchParams.get('targetKey') === 'orders-api' ? [
        { id: '11111111-1111-4111-8111-111111111111', serverId: A, targetKey: 'orders-api', action: 'restart', status: 'succeeded', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
          requestedAt: now, deadlineAt: now, dispatchedAt: now, completedAt: now, attempts: 1, before: { status: 'online' }, after: { status: 'online' } },
      ] : [] };
    } else if (path.endsWith('/control-commands')) data = { items: [] };
    else if (path === `/api/log-requests/${LOG}` && state.logGone) { await route.fulfill({ status: 404, json: {} }); return; }
    else if (path === `/api/log-requests/${LOG}`) {
      const text = Array.from({ length: 100 }, (_, i) => `2026-10-16T10:00:${String(i % 60).padStart(2, '0')}Z GET /api/orders/${String(i)} 200 ${'payload '.repeat(10)}`).join('\n');
      data = { requestId: LOG, serverId: A, targetKey: 'orders-api', status: 'done', deadlineAt: now, result: { outcome: 'ok', reason: null, readAt: now,
        stdout: { state: 'ok', text, lines: 100, truncated: true, sizeBytes: 900_000, modifiedAt: now }, stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: now } } };
    } else if (path === `/api/control-commands/${CMD}`) {
      data = { id: CMD, serverId: A, targetKey: 'orders-api', action: 'restart', status: 'queued', reason: null, requestedBy: '00000000-0000-4000-8000-000000000001',
        requestedAt: now, deadlineAt: new Date(Date.now() + 120_000).toISOString(), dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: null };
    } else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });
  return state;
}

const rowOf = (page: Page, name: string, server = 'app-server') => page.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} на ${server}:`) });
const panelOf = (page: Page, name: string, server = 'app-server') => page.getByRole('region', { name: `Деталі: ${name} на ${server}` });
const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };

/** Heights of the rendered rows and how many are fully visible inside the list's scroll area. */
const listGeometry = (page: Page) => page.evaluate(() => {
  const list = document.querySelector<HTMLElement>('.app-list__rows');
  if (!list) return null;
  const box = list.getBoundingClientRect();
  const rows = [...list.querySelectorAll<HTMLElement>('.app-row')];
  const visible = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= box.top - 0.5 && b.bottom <= Math.min(box.bottom, window.innerHeight) + 0.5; }).length;
  return { heights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))], visible, scrollable: list.scrollHeight > list.clientHeight };
});

/** Computed font sizes (px) of the list's main text (names, metrics) and of its secondary lines; name line count. */
const listTypography = (page: Page) => page.evaluate(() => {
  const px = (sel: string) => [...new Set([...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.offsetParent !== null)
    .map((el) => parseFloat(getComputedStyle(el).fontSize)))];
  const names = [...document.querySelectorAll<HTMLElement>('.app-row__name')];
  return {
    name: px('.app-row__name'), metric: [...px('.app-row__metric'), ...px('.app-row__compact')], sub: px('.app-row__server'),
    // Compact rows: the metrics are never cut off by the row (only the server name may be shortened).
    compactFits: [...document.querySelectorAll<HTMLElement>('.app-row__compact')].filter((el) => el.offsetParent !== null)
      .every((el) => { const sub = el.parentElement?.getBoundingClientRect(); return !sub || el.getBoundingClientRect().right <= sub.right + 0.5; }),
    // One text line per name: long names are cut with an ellipsis, never wrapped character by character.
    nameLines: Math.max(...names.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)))),
    nameEllipsis: names.every((el) => getComputedStyle(el).textOverflow === 'ellipsis' && getComputedStyle(el).whiteSpace === 'nowrap'),
  };
});

/** WCAG contrast ratio of an element's text against the first opaque background behind it. */
const contrastOf = (page: Page, selector: string) => page.evaluate((sel) => {
  const parse = (c: string): [number, number, number, number] | null => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    const s = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (s) return [Number(s[1]) * 255, Number(s[2]) * 255, Number(s[3]) * 255, s[4] === undefined ? 1 : Number(s[4])];
    return null;
  };
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return null;
  const layers: [number, number, number, number][] = [];
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg && bg[3] > 0) { layers.push(bg); if (bg[3] >= 1) break; }
  }
  let base: [number, number, number] = [255, 255, 255];
  for (const [r, g, b, a] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
  const fg = parse(getComputedStyle(el).color);
  if (!fg) return null;
  const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0); };
  const [l1, l2] = [lum(fg.slice(0, 3)), lum(base)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}, selector);

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
  for (const count of [23, 120]) {
    test(`split view at ${String(viewport.width)}×${String(viewport.height)} with ${String(count)} processes: ≥9 full rows, independent scroll, one log scroll`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      const state = await api(page, count);
      await page.goto('/applications');
      await expect(rowOf(page, 'billing-api')).toBeVisible();
      await expect(page.getByText('Оберіть застосунок, щоб переглянути деталі.')).toBeVisible();
      await expect(page.getByText(`На цій сторінці: ${String(Math.min(count, PAGE))}`)).toBeVisible();
      if (count > PAGE) await expect(page.getByRole('button', { name: 'Наступна сторінка' })).toBeVisible();

      const geo = await listGeometry(page);
      expect(geo?.visible ?? 0).toBeGreaterThanOrEqual(9);
      // Main list text is at least 14 px (review P2); secondary lines may be smaller.
      const type = await listTypography(page);
      expect(type.name.length).toBeGreaterThan(0);
      for (const size of [...type.name, ...type.metric]) expect(size).toBeGreaterThanOrEqual(14);
      for (const size of type.sub) expect(size).toBeGreaterThanOrEqual(12);
      expect(type.nameLines).toBe(1);
      expect(type.nameEllipsis).toBe(true);
      // Every column, including the short uptime, is shown in the split list.
      await expect(rowOf(page, 'billing-api').locator('.app-list__uptime')).toBeVisible();
      for (const h of geo?.heights ?? []) { expect(h).toBeGreaterThanOrEqual(48); expect(h).toBeLessThanOrEqual(56); }
      // The page itself does not scroll: list and details each scroll inside the viewport height.
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
      await noOverflow(page);

      // Selecting changes no row height; the details appear on the right.
      await rowOf(page, 'orders-api').click();
      const panel = panelOf(page, 'orders-api');
      await expect(panel).toBeVisible();
      expect((await listGeometry(page))?.heights).toEqual(geo?.heights);
      const [listBox, panelBox] = await Promise.all([page.locator('.workspace__list').boundingBox(), page.locator('.workspace__detail').boundingBox()]);
      expect(listBox && panelBox && panelBox.x > listBox.x + listBox.width - 1).toBe(true);
      const ratio = listBox && panelBox ? listBox.width / (listBox.width + panelBox.width) : 0;
      expect(ratio).toBeGreaterThan(0.53);
      expect(ratio).toBeLessThan(0.59);

      if (count > 23) {
        // Scrolling the list moves neither the page nor the details.
        const before = await panel.boundingBox();
        await page.locator('.app-list__rows').evaluate((el) => { el.scrollTop = el.scrollHeight; });
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        expect(await panel.boundingBox()).toEqual(before);
        // Next page keeps the selection (now on another page).
        await page.getByRole('button', { name: 'Наступна сторінка' }).click();
        await expect(rowOf(page, 'svc-050')).toBeVisible();
        // Pager and summary keep their own space (never covered by the list).
        const [bar, head] = await Promise.all([page.locator('.workspace__bar').boundingBox(), page.locator('.app-list').boundingBox()]);
        expect(bar && head && bar.y + bar.height <= head.y + 0.5).toBe(true);
        expect((await listGeometry(page))?.visible ?? 0).toBeGreaterThanOrEqual(9);
        await expect(panel.getByText(/не на поточній сторінці списку/)).toBeVisible();
        await page.getByRole('button', { name: 'На першу сторінку' }).click();
        await expect(rowOf(page, 'orders-api')).toHaveAttribute('aria-current', 'true');
      }

      // Logs: read only now; the log text is the only vertical scroll of the pane.
      expect(state.reads.some((r) => r.includes('/log-requests'))).toBe(false);
      await panel.getByRole('tab', { name: 'Логи' }).click();
      const log = panel.locator('.log-text');
      await expect(log).toContainText('GET /api/orders/99 200');
      const scroll = await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.workspace__detail .app-detail');
        const pre = document.querySelector<HTMLElement>('.log-text');
        return { pane: pane ? pane.scrollHeight - pane.clientHeight : -1, pre: pre ? pre.scrollHeight - pre.clientHeight : -1, preH: pre?.clientHeight ?? 0 };
      });
      expect(scroll.pane).toBeLessThanOrEqual(1);
      expect(scroll.pre).toBeGreaterThan(0);
      expect(scroll.preH).toBeGreaterThan(150);
      // The log starts at its end (newest lines).
      expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
      await noOverflow(page);
      if (shots) await page.screenshot({ path: `${shots}/apps-split-logs-${String(viewport.width)}-${String(count)}.png` });
      expect(state.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`states and contrast at 1440px, ${scheme}: running, stopped, errored, offline; selected row`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await api(page);
    await page.goto('/applications');
    await expect(rowOf(page, 'billing-api').getByText('Працює')).toBeVisible();
    await expect(rowOf(page, 'export-worker').getByText('Зупинено')).toHaveClass(/status--warn/);
    await expect(rowOf(page, 'reports-worker').getByText('Помилка')).toHaveClass(/status--bad/);
    await expect(rowOf(page, 'orders-api', 'backup-server').getByText(/⚠ сервер офлайн/)).toBeVisible();
    await expect(rowOf(page, 'export-worker').locator('.app-row__metric').first()).toHaveText('—');
    await rowOf(page, 'export-worker').click();
    const stopped = panelOf(page, 'export-worker');
    await expect(stopped.getByText('Зупинено')).toBeVisible();
    for (const sel of ['.app-row--selected .app-row__name', '.app-row--selected .app-row__sub', '.app-row:not(.app-row--selected) .app-row__name',
      '.app-row .status--warn', '.app-row .status--bad', '.app-row__stale', '.app-detail__name', '.app-metrics dt']) {
      const ratio = await contrastOf(page, sel);
      expect(ratio, `${sel} contrast`).not.toBeNull();
      expect(ratio ?? 0, `${sel} contrast`).toBeGreaterThanOrEqual(4.5);
    }
    if (shots) await page.screenshot({ path: `${shots}/apps-stopped-1440-${scheme}.png` });
    await rowOf(page, 'orders-api', 'backup-server').click();
    const offline = panelOf(page, 'orders-api', 'backup-server');
    await expect(offline.getByText(/⚠ Останні відомі значення \(сервер офлайн\), зібрано/)).toBeVisible();
    await expect(offline.getByText(/Сервер не онлайн — керування недоступне/).first()).toBeVisible();
    await offline.getByRole('tab', { name: 'Логи' }).click();
    await expect(offline.getByText('Агент не на зв’язку — логи недоступні.')).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/apps-offline-1440-${scheme}.png` });
    await noOverflow(page);
  });
}

test('same name and PM2 id on two servers; selection outside the filter stays; reset; a confirmed restart sends one POST', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await api(page);
  await page.goto('/applications');
  await rowOf(page, 'orders-api').click();
  const panel = panelOf(page, 'orders-api');
  await expect(panel.locator('.app-detail__meta')).toContainText('app-server');
  await rowOf(page, 'orders-api', 'backup-server').click();
  await expect(panel).toHaveCount(0);
  await expect(panelOf(page, 'orders-api', 'backup-server')).toBeVisible();
  await rowOf(page, 'orders-api').click();

  await page.getByLabel('Сервер', { exact: true }).selectOption(B);
  await expect(rowOf(page, 'billing-api')).toHaveCount(0);
  await expect(panel.getByText(/не відповідає поточним фільтрам/)).toBeVisible();
  expect(state.reads).toContain(`GET /api/servers/${A}/applications`);
  expect(state.reads).not.toContain(`GET /api/servers/${B}/applications`);
  await page.getByRole('button', { name: 'Скинути фільтри' }).click();
  await expect(page).toHaveURL(/\/applications$/);
  await expect(rowOf(page, 'orders-api')).toHaveAttribute('aria-current', 'true');

  await panel.getByRole('button', { name: 'Перезапустити' }).dblclick();
  const dialog = page.getByRole('dialog', { name: 'Перезапустити процес?' });
  await expect(dialog).toContainText('«orders-api» (orders-api) на сервері «app-server»');
  await dialog.getByRole('button', { name: 'Перезапустити' }).click();
  await expect(page.getByRole('status').filter({ hasText: /«orders-api» на сервері «app-server»: У черзі/ })).toBeVisible();
  expect(state.mutations).toHaveLength(1);
  expect(state.mutations[0]).toMatch(new RegExp(`^POST /api/servers/${A}/control-commands \\{"targetKey":"orders-api","action":"restart","idempotencyKey":"[0-9a-f-]{36}"\\}$`));
});

test('keyboard: Tab to a row, Enter selects (focus stays), tabs with arrows, Escape runs nothing, close returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await api(page);
  await page.goto('/applications');
  const row = rowOf(page, LONG);
  await page.getByLabel('Статус процесу').focus();
  // Tab from the filters reaches the rows (reset button only appears with filters).
  while (!(await row.evaluate((el) => el === document.activeElement))) await page.keyboard.press('Tab');
  await expect(row).toBeFocused();
  expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none'); // visible focus
  await page.keyboard.press('Enter');
  const panel = panelOf(page, LONG);
  await expect(panel).toBeVisible();
  await expect(row).toBeFocused();
  // The truncated name is complete in the accessible name, the tooltip and the details heading.
  await expect(row).toHaveAttribute('title', LONG);
  await expect(panel.getByRole('heading', { name: LONG })).toBeVisible();
  await panel.getByRole('tab', { name: 'Огляд' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(panel.getByRole('tab', { name: 'Історія дій' })).toBeFocused();
  await expect(panel.getByText('Команд для цієї цілі ще не було.')).toBeVisible();
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'Перезапустити' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Закрити деталі' }).click();
  await expect(panel).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press('Space');
  await expect(panel).toBeVisible();
  expect(state.mutations).toEqual([]);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 1279, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 720, height: 450 }]) {
  for (const scheme of ['light', 'dark'] as const) {
    if (scheme === 'dark' && viewport.width !== 390) continue;
    test(`${String(viewport.width)}px, ${scheme}: ${viewport.width >= 1280 ? 'split view' : 'separate views; back keeps filters and scroll'}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const errors: string[] = [];
      page.on('pageerror', (e) => { errors.push(e.message); });
      await api(page, 120);
      await page.goto('/applications?status=online');
      await expect(rowOf(page, 'billing-api')).toBeVisible();
      await noOverflow(page);
      if (viewport.width >= 1280) {
        await expect(page.getByText('Оберіть застосунок, щоб переглянути деталі.')).toBeVisible();
        return;
      }
      await expect(page.getByText('Оберіть застосунок, щоб переглянути деталі.')).toHaveCount(0);
      const geo = await listGeometry(page);
      for (const h of geo?.heights ?? []) { expect(h).toBeGreaterThanOrEqual(48); expect(h).toBeLessThanOrEqual(56); }
      // Full-width list.
      const [list, content] = await Promise.all([page.locator('.app-list').boundingBox(), page.locator('.page').boundingBox()]);
      expect(list && content && Math.abs(list.width - content.width) <= 1).toBe(true);
      if (viewport.width <= 470) await expect(page.locator('.app-list__head')).toBeHidden(); // compact rows, no table head
      const type = await listTypography(page);
      for (const size of [...type.name, ...type.metric]) expect(size).toBeGreaterThanOrEqual(14);
      expect(type.metric.length).toBeGreaterThan(0);
      expect(type.compactFits).toBe(true);
      expect(type.nameLines).toBe(1);
      if (shots) await page.screenshot({ path: `${shots}/apps-list-${String(viewport.width)}-${scheme}.png` });

      const target = rowOf(page, 'svc-030');
      await target.scrollIntoViewIfNeeded();
      const scrolled = await page.evaluate(() => window.scrollY);
      expect(scrolled).toBeGreaterThan(0);
      await target.click();
      const panel = panelOf(page, 'svc-030');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'svc-030' })).toBeFocused();
      await expect(rowOf(page, 'billing-api')).toHaveCount(0);
      await noOverflow(page);
      await panel.getByRole('tab', { name: 'Логи' }).click();
      await expect(panel.getByText(/Логи цього процесу не дозволені|allowlist|Оновити/).first()).toBeVisible();
      await noOverflow(page);
      if (shots) await page.screenshot({ path: `${shots}/apps-detail-${String(viewport.width)}-${scheme}.png`, fullPage: true });
      await panel.getByRole('button', { name: '← Назад до списку' }).click();
      await expect(panel).toHaveCount(0);
      await expect(page).toHaveURL(/\?status=online$/);
      await expect(page.getByLabel('Статус процесу')).toHaveValue('online');
      await expect(target).toBeFocused();
      await expect(target).toHaveAttribute('aria-current', 'true');
      expect(Math.abs(await page.evaluate(() => window.scrollY) - scrolled)).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    });
  }
}

async function touchPage(browser: Browser, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, locale: 'uk-UA', baseURL: 'http://127.0.0.1:4175' });
  return { context, page: await context.newPage() };
}

for (const width of [1440, 390]) {
  test(`touch at ${String(width)}px: controls are 44 px, rows stay 48–56 px, tap selects`, async ({ browser }) => {
    const { context, page } = await touchPage(browser, width);
    try {
      await api(page);
      await page.goto('/applications');
      const row = rowOf(page, 'orders-api');
      await expect(row).toBeVisible();
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches || window.innerWidth <= 760)).toBe(true);
      const geo = await listGeometry(page);
      for (const h of geo?.heights ?? []) { expect(h).toBeGreaterThanOrEqual(48); expect(h).toBeLessThanOrEqual(56); }
      await row.tap();
      const panel = panelOf(page, 'orders-api');
      await expect(panel).toBeVisible();
      const heights = await panel.evaluate((el) => [...el.querySelectorAll<HTMLElement>('.button, .action-menu__trigger, [role="tab"]')]
        .filter((b) => b.offsetParent !== null).map((b) => Math.round(b.getBoundingClientRect().height)));
      expect(heights.length).toBeGreaterThan(0);
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
      await noOverflow(page);
      if (shots) await page.screenshot({ path: `${shots}/apps-touch-${String(width)}.png` });
    } finally {
      await context.close();
    }
  });
}

test('logs: after a successful read, an ambiguous 404 removes the old text from the page (review P1); a manual refresh adds nothing back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await api(page);
  await page.goto('/applications');
  await rowOf(page, 'orders-api').click();
  const panel = panelOf(page, 'orders-api');
  await panel.getByRole('tab', { name: 'Логи' }).click();
  await expect(panel.locator('.log-text')).toContainText('GET /api/orders/99 200');
  state.logGone = true;
  await panel.getByRole('button', { name: 'Оновити' }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(page.locator('.log-text')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText.includes('/api/orders/'))).toBe(false);
  await expect(panel.getByRole('alert')).toContainText('Запит або ресурс логів недоступний');
  await expect(panel.getByRole('checkbox', { name: /Оновлювати кожні 5 с/ })).not.toBeChecked();
  await expect(panel.getByText(/Показано попередній результат/)).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/apps-logs-404.png` });
  await panel.getByRole('button', { name: 'Оновити' }).click();
  await expect(panel.getByRole('alert')).toContainText('Запит або ресурс логів недоступний');
  expect(await page.evaluate(() => document.body.innerText.includes('/api/orders/'))).toBe(false);
  expect(state.mutations).toEqual([]);
});
