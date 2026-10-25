import { expect, type Page, test } from '@playwright/test';

// Review 73bfd84, E2E inventory.spec:85: when the server's clock is behind the browser's (the test DB VM had drifted
// by more than the 30 min E2E session TTL) a valid session looks expired to the browser. The expiry re-check then
// ran every ~1 s through the «checking» state, which unmounted the private area: the Applications selection (and any
// open dialog) was lost. Synthetic API: /me always confirms the same session whose stored expiry is 90 min past by
// the browser clock. The page must stay mounted and /me must not be polled every second. Nothing is sent.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXPIRES = new Date(Date.now() - 90 * 60_000).toISOString();

async function api(page: Page) {
  const me: number[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const now = new Date(Date.now() - 10_000).toISOString();
    if (req.method() !== 'GET') { await route.fulfill({ status: 409, json: {} }); return; }
    if (p === '/api/auth/me') {
      me.push(Date.now());
      await route.fulfill({ json: { user: { id: '00000000-0000-4000-8000-000000000001', email: 'operator@example.com', role: 'operator' }, csrfToken: 'a'.repeat(43), expiresAt: EXPIRES,
        permissions: ['monitoring:read', 'processes:control', 'logs:read'] } });
      return;
    }
    const app = (pmId: number, name: string) => ({ key: `${A}:pm2:${String(pmId)}`, serverId: A, serverName: 'node-a', serverStatus: 'online', source: 'pm2', pmId, name, status: 'online',
      uptimeSeconds: 3600, restarts: 0, cpuPercent: 1, memoryBytes: 64 * 1024 ** 2, execMode: 'fork', firstSeenAt: now, inventoryState: 'current', capturedAt: now, collectedAt: now });
    if (p === '/api/applications') { await route.fulfill({ json: { items: [app(0, 'e2e-api'), app(1, 'e2e-worker')], nextCursor: null, freshWindowSeconds: 180 } }); return; }
    if (p === '/api/servers') { await route.fulfill({ json: { items: [{ id: A, name: 'node-a', isActive: true, createdAt: now, status: 'online', lastSeenAt: now, hasActiveCredential: true }], nextAfterId: null, onlineWindowSeconds: 90 } }); return; }
    if (p.endsWith('/control-commands')) { await route.fulfill({ json: { items: [] } }); return; }
    await route.fulfill({ status: 404, json: {} });
  });
  return me;
}

test('a session that is past due by the browser clock but confirmed by the server keeps the selection; /me is not polled every second', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const me = await api(page);
  await page.goto('/applications');
  const row = page.getByRole('button', { name: /^e2e-worker на / });
  await row.click();
  await expect(page.getByRole('region', { name: /^Деталі: e2e-worker на / })).toBeVisible();
  const before = me.length;
  // The expiry is due by the browser clock: a re-check of /me follows (about 1 s later). Wait for that event, then the
  // page must be the same: selection and details kept, no «Перевірка сесії» in between.
  await expect.poll(() => me.length).toBeGreaterThan(before);
  await expect(page.getByText('Перевірка сесії…')).toHaveCount(0);
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('region', { name: /^Деталі: e2e-worker на / })).toBeVisible();
  // The server confirmed a past-due session: the next re-check is a minute away, not another second.
  const confirmed = me.length;
  await expect(row).toHaveAttribute('aria-current', 'true');
  expect(confirmed - before).toBe(1);
});

// Review 217af0b: the silent re-check must treat ANOTHER session as a session change. Reproducer: session A is past due
// by the browser clock, «Вийти» is pressed and its answer held; the re-check confirms another session B; then A's
// late 204 arrives — it must not end B. Also: a new session of the same user remounts the private area.
const sessionOf = (id: string, email: string, role: 'admin' | 'viewer', csrf: string, expiresAt: string) => ({
  user: { id, email, role }, csrfToken: csrf.repeat(43), expiresAt,
  permissions: role === 'admin' ? ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] : ['monitoring:read'],
});

async function switching(page: Page, second: ReturnType<typeof sessionOf>) {
  const first = sessionOf('11111111-1111-4111-8111-111111111111', 'admin@example.test', 'admin', 'a', EXPIRES);
  let me = 0;
  let releaseLogout: () => void = () => undefined;
  const logoutHeld = new Promise<void>((r) => { releaseLogout = r; });
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (p === '/api/auth/logout') { await logoutHeld; await route.fulfill({ status: 204 }); return; }
    if (p === '/api/auth/me') { me += 1; await route.fulfill({ json: me === 1 ? first : second }); return; }
    if (p === '/api/alerts/status') { await route.fulfill({ json: { engine: { enabled: true, running: true, lastEvaluationAt: now, lastEvaluationOk: true }, delivery: { enabled: true }, activeCount: 0, admin: null } }); return; }
    if (p === '/api/alerts') { await route.fulfill({ json: { items: [], nextBefore: null } }); return; }
    await route.fulfill({ status: 404, json: {} });
  });
  return { me: () => me, releaseLogout };
}

test('a late logout of the previous session does not end the session the re-check confirmed (another user)', async ({ page }) => {
  const b = sessionOf('22222222-2222-4222-8222-222222222222', 'viewer@example.test', 'viewer', 'b', new Date(Date.now() + 3_600_000).toISOString());
  const s = await switching(page, b);
  await page.goto('/alerts');
  await expect(page.getByText('admin@example.test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await expect(page.getByText('viewer@example.test', { exact: true })).toBeVisible(); // the re-check brought B
  expect(s.me()).toBe(2);
  s.releaseLogout();
  // The held logout of A is answered now: B stays signed in.
  await expect(page.getByRole('button', { name: 'Вийти', exact: true })).toBeEnabled();
  await expect(page.getByText('viewer@example.test', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Увійти', exact: true })).toHaveCount(0);
});

test('a new session of the same user remounts the private area (unsaved input of the old session is gone)', async ({ page }) => {
  const a2 = sessionOf('11111111-1111-4111-8111-111111111111', 'admin@example.test', 'admin', 'c', new Date(Date.now() + 3_600_000).toISOString());
  const s = await switching(page, a2);
  await page.goto('/alerts');
  const search = page.getByLabel('Пошук на цій сторінці');
  await search.fill('typed in the old session');
  await expect.poll(() => s.me()).toBe(2);
  await expect(page.getByLabel('Пошук на цій сторінці')).toHaveValue('');
  await expect(page.getByText('admin@example.test', { exact: true })).toBeVisible();
});
