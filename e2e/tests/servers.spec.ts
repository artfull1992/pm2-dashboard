import { expect, type Page, test } from '@playwright/test';
import { startAgent } from '../support/agent.js';
import { inRunSchema } from '../support/db.js';
import { credentials, type E2eRole } from '../support/env.js';

async function login(page: Page, role: E2eRole) {
  const { email, password } = credentials(role);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
}

test('admin provisions a server, the Agent reports in, revoke stops it; viewer cannot manage', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await login(page, 'admin');
  await page.getByRole('link', { name: 'Сервери' }).click();
  await page.getByRole('button', { name: 'Додати сервер' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Новий сервер' });
  await createDialog.getByLabel('Назва нового сервера').fill('e2e-node');
  await createDialog.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  await page.getByRole('link', { name: 'e2e-node' }).click();
  await expect(page.getByText('Ще не підключався')).toBeVisible();

  await page.getByRole('button', { name: 'Видати ключ' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ключ агента видано' });
  const token = await dialog.getByRole('textbox').inputValue();
  expect(token).toMatch(/^ncag_[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: /закрити/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.content()).not.toContain(token);

  const agent = startAgent(token);
  try {
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('Онлайн', { exact: true })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByText('Системні подробиці').click(); // system details live in a disclosure under the services
    await expect(page.getByText('linux / ').or(page.getByText('darwin / '))).toBeVisible();

    // Viewer: sees the server, has no credential controls, and the API refuses even with a valid CSRF token.
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.goto(page.url());
    await expect(viewer.getByText('Онлайн', { exact: true })).toBeVisible();
    await expect(viewer.getByRole('button', { name: /ключ/i })).toHaveCount(0);
    const serverId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const status = await viewer.evaluate(async (id) => {
      const me = await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json() as { csrfToken: string };
      const res = await fetch(`/api/servers/${id}/agent-credentials/revoke`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': me.csrfToken } });
      return res.status;
    }, serverId);
    expect(status).toBe(403);
    await viewerContext.close();

    // Revoke through the UI; the next heartbeat is rejected and nothing is recorded after the revoke.
    await page.getByRole('button', { name: 'Відкликати ключ' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Відкликати' }).click();
    await expect(page.getByRole('button', { name: 'Видати ключ' })).toBeVisible();
    const outcomes = () => [...agent.output().matchAll(/"(?:msg|outcome|nextInSeconds)":("[^"]*"|\d+)/g)].map((m) => m[0]).join(' ');
    await expect.poll(() => agent.output().includes('"outcome":"unauthorized"'), { timeout: 45_000, message: `agent log: ${outcomes()}` }).toBe(true);
    const row = await inRunSchema(async (q) => (await q(
      `SELECT h.received_at <= c.revoked_at AS before_revoke FROM server_heartbeats h
         JOIN agent_credentials c ON c.server_id = h.server_id WHERE h.server_id = $1`, [serverId])).rows[0]);
    expect(row).toEqual({ before_revoke: true });
    const audit = await inRunSchema(async (q) => (await q(
      `SELECT event FROM audit_log WHERE (event LIKE 'server.%' OR event LIKE 'agent.%') AND details->>'serverId' = $1 ORDER BY id`, [serverId])).rows.map((r) => r.event));
    expect(audit).toEqual(['server.created', 'agent.credential_issued', 'agent.credential_revoked']);
  } finally {
    const code = await agent.stop();
    expect(code).toBe(0);
    expect(agent.output()).not.toContain(token);
  }
});
