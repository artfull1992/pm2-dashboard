import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { hashPassword } from '../../backend/src/auth/password.js';
import { inRunSchema } from '../support/db.js';

// Admin settings (Task 013.1) against the real backend and the isolated test DB. Dedicated admin/operator users are
// inserted into THIS run's schema (the shared users' login budgets are used by other specs). The webhook is synthetic
// and the test button is NOT clicked here: the spawned backend would contact Slack — test messages are covered with a
// mock transport in backend/frontend tests. No real Slack request is made.

const pw = () => `e2e-${randomBytes(12).toString('base64url')}`;
const ADMIN = { email: `settings-admin-${randomBytes(4).toString('hex')}@example.test`, password: pw() };
const OPERATOR = { email: `settings-op-${randomBytes(4).toString('hex')}@example.test`, password: pw() };
const SECRET_PART = randomBytes(12).toString('hex');
const WEBHOOK = `https://hooks.slack.com/services/T0E2E0001/B0E2E0001/${SECRET_PART}`;

test.beforeAll(async () => {
  for (const [u, role] of [[ADMIN, 'admin'], [OPERATOR, 'operator']] as const) {
    const hash = await hashPassword(u.password);
    await inRunSchema((q) => q('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)', [u.email, hash, role]));
  }
});

async function signIn(page: Page, u: { email: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Пароль', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
}
const newPage = async (browser: Browser, width = 1440) => (await browser.newContext({ viewport: { width, height: 900 } })).newPage();

test('admin saves a Slack webhook (write-only, encrypted) and alert rules; operator is denied', async ({ browser }) => {
  const page = await newPage(browser);
  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Налаштування' }).click();
  await expect(page.getByText('Не налаштовано')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Надіслати тестове повідомлення' })).toBeDisabled();
  await page.getByLabel('Webhook URL').fill(WEBHOOK);
  await expect(page.getByText(/Спочатку збережіть webhook/)).toBeVisible();
  await page.getByRole('button', { name: 'Зберегти webhook' }).click();
  await expect(page.getByText(/Webhook налаштовано .* — значення не показується/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Надіслати тестове повідомлення' })).toBeEnabled();
  expect(await page.content()).not.toContain(SECRET_PART);
  const stored = await inRunSchema(async (q) => ({
    integration: (await q("SELECT generation::int AS g, key_version, encode(ciphertext, 'escape') LIKE '%hooks.slack%' AS plain FROM alert_slack_integration")).rows[0],
    audit: (await q("SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE $1", [`%${SECRET_PART}%`])).rows[0],
    configured: (await q("SELECT count(*)::int AS n FROM audit_log WHERE event = 'integration.slack_configured'")).rows[0],
  }));
  expect(stored).toEqual({ integration: { g: 1, key_version: 1, plain: false }, audit: { n: 0 }, configured: { n: 1 } });

  await page.getByRole('link', { name: 'Правила сповіщень' }).click();
  const interval = page.getByLabel(/Інтервал перевірки/);
  await interval.fill('45');
  await page.getByLabel(/CPU процесу — поріг проблеми/).fill('150');
  await page.getByLabel(/CPU процесу — поріг відновлення/).fill('120');
  await expect(page.getByText('Є незбережені зміни.')).toBeVisible();
  await page.getByRole('button', { name: 'Зберегти' }).click();
  await expect(page.getByText(/Збережено. Нові правила діють з наступного циклу/)).toBeVisible();
  const settings = await inRunSchema(async (q) => (await q('SELECT interval_seconds, cpu_open_percent, cpu_close_percent, engine_enabled, delivery_enabled FROM alert_settings')).rows[0]);
  expect(settings).toEqual({ interval_seconds: 45, cpu_open_percent: 150, cpu_close_percent: 120, engine_enabled: false, delivery_enabled: false });
  await page.context().close();

  const op = await newPage(browser);
  await signIn(op, OPERATOR);
  await expect(op.getByRole('link', { name: 'Налаштування' })).toHaveCount(0);
  await op.goto('/settings/integrations');
  await expect(op.getByRole('heading', { name: 'Недостатньо прав' })).toBeVisible();
  const status = await op.evaluate(async () => (await fetch('/api/settings/alerts', { credentials: 'same-origin' })).status);
  expect(status).toBe(403);
  await op.context().close();
});

test('mobile 390 px: both tabs fit without horizontal scroll; keyboard reaches the tabs', async ({ browser }) => {
  const page = await newPage(browser, 390);
  await signIn(page, ADMIN);
  await page.goto('/settings/integrations');
  await expect(page.getByRole('heading', { name: 'Slack' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('link', { name: 'Правила сповіщень' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Правила сповіщень' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.context().close();
});
