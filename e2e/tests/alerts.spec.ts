import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { inRunSchema } from '../support/db.js';
import { credentials, type E2eRole } from '../support/env.js';

// Alerts (Task 013) against the real backend with the engine ON (evaluation only — no webhook, so nothing is sent)
// and the isolated test DB. A synthetic server that stopped reporting is seeded into THIS run's schema; the real
// evaluator turns it into an incident. No control action, no Slack.

const DOWN = `alert-down-${randomUUID().slice(0, 6)}`;
const snapshot = { agentVersion: '0.4.0', hostname: 'alert-host', platform: 'linux', arch: 'x64', uptimeSeconds: 60, cpuCount: 1, loadAverage: [0, 0, 0], memory: { totalBytes: 1024, freeBytes: 512 } };

test.beforeAll(async () => {
  await inRunSchema(async (q) => {
    // Engine on via settings (ADR-022), short cycle; delivery stays off (no Slack in tests).
    await q('UPDATE alert_settings SET engine_enabled = true, interval_seconds = 10, revision = revision + 1 WHERE id = 1');
    const id = (await q('INSERT INTO servers (name) VALUES ($1) RETURNING id', [DOWN])).rows[0]?.id as string;
    await q("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - interval '10 minutes', $2::jsonb)", [id, JSON.stringify(snapshot)]);
  });
});

// Leave the run schema as other specs expect it (they assert an empty server list); incidents cascade.
test.afterAll(async () => {
  await inRunSchema(async (q) => {
    await q('DELETE FROM servers WHERE name = $1', [DOWN]);
    await q('UPDATE alert_settings SET engine_enabled = false, interval_seconds = 30, revision = revision + 1 WHERE id = 1');
  });
});

async function login(page: Page, role: E2eRole) {
  const { email, password } = credentials(role);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
}

test('the evaluator opens an incident for a server that stopped reporting; operator sees it without delivery details; mobile fits', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  // operator, not viewer: the viewer's per-account login budget (5 / 15 min) is used up by other specs.
  await login(page, 'operator');
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('link', { name: 'Сповіщення' }).click();
  await expect(page.getByText('Надсилання в Slack вимкнено: інциденти лише записуються.')).toBeVisible();
  const active = page.getByRole('region', { name: /Активні проблеми/ });
  await expect(async () => {
    await page.reload();
    await expect(active.getByRole('row').filter({ hasText: DOWN })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 40_000 });
  const row = active.getByRole('row').filter({ hasText: DOWN });
  await expect(row).toContainText('Сервер не звітує');
  await expect(row).toContainText('Критично');
  await expect(active.getByRole('columnheader', { name: 'Сповіщення' })).toHaveCount(0);
  const api = await page.evaluate(async () => (await fetch('/api/alerts/status', { credentials: 'same-origin' })).json() as Promise<{ engine: { enabled: boolean }; admin: unknown }>);
  expect(api.engine.enabled).toBe(true);
  expect(api.admin).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const stored = await inRunSchema(async (q) => (await q("SELECT count(*)::int AS n FROM alert_incidents WHERE server_name = $1 AND status = 'firing'", [DOWN])).rows[0]);
  expect(stored).toEqual({ n: 1 });
  const outbox = await inRunSchema(async (q) => (await q('SELECT count(*)::int AS n FROM alert_outbox')).rows[0]);
  expect(outbox).toEqual({ n: 0 }); // delivery disabled: nothing queued for Slack
  await context.close();
});
