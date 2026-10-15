import { expect, test } from '@playwright/test';

// Command tracking limit in the browser, synthetic API only (no DB, no PM2): five accepted commands stay followed;
// a sixth is not offered (reason in the menu) and no POST is sent; when one command finishes, the next is accepted.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NAMES = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
const cmdId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('five running commands: the sixth waits with an explanation; a finished one frees the slot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  const posts: { targetKey: string; idempotencyKey: string }[] = [];
  const status = new Map<string, string>();
  const targetOf = new Map<string, string>();
  const reads = new Map<string, number>();
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const now = new Date().toISOString();
    const command = (id: string) => ({
      id, serverId: A, targetKey: targetOf.get(id), action: 'restart', status: status.get(id) ?? 'queued', reason: null,
      requestedBy: '00000000-0000-4000-8000-000000000001', requestedAt: now, deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      dispatchedAt: null, completedAt: null, attempts: 0, before: null, after: status.get(id) === 'succeeded' ? { status: 'online' } : null,
    });
    let data: unknown;
    if (path === '/api/auth/me') {
      data = { user: { id: '00000000-0000-4000-8000-000000000001', email: 'operator@example.com', role: 'operator' }, csrfToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: ['monitoring:read', 'processes:control', 'logs:read'] };
    } else if (path === '/api/servers') {
      data = { items: [{ id: A, name: 'app-server', isActive: true, createdAt: now, status: 'online', lastSeenAt: now, hasActiveCredential: true }], nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/applications') {
      data = { items: NAMES.map((name, pmId) => ({
        key: `${A}:pm2:${String(pmId)}`, serverId: A, serverName: 'app-server', serverStatus: 'online', source: 'pm2', pmId, name, status: 'online',
        uptimeSeconds: 100, restarts: 0, cpuPercent: 1, memoryBytes: 1024 ** 2, execMode: 'fork', firstSeenAt: now, inventoryState: 'current', capturedAt: now, collectedAt: now,
      })), nextCursor: null, freshWindowSeconds: 180 };
    } else if (path === `/api/servers/${A}/control`) {
      data = { serverId: A, enabled: true, serverStatus: 'online', targetFreshSeconds: 60, broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: true },
        targets: NAMES.map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok', actions: ['restart'] })) };
    } else if (path === `/api/servers/${A}/log-targets`) {
      data = { serverId: A, state: 'supported', reportedAt: now, targets: [] };
    } else if (path === `/api/servers/${A}/control-commands` && req.method() === 'POST') {
      const body = req.postDataJSON() as { targetKey: string; idempotencyKey: string };
      posts.push(body);
      const id = cmdId(posts.length);
      targetOf.set(id, body.targetKey);
      await route.fulfill({ status: 201, json: command(id) });
      return;
    } else if (path.startsWith('/api/control-commands/')) {
      const id = path.split('/').at(-1) ?? '';
      reads.set(id, (reads.get(id) ?? 0) + 1);
      data = command(id);
    } else { await route.fulfill({ status: 404, json: {} }); return; }
    await route.fulfill({ status: 200, json: data });
  });

  await page.goto('/applications');
  const restart = async (name: string) => {
    await page.getByRole('button', { name: `Дії: ${name} на app-server` }).click();
    await page.getByRole('menuitem', { name: 'Перезапустити' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Перезапустити' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  for (const name of NAMES.slice(0, 5)) await restart(name);
  await expect(page.getByRole('status').filter({ hasText: /: У черзі/ })).toHaveCount(5);

  // The sixth: control item disabled, the reason is shown, nothing is sent.
  await page.getByRole('button', { name: 'Дії: p5 на app-server' }).click();
  await expect(page.getByRole('menuitem', { name: 'Перезапустити' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.action-menu__popup')).toContainText('Уже виконується 5 команд');
  await page.getByRole('menuitem', { name: 'Перезапустити' }).click({ force: true }); // a disabled item does nothing
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(posts).toHaveLength(5);

  // The first command is still followed, and stays listed.
  const firstReads = reads.get(cmdId(1)) ?? 0;
  await page.clock.runFor(4_500);
  expect(reads.get(cmdId(1)) ?? 0).toBeGreaterThan(firstReads);
  await expect(page.getByRole('status').filter({ hasText: '«p0»' })).toHaveCount(1);

  // p0 finishes → the slot is free → p5 is accepted.
  status.set(cmdId(1), 'succeeded');
  await page.clock.runFor(2_500);
  await expect(page.getByRole('status').filter({ hasText: /«p0».*Виконано й підтверджено/ })).toHaveCount(1);
  await restart('p5');
  expect(posts.map((p) => p.targetKey)).toEqual(NAMES);
  expect(new Set(posts.map((p) => p.idempotencyKey)).size).toBe(6);
  await expect(page.getByRole('status').filter({ hasText: /: У черзі/ })).toHaveCount(5);
  await expect(page.getByRole('status').filter({ hasText: '«p0»' })).toHaveCount(1);
});
