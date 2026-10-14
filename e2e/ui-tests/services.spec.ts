import { expect, test } from '@playwright/test';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = '2026-10-13T13:42:00.000Z';
const logId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const names = ['catalog-api', 'billing-api', 'orders-api', 'public-api', 'orders-api-v2'];

for (const viewport of [{ width: 1440, height: 1050 }, { width: 390, height: 844 }]) {
  test(`service actions and confirmation at ${String(viewport.width)}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    const commands: unknown[] = [];
    page.on('pageerror', (error) => { errors.push(error.message); });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown;
      if (path === '/api/auth/me') data = {
        user: { id, email: 'operator@example.test', role: 'operator' },
        permissions: ['monitoring:read', 'processes:control', 'logs:read'], csrfToken: 'a'.repeat(43),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      else if (path === `/api/servers/${id}`) data = {
        id, name: 'app-server', status: 'online', isActive: true, createdAt: now, lastSeenAt: now, hasActiveCredential: true, snapshot: null,
      };
      else if (path.endsWith('/applications')) data = {
        serverId: id, serverStatus: 'online', freshWindowSeconds: 180,
        inventory: { state: 'current', source: 'pm2', reason: null, capturedAt: now, collectedAt: now, reportedAt: now, processCount: 5 },
        items: names.map((name, pmId) => ({
          key: `${id}:pm2:${String(pmId)}`, serverId: id, serverName: 'app-server', serverStatus: 'online', source: 'pm2', pmId, name,
          status: 'online', uptimeSeconds: 608460, restarts: 0, cpuPercent: .1, memoryBytes: 68 * 1024 ** 2, execMode: 'fork',
          firstSeenAt: now, inventoryState: 'current', capturedAt: now, collectedAt: now,
        })),
      };
      else if (path.endsWith('/control')) data = {
        serverId: id, enabled: true, serverStatus: 'online', targetFreshSeconds: 60,
        broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: true },
        targets: names.map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok', actions: ['start', 'stop', 'restart'] })),
      };
      else if (path.endsWith('/log-targets')) data = {
        serverId: id, state: 'supported', reportedAt: now, targets: names.map((name, pmId) => ({ targetKey: name, name, pmId, matchStatus: 'ok' })),
      };
      else if (path.endsWith('/log-requests')) { await route.fulfill({ status: 202, json: { requestId: logId, deadlineAt: new Date(Date.now() + 15000).toISOString() } }); return; }
      else if (path === `/api/log-requests/${logId}`) {
        const text = Array.from({ length: 100 }, (_, i) => `2026-10-14T10:00:${String(i % 60).padStart(2, '0')}Z GET /api/items/${String(i)} 200 ${'payload '.repeat(12)}`).join('\n');
        data = { requestId: logId, serverId: id, targetKey: 'orders-api-v2', status: 'done', deadlineAt: now, result: {
          outcome: 'ok', reason: null, readAt: now,
          stdout: { state: 'ok', text, lines: 100, truncated: true, sizeBytes: 900000, modifiedAt: now },
          stderr: { state: 'empty', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: now },
        } };
      }
      else if (path.endsWith('/control-commands')) {
        if (route.request().method() === 'POST') commands.push(route.request().postDataJSON());
        data = { items: [] };
      }
      else { await route.fulfill({ status: 404, json: {} }); return; }
      await route.fulfill({ status: 200, json: data });
    });
    await page.goto(`/servers/${id}`);
    await expect(page.getByRole('heading', { name: 'Сервіси сервера' })).toBeVisible();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(6);
    const trigger = page.getByRole('button', { name: 'Дії: orders-api-v2' });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const restart = page.getByRole('button', { name: 'Перезапустити', exact: true });
    await expect(restart).toBeVisible();
    await restart.click();
    const dialog = page.getByRole('dialog', { name: 'Перезапустити процес?' });
    await expect(dialog).toContainText('orders-api-v2');
    await page.getByRole('button', { name: 'Скасувати' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(commands).toEqual([]);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // Log viewer from the same row menu: readable, scrollable, no page overflow, Escape closes, focus returns.
    await trigger.click();
    await page.getByRole('button', { name: 'Переглянути логи' }).click();
    const logs = page.getByRole('dialog', { name: 'Логи: orders-api-v2' });
    await expect(logs.getByText(/GET \/api\/items\/99 200/)).toBeVisible();
    await expect(logs.getByText(/старіші рядки не показано/)).toBeVisible();
    await logs.getByRole('tab', { name: 'stderr' }).click();
    await expect(logs.getByText('Лог порожній.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width === 390) await page.screenshot({ path: test.info().outputPath('logs-390.png') });
    await page.keyboard.press('Escape');
    await expect(logs).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(commands).toEqual([]);
    if (viewport.width === 1440) await page.screenshot({ path: test.info().outputPath('services-1440.png'), fullPage: true });
  });
}
