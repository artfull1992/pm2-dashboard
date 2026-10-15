import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { hashPassword } from '../../backend/src/auth/password.js';
import { inRunSchema } from '../support/db.js';

// Rollback compatibility release (ADR-023) in a real browser against the compiled backend and the isolated test DB:
// rows exactly as the ADR-023 release leaves them (minimal snapshots, an incident closed as "retired") must render
// without error states — and without any new heartbeat (offline/minimal rows stay as they are).

const USER = { email: `rollback-viewer-${randomBytes(4).toString('hex')}@example.test`, password: `e2e-${randomBytes(12).toString('base64url')}` };
const ONLINE = `rb-online-${randomUUID().slice(0, 6)}`;
const OFFLINE = `rb-offline-${randomUUID().slice(0, 6)}`;
const minimal = { agentVersion: '0.5.0', hostname: 'rb-host', platform: 'linux', arch: 'x64', loadAverage: [0.42, 0.3, 0.2] };
let onlineId = '';

test.beforeAll(async () => {
  const hash = await hashPassword(USER.password);
  await inRunSchema(async (q) => {
    await q("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'viewer')", [USER.email, hash]);
    onlineId = (await q('INSERT INTO servers (name) VALUES ($1) RETURNING id', [ONLINE])).rows[0]?.id as string;
    const offline = (await q('INSERT INTO servers (name) VALUES ($1) RETURNING id', [OFFLINE])).rows[0]?.id as string;
    await q("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() + interval '1 hour', $2::jsonb)", [onlineId, JSON.stringify(minimal)]);
    await q("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() - interval '1 hour', $2::jsonb)", [offline, JSON.stringify(minimal)]);
    await q(`INSERT INTO alert_incidents (condition_key, server_id, rule, severity, status, resolution, server_name, detail, notify, opened_at, last_observed_at, resolved_at)
             VALUES ($1, $2, 'server_memory', 'warning', 'resolved', 'retired', $3, '{"value": 95, "threshold": 90}', true, now() - interval '2 hours', now() - interval '1 hour', now() - interval '1 hour')`,
    [`server_memory:${onlineId}`, onlineId, ONLINE]);
  });
});

test('viewer: dashboard, server page and alert history render ADR-023 data without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => { errors.push(e.message); });
  await page.goto('/');
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Пароль', { exact: true }).fill(USER.password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: ONLINE });
  await expect(row).toContainText('0.42 / 0.30 / 0.20');
  await expect(row).toContainText('—'); // memory unknown, not 0 %
  await expect(page.getByText(/Не вдалося/)).toHaveCount(0);

  await page.goto(`/servers/${onlineId}`);
  await expect(page.getByRole('heading', { name: ONLINE })).toBeVisible();
  await expect(page.getByText('обсяг невідомий')).toBeVisible();
  await expect(page.getByText(/Не вдалося/)).toHaveCount(0);

  await page.goto('/alerts');
  const history = page.getByRole('region', { name: 'Закриті інциденти' });
  await expect(history.getByText('Правило виведено з експлуатації (не відновлення)')).toBeVisible();
  await expect(page.getByText(/Не вдалося/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
