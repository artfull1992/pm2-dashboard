import { expect, type Page, test } from '@playwright/test';
import { inRunSchema } from '../support/db.js';
import { credentials, type E2eRole } from '../support/env.js';

async function login(page: Page, role: E2eRole, path = '/') {
  const { email, password } = credentials(role);
  await page.goto(path);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
}

test.describe('admin', () => {
  test('login → reload keeps the session → audit → logout', async ({ page, context }) => {
    await login(page, 'admin');
    await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
    await expect(page.getByText(credentials('admin').email, { exact: true })).toBeVisible();

    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === 'nc_session');
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();

    await page.getByRole('link', { name: 'Журнал аудиту' }).click();
    await expect(page.getByRole('heading', { name: 'Журнал аудиту' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByText('Створення адміністратора')).toBeVisible();
    await expect(page.getByText('Вхід').first()).toBeVisible();

    await page.getByRole('button', { name: 'Вийти' }).click();
    await expect(page.getByText('Ви вийшли з системи.')).toBeVisible();
    await page.goto('/audit');
    await expect(page.getByLabel('Email')).toBeVisible();
    const logouts = await inRunSchema(async (q) => (await q(`SELECT count(*)::int AS n FROM audit_log WHERE event = 'auth.logout'`)).rows[0]);
    expect(logouts).toEqual({ n: 1 });
  });

  test('direct SPA URLs load after login and survive reload', async ({ page }) => {
    await login(page, 'admin', '/servers');
    await expect(page.getByRole('heading', { name: 'Ще немає підключених серверів' })).toBeVisible();
    await page.goto('/applications');
    await expect(page.getByRole('heading', { name: 'Ще немає підключених застосунків' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Ще немає підключених застосунків' })).toBeVisible();
  });
});

for (const role of ['viewer', 'operator'] as const) {
  test(`${role}: no audit navigation; direct /audit is forbidden and audit API is not called`, async ({ page }) => {
    const auditCalls: string[] = [];
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/audit') auditCalls.push(request.url()); });
    await login(page, role);
    await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Журнал аудиту' })).toHaveCount(0);
    await page.goto('/audit');
    await expect(page.getByRole('heading', { name: 'Недостатньо прав' })).toBeVisible();
    expect(auditCalls).toEqual([]);
    // The backend still enforces the permission on its own.
    const status = await page.evaluate(async () => (await fetch('/api/audit', { credentials: 'same-origin' })).status);
    expect(status).toBe(403);
  });
}

test('wrong password shows the generic message and keeps the user on the login page', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(credentials('viewer').email);
  await page.getByLabel('Пароль').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('alert')).toHaveText('Невірний email або пароль.');
  await expect(page.getByLabel('Пароль')).toHaveValue('');
});

test('expired session: reload sends the user back to login', async ({ page }) => {
  await login(page, 'operator');
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
  const email = credentials('operator').email;
  await inRunSchema((q) => q(
    `UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $1)`, [email]));
  await page.reload();
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('revoked session: next API call clears private state with a notice', async ({ page }) => {
  await login(page, 'admin');
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
  const email = credentials('admin').email;
  await inRunSchema((q) => q(
    'UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL AND user_id = (SELECT id FROM users WHERE email = $1)', [email]));
  await page.getByRole('link', { name: 'Журнал аудиту' }).click();
  await expect(page.getByText('Сесія завершилась. Увійдіть знову.')).toBeVisible();
  await expect(page.getByText(email)).toHaveCount(0);
});

test('unknown /api route returns API 404 JSON, not the SPA', async ({ request }) => {
  const res = await request.get('/api/does-not-exist');
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: 'Route not found' });
});
