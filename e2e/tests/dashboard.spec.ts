import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { inRunSchema } from '../support/db.js';
import { credentials, type E2eRole } from '../support/env.js';

// Dashboard (Task 012) against the real backend and the isolated test DB. Synthetic servers/inventory/commands are
// seeded into THIS run's schema only; no control action is executed. Other specs add servers too, so only the
// seeded rows are asserted, not global totals (exact totals are covered by backend/test/db/dashboard.test.ts).

const ONLINE = `dash-online-${randomUUID().slice(0, 6)}`;
const OFFLINE = `dash-offline-${randomUUID().slice(0, 6)}`;
// A row as written by a 0.4.x Agent (legacy host metrics in JSONB): must still read fine, without showing them (ADR-023).
const snapshot = { agentVersion: '0.4.0', hostname: 'dash-host', platform: 'linux', arch: 'x64', uptimeSeconds: 7200, cpuCount: 2, loadAverage: [0.42, 0.3, 0.2], memory: { totalBytes: 4 * 1024 ** 3, freeBytes: 1024 ** 3 } };

test.beforeAll(async () => {
  await inRunSchema(async (q) => {
    const online = (await q('INSERT INTO servers (name) VALUES ($1) RETURNING id', [ONLINE])).rows[0]?.id as string;
    const offline = (await q('INSERT INTO servers (name) VALUES ($1) RETURNING id', [OFFLINE])).rows[0]?.id as string;
    await q('INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() + interval \'1 hour\', $2::jsonb)', [online, JSON.stringify(snapshot)]);
    await q("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - interval '10 minutes', $2::jsonb)", [offline, JSON.stringify(snapshot)]);
    // Collected "in the future" keeps the inventory current for the whole test run.
    await q(`INSERT INTO server_inventories (server_id, source, state, reported_at, report_captured_at, inventory_captured_at, inventory_collected_at, process_count)
             VALUES ($1, 'pm2', 'ok', now(), now(), now() + interval '1 hour', now() + interval '1 hour', 2)`, [online]);
    await q("INSERT INTO server_applications (server_id, source, pm_id, name, status, restarts, first_seen_at) VALUES ($1, 'pm2', 0, 'dash-api', 'online', 0, now()), ($1, 'pm2', 1, 'dash-worker', 'errored', 9, now())", [online]);
    const operator = (await q('SELECT id FROM users WHERE email = $1', [credentials('operator').email])).rows[0]?.id as string;
    await q(`INSERT INTO control_commands (server_id, target_key, action, status, requested_by, idempotency_key, requested_at, deadline_at, completed_at)
             VALUES ($1, 'dash-api', 'restart', 'succeeded', $2, $3, now(), now() + interval '2 minutes', now())`, [online, operator, randomUUID()]);
  });
});

/** Opt-in review screenshots (synthetic data only; off unless NC_E2E_SCREENSHOT_DIR is set). */
async function shot(page: Page, name: string) {
  const dir = process.env.NC_E2E_SCREENSHOT_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

async function login(page: Page, role: E2eRole) {
  const { email, password } = credentials(role);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
}

test('operator: seeded servers appear with live metrics and attention; recent actions shown; links open the server and applications', async ({ page }) => {
  await login(page, 'operator');
  const attention = page.getByRole('region', { name: 'Потребують уваги' });
  await expect(attention.getByRole('link', { name: OFFLINE })).toBeVisible();
  await expect(attention.getByText(/Агент не звітує \(офлайн\)/).first()).toBeVisible();
  await expect(attention.getByText('dash-worker')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: ONLINE });
  await expect(row).toContainText('0.42 / 0.30 / 0.20');
  await expect(row).toContainText('1 з 2 працюють');
  await expect(row).not.toContainText('ГіБ'); // legacy memory values are never shown
  await expect(page.getByRole('columnheader', { name: /Пам.ять ОС|Uptime/ })).toHaveCount(0);
  const offlineRow = page.getByRole('row').filter({ hasText: OFFLINE });
  await expect(offlineRow).not.toContainText('dash-host'); // no metrics of an offline server
  const actions = page.getByRole('region', { name: 'Останні керуючі дії' });
  await expect(actions.getByText(/Перезапустити/).first()).toBeVisible();
  await expect(actions.getByText(/ви$/).first()).toBeVisible();
  await shot(page, 'dashboard-desktop-operator');
  await page.getByRole('link', { name: 'Усі застосунки →' }).click();
  await expect(page.getByRole('heading', { name: 'Застосунки' })).toBeVisible();
  await page.goto('/');
  await attention.getByRole('link', { name: OFFLINE }).click();
  await expect(page.getByRole('heading', { name: OFFLINE })).toBeVisible();
});

test('viewer: no recent-action details (UI and API), mobile 390 px without horizontal scroll', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page, 'viewer');
  await expect(page.getByText('Потребують уваги')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Останні керуючі дії' })).toHaveCount(0);
  const api = await page.evaluate(async () => (await fetch('/api/dashboard', { credentials: 'same-origin' })).json() as Promise<{ recentActions: unknown }>);
  expect(api.recentActions).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await shot(page, 'dashboard-mobile-viewer');
  await context.close();
});
