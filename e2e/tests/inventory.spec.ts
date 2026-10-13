import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { startAgent } from '../support/agent.js';
import { inRunSchema } from '../support/db.js';
import { credentials, type E2eRole } from '../support/env.js';

// Task 008 E2E: real backend + frontend + compiled Agent reading a SYNTHETIC, isolated exporter snapshot.
// No PM2 daemon and no production processes are involved (the real-daemon check is `npm run test:agent:pm2`).

const XSS = '<img src=x onerror="window.__pwned=1">';

async function login(page: Page, role: E2eRole) {
  const { email, password } = credentials(role);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
}

const proc = (pmId: number, name: string, status: string) => ({
  pmId, name, status, uptimeSeconds: status === 'online' ? 3600 : null, restarts: 1,
  cpuPercent: status === 'online' ? 3.5 : null, memoryBytes: status === 'online' ? 64 * 1024 ** 2 : null, execMode: 'fork',
});

function writeSnapshot(file: string, body: Record<string, unknown>) {
  writeFileSync(file, `${JSON.stringify({ format: 'goit-node-control/pm2-inventory', version: 1, source: 'pm2', capturedAt: new Date().toISOString(), ...body })}\n`, { mode: 0o640 });
  chmodSync(file, 0o640);
}

test('Agent reports a PM2 inventory; Applications shows it; unavailable keeps the last data, labelled', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await login(page, 'admin');
  await page.getByRole('link', { name: 'Сервери' }).click();
  await page.getByLabel('Назва нового сервера').fill('e2e-pm2');
  await page.getByRole('button', { name: 'Додати сервер' }).click();
  await page.getByRole('link', { name: 'e2e-pm2' }).click();
  await expect(page.getByText(/ще не передавав inventory/)).toBeVisible();
  await page.getByRole('button', { name: 'Видати ключ' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ключ агента видано' });
  const token = await dialog.getByRole('textbox').inputValue();
  await dialog.getByRole('button', { name: /закрити/ }).click();
  const serverUrl = page.url();
  const serverId = new URL(serverUrl).pathname.split('/').at(-1) ?? '';

  const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-pm2-'));
  chmodSync(dir, 0o750);
  const file = join(dir, 'inventory.json');
  writeSnapshot(file, { state: 'ok', reason: null, processes: [proc(0, 'e2e-api', 'online'), proc(1, 'e2e-worker', 'stopped'), proc(2, XSS, 'errored')] });
  const inventoryEnv = { NC_AGENT_INVENTORY_FILE: file, NC_AGENT_INVENTORY_ALLOW_SAME_OWNER: 'true', NC_AGENT_INVENTORY_INTERVAL_SECONDS: '30' };
  let agent = startAgent(token, inventoryEnv);
  try {
    await page.goto('/applications');
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('cell', { name: 'e2e-api' }).or(page.getByRole('rowheader', { name: 'e2e-api' }))).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const table = page.getByRole('table', { name: 'PM2-процеси' });
    await expect(table.getByText(XSS)).toBeVisible();
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(table.getByText('Актуально').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /перезап|зупин|запуст|restart|stop/i })).toHaveCount(0);

    // Filter by status keeps only the stopped process.
    await page.getByLabel('Статус процесу').selectOption('stopped');
    await expect(table.getByText('e2e-worker')).toBeVisible();
    await expect(table.getByText('e2e-api')).toHaveCount(0);

    await page.goto(serverUrl);
    await expect(page.getByText(/Актуально: зібрано/)).toBeVisible();
    await expect(page.getByText('Онлайн', { exact: true })).toBeVisible();

    // Viewer reads the same inventory (monitoring:read).
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.goto('/applications');
    await expect(viewer.getByText('e2e-api')).toBeVisible();
    await viewerContext.close();

    // Exporter reports the daemon as down: the last processes stay, explicitly marked as not current.
    expect(await agent.stop()).toBe(0);
    writeSnapshot(file, { state: 'unavailable', reason: 'daemon_not_running', processes: [] });
    agent = startAgent(token, inventoryEnv);
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/Inventory недоступний: PM2 daemon не запущено/)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('table', { name: 'PM2-процеси сервера' }).getByText('Exporter недоступний').first()).toBeVisible();

    const state = await inRunSchema(async (q) => (await q(
      `SELECT i.state, i.reason, i.process_count, (SELECT count(*)::int FROM server_applications a WHERE a.server_id = i.server_id) AS apps
         FROM server_inventories i WHERE i.server_id = $1`, [serverId])).rows[0]);
    expect(state).toEqual({ state: 'unavailable', reason: 'daemon_not_running', process_count: 3, apps: 3 });
  } finally {
    const code = await agent.stop();
    expect(code).toBe(0);
    expect(agent.output()).not.toContain(token);
    expect(agent.output()).not.toContain('e2e-api');
    rmSync(dir, { recursive: true, force: true });
  }
});
