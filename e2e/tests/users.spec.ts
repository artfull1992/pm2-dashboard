import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { hashPassword } from '../../backend/src/auth/password.js';
import { inRunSchema } from '../support/db.js';

// User administration and self-service password change (Task 011) against the real backend and the isolated test DB
// (per-run schema). A dedicated admin is inserted into THIS run's schema only, so the shared E2E admin's per-account
// login budget is not consumed. All passwords are random per run and never printed.

const pw = () => `e2e-${randomBytes(12).toString('base64url')}`;
const ADMIN = { email: `users-admin-${randomBytes(4).toString('hex')}@example.test`, password: pw() };
const MEMBER = { email: `member-${randomBytes(4).toString('hex')}@example.test`, first: pw(), second: pw() };

test.beforeAll(async () => {
  const hash = await hashPassword(ADMIN.password);
  await inRunSchema((q) => q("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')", [ADMIN.email, hash]));
});

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
}
async function newPage(browser: Browser, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  return context.newPage();
}
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('admin creates a user → the user changes the password → every session ends → only the new password works → role change and deactivation end sessions', async ({ browser }) => {
  const admin = await newPage(browser);
  await signIn(admin, ADMIN.email, ADMIN.password);
  await admin.getByRole('link', { name: 'Користувачі' }).click();
  await expect(admin.getByRole('heading', { name: 'Користувачі' })).toBeVisible();
  const ownRow = admin.getByRole('row').filter({ hasText: ADMIN.email });
  await expect(ownRow.getByText('Ви', { exact: true })).toBeVisible();
  await expect(ownRow.getByRole('button', { name: /^Дії/ })).toHaveCount(0);

  await admin.getByRole('button', { name: 'Новий користувач' }).click();
  const form = admin.getByRole('form', { name: 'Новий користувач' });
  await form.getByLabel('Email').fill(MEMBER.email);
  await form.getByLabel('Початковий пароль').fill(MEMBER.first);
  await form.getByLabel('Роль', { exact: true }).selectOption('operator');
  await form.getByRole('button', { name: 'Створити користувача' }).click();
  await expect(admin.getByText(`Користувача ${MEMBER.email} створено (Оператор).`)).toBeVisible();
  await expect(admin.getByRole('dialog')).toHaveCount(0); // closed on success; the password left the page with the form
  await expect(admin.getByRole('row').filter({ hasText: MEMBER.email })).toContainText('Оператор');

  // Two sessions of the new user.
  const first = await newPage(browser);
  const second = await newPage(browser, 390);
  for (const page of [first, second]) {
    await signIn(page, MEMBER.email, MEMBER.first);
    await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
  }
  await expect(first.getByRole('link', { name: 'Користувачі' })).toHaveCount(0);
  await first.goto('/users');
  await expect(first.getByRole('heading', { name: 'Недостатньо прав' })).toBeVisible();

  // Change the password in the first session.
  await first.getByRole('link', { name: 'Обліковий запис' }).click();
  await first.getByLabel('Поточний пароль').fill(MEMBER.first);
  await first.getByLabel('Новий пароль', { exact: true }).fill(MEMBER.second);
  await first.getByLabel('Повторіть новий пароль').fill(MEMBER.second);
  await first.getByRole('button', { name: 'Змінити пароль' }).click();
  await expect(first.getByText('Пароль змінено. Усі сесії завершено — увійдіть з новим паролем.')).toBeVisible();
  expect(await first.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  // The other session is gone too.
  await second.reload();
  await expect(second.getByLabel('Email')).toBeVisible();

  // Old password refused, new one accepted.
  await signIn(first, MEMBER.email, MEMBER.first);
  await expect(first.getByRole('alert')).toHaveText('Невірний email або пароль.');
  await signIn(first, MEMBER.email, MEMBER.second);
  await expect(first.getByRole('heading', { name: 'Огляд' })).toBeVisible();

  // Role change by the admin ends the user's session.
  await admin.getByRole('button', { name: `Дії: ${MEMBER.email}` }).click();
  await admin.getByRole('button', { name: 'Змінити роль' }).click();
  const roleDialog = admin.getByRole('dialog', { name: `Змінити роль: ${MEMBER.email}` });
  await roleDialog.getByLabel('Нова роль').selectOption('viewer');
  await roleDialog.getByRole('button', { name: 'Змінити роль' }).click();
  await expect(admin.getByText(`Роль ${MEMBER.email} змінено на «Спостерігач». Усі його сесії завершено.`)).toBeVisible();
  await first.reload();
  await expect(first.getByLabel('Email')).toBeVisible();
  await signIn(first, MEMBER.email, MEMBER.second);
  await expect(first.getByText('Спостерігач')).toBeVisible();

  // Deactivation ends it again; the account cannot be used.
  await admin.getByRole('button', { name: `Дії: ${MEMBER.email}` }).click();
  await admin.getByRole('button', { name: 'Деактивувати' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Деактивувати' }).click();
  await expect(admin.getByText(`${MEMBER.email} деактивовано. Усі його сесії завершено.`)).toBeVisible();
  await expect(admin.getByRole('row').filter({ hasText: MEMBER.email })).toContainText('Деактивований');
  await first.reload();
  await expect(first.getByLabel('Email')).toBeVisible();

  const facts = await inRunSchema(async (q) => ({
    active: (await q('SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1 AND s.revoked_at IS NULL', [MEMBER.email])).rows[0],
    events: (await q("SELECT event, outcome FROM audit_log WHERE event IN ('user.created', 'auth.password_change', 'user.role_changed', 'user.deactivated') ORDER BY id")).rows,
    leaked: (await q('SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE $1 OR details::text LIKE $2 OR details::text LIKE $3', [`%${MEMBER.first}%`, `%${MEMBER.second}%`, `%${MEMBER.email}%`])).rows[0],
  }));
  expect(facts.active).toEqual({ n: 0 });
  expect(facts.events).toEqual([
    { event: 'user.created', outcome: 'success' }, { event: 'auth.password_change', outcome: 'success' },
    { event: 'user.role_changed', outcome: 'success' }, { event: 'user.deactivated', outcome: 'success' },
  ]);
  expect(facts.leaked).toEqual({ n: 0 });
  for (const page of [admin, first, second]) await page.context().close();
});

test('mobile 390 px: users table and account form fit, keyboard menu, Escape closes the dialog, focus returns', async ({ browser }) => {
  const page = await newPage(browser, 390);
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('link', { name: 'Користувачі' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  const trigger = page.getByRole('button', { name: `Дії: ${MEMBER.email}` });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Змінити роль' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('link', { name: 'Обліковий запис' }).click();
  await expect(page.getByLabel('Поточний пароль')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.context().close();
});

test('more than 100 users: keyset pages ("Далі"/"Назад"), a user on page 2 is managed there, a new user is found via "Показати"', async ({ browser }) => {
  // Synthetic users in THIS run's schema only; one shared hash (they never sign in).
  const hash = await hashPassword(pw());
  await inRunSchema((q) => q(
    `INSERT INTO users (email, password_hash, role, created_at)
     SELECT 'bulk-' || lpad(n::text, 3, '0') || '@example.test', $1, 'viewer', now() + n * interval '1 millisecond' FROM generate_series(1, 105) AS n`, [hash]));
  for (const width of [1440, 390]) {
    const page = await newPage(browser, width);
    await signIn(page, ADMIN.email, ADMIN.password);
    await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible(); // login finished before navigating
    await page.goto('/users');
    const pager = page.getByRole('navigation', { name: 'Сторінки користувачів' });
    await expect(pager.getByText('Сторінка 1')).toBeVisible();
    await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(100);
    await expect(pager.getByRole('button', { name: 'Назад' })).toBeDisabled();
    await pager.getByRole('button', { name: 'Далі' }).click();
    await expect(pager.getByText('Сторінка 2')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'bulk-105@example.test' })).toBeVisible();
    await expect(pager.getByRole('button', { name: 'Далі' })).toBeDisabled();
    expect(await noHorizontalScroll(page)).toBe(true);
    if (width === 1440) {
      await page.getByRole('button', { name: 'Дії: bulk-104@example.test' }).click();
      await page.getByRole('button', { name: 'Деактивувати' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Деактивувати' }).click();
      await expect(page.getByText('bulk-104@example.test деактивовано. Усі його сесії завершено.')).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: 'bulk-104@example.test' })).toContainText('Деактивований');
      await expect(pager.getByText('Сторінка 2')).toBeVisible();
      await pager.getByRole('button', { name: 'Назад' }).click();
      await expect(pager.getByText('Сторінка 1')).toBeVisible();
      await page.getByRole('button', { name: 'Новий користувач' }).click();
      const form = page.getByRole('form', { name: 'Новий користувач' });
      await form.getByLabel('Email').fill('after-bulk@example.test');
      await form.getByLabel('Початковий пароль').fill(pw());
      await form.getByRole('button', { name: 'Створити користувача' }).click();
      await expect(page.getByText(/after-bulk@example\.test створено.*наприкінці списку/)).toBeVisible();
      await page.getByRole('button', { name: 'Показати after-bulk@example.test' }).click();
      await expect(page.getByRole('row').filter({ hasText: 'after-bulk@example.test' })).toBeVisible();
      await expect(pager.getByText('Сторінка 2')).toBeVisible();
    } else {
      await pager.getByRole('button', { name: 'Назад' }).focus();
      await page.keyboard.press('Enter');
      await expect(pager.getByText('Сторінка 1')).toBeVisible();
    }
    await page.context().close();
  }
});
