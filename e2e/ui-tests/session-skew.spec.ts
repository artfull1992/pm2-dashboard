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
