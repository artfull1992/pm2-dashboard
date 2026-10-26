import { randomBytes } from 'node:crypto';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { hashPassword } from '../../backend/src/auth/password.js';
import { inRunSchema } from '../support/db.js';

// Scoped access (ADR-028) against the real backend, the production UI build and the isolated test DB. Dedicated
// users (admin, operator, viewer) are inserted into THIS run's schema only (the shared users' login budgets are used
// by other specs); two synthetic servers with inventory are seeded. No control action is executed here (that is the
// opt-in real-PM2 control.spec.ts). Passwords are random per run and never printed.

const tag = randomBytes(3).toString('hex');
const pw = () => `e2e-${randomBytes(12).toString('base64url')}`;
const ADMIN = { email: `acc-admin-${tag}@example.test`, password: pw(), role: 'admin' };
const OPERATOR = { email: `acc-op-${tag}@example.test`, password: pw(), role: 'operator' };
const VIEWER = { email: `acc-viewer-${tag}@example.test`, password: pw(), role: 'viewer' };
const A = `acc-a-${tag}`;
const B = `acc-b-${tag}`;
const ids = { a: '', b: '' };
const snapshot = { agentVersion: '0.6.0', hostname: 'acc-host', platform: 'linux', arch: 'x64', uptimeSeconds: 60, cpuCount: 1, loadAverage: [0, 0, 0] };

test.beforeAll(async () => {
  for (const u of [ADMIN, OPERATOR, VIEWER]) {
    const hash = await hashPassword(u.password);
    await inRunSchema((q) => q('INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)', [u.email, hash, u.role]));
  }
  await inRunSchema(async (q) => {
    for (const [key, name, apps] of [['a', A, ['svc-1', 'svc-2', 'svc-3']], ['b', B, ['web']]] as const) {
      const id = (await q('INSERT INTO servers (name) VALUES ($1) RETURNING id', [name])).rows[0]?.id as string;
      ids[key] = id;
      await q("INSERT INTO server_heartbeats (server_id, received_at, snapshot) VALUES ($1, now() + interval '1 hour', $2::jsonb)", [id, JSON.stringify(snapshot)]);
      await q(`INSERT INTO server_inventories (server_id, source, state, reported_at, report_captured_at, inventory_captured_at, inventory_collected_at, process_count)
               VALUES ($1, 'pm2', 'ok', now(), now(), now() + interval '1 hour', now() + interval '1 hour', $2)`, [id, apps.length]);
      for (const [i, app] of apps.entries()) {
        await q("INSERT INTO server_applications (server_id, source, pm_id, name, status, restarts, first_seen_at) VALUES ($1, 'pm2', $2, $3, 'online', 0, now())", [id, i, app]);
      }
    }
  });
});

// Leave the run schema as other specs expect it (they assert lists without these rows); grants cascade.
test.afterAll(async () => {
  await inRunSchema(async (q) => {
    await q('DELETE FROM servers WHERE name = ANY($1)', [[A, B]]);
  });
});

async function signIn(browser: Browser, u: { email: string; password: string }): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Пароль', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
  return page;
}
const apiStatus = (page: Page, url: string) => page.evaluate(async (u) => (await fetch(u, { credentials: 'same-origin' })).status, url);
const appNames = async (page: Page) => {
  // The same request the page makes; an empty answer renders an empty state instead of the table.
  return page.evaluate(async () => {
    const r = await fetch('/api/applications?limit=100', { credentials: 'same-origin' });
    const body = await r.json() as { items: { name: string; serverName: string }[] };
    return body.items.map((i) => `${i.serverName}/${i.name}`).sort();
  });
};

async function openAccess(admin: Page, email: string) {
  await admin.goto('/users');
  await admin.getByRole('button', { name: `Дії: ${email}` }).click();
  await admin.getByRole('menuitem', { name: 'Сервери та сервіси' }).click();
  return admin.getByRole('dialog', { name: `Доступи: ${email}` });
}

test('no grants → nothing; admin grants a server/service in «Доступи»; operator and viewer see exactly that; changes apply; stale editor is refused', async ({ browser }) => {
  test.setTimeout(120_000);
  // Before any grant: empty, explained; direct URL and API of a hidden server → not found.
  const op = await signIn(browser, OPERATOR);
  await op.goto('/servers');
  await expect(op.getByRole('heading', { name: 'Немає наданих серверів' })).toBeVisible();
  await op.goto(`/servers/${ids.a}`);
  await expect(op.getByRole('heading', { name: 'Сервер не знайдено' })).toBeVisible();
  expect(await apiStatus(op, `/api/servers/${ids.a}`)).toBe(404);
  expect(await apiStatus(op, `/api/servers/${ids.a}/applications`)).toBe(404);
  expect(await appNames(op)).toEqual([]);
  // The operator cannot read or change grants.
  expect(await apiStatus(op, `/api/access/servers`)).toBe(403);

  // Admin: operator → alpha, selected svc-1; viewer → beta, all services.
  const admin = await signIn(browser, ADMIN);
  let dialog = await openAccess(admin, OPERATOR.email);
  await expect(dialog.getByText(/Доступів немає/)).toBeVisible();
  await dialog.getByLabel('Додати сервер').fill(A);
  await dialog.getByRole('button', { name: `Додати ${A}` }).click();
  await dialog.getByRole('checkbox', { name: 'svc-1' }).check();
  await dialog.getByRole('button', { name: 'Зберегти доступи' }).click();
  await expect(admin.getByText(new RegExp(`Доступи ${OPERATOR.email.replace(/\./g, '\\.')} збережено`))).toBeVisible();
  dialog = await openAccess(admin, VIEWER.email);
  await dialog.getByLabel('Додати сервер').fill(B);
  await dialog.getByRole('button', { name: `Додати ${B}` }).click();
  await dialog.getByRole('radio', { name: 'Усі сервіси (поточні й майбутні)' }).check();
  await dialog.getByRole('button', { name: 'Зберегти доступи' }).click();
  await expect(admin.getByRole('dialog')).toHaveCount(0);
  // Admin editor of an admin: full access, no grants.
  await admin.goto('/users');
  await expect(admin.getByRole('row').filter({ hasText: ADMIN.email }).getByText('Повний доступ')).toBeVisible();

  // Operator: only alpha / svc-1 (list, detail, applications); beta stays hidden.
  await op.goto('/servers');
  await expect(op.getByRole('link', { name: A })).toBeVisible();
  await expect(op.getByRole('link', { name: B })).toHaveCount(0);
  expect(await appNames(op)).toEqual([`${A}/svc-1`]);
  expect(await apiStatus(op, `/api/servers/${ids.b}`)).toBe(404);
  const detail = await op.evaluate(async (id) => (await (await fetch(`/api/servers/${id}/applications`, { credentials: 'same-origin' })).json()) as { items: { name: string }[]; inventory: { processCount: number } }, ids.a);
  expect(detail.items.map((i) => i.name)).toEqual(['svc-1']);
  expect(detail.inventory.processCount).toBe(1); // no hint of hidden services

  // Viewer: beta / web only.
  const viewer = await signIn(browser, VIEWER);
  expect(await appNames(viewer)).toEqual([`${B}/web`]);
  expect(await apiStatus(viewer, `/api/servers/${ids.a}`)).toBe(404);

  // Widen the operator to "all" on alpha: the change applies on the next request.
  dialog = await openAccess(admin, OPERATOR.email);
  await dialog.getByRole('radio', { name: 'Усі сервіси (поточні й майбутні)' }).check();
  await dialog.getByRole('button', { name: 'Зберегти доступи' }).click();
  await expect(admin.getByRole('dialog')).toHaveCount(0);
  expect(await appNames(op)).toEqual([`${A}/svc-1`, `${A}/svc-2`, `${A}/svc-3`]);

  // A stale editor (someone changed the grants meanwhile) is refused, nothing overwritten.
  dialog = await openAccess(admin, OPERATOR.email);
  await expect(dialog.getByRole('button', { name: `Прибрати ${A}` })).toBeVisible();
  await inRunSchema((q) => q('UPDATE users SET access_revision = access_revision + 1 WHERE email = $1', [OPERATOR.email]));
  await dialog.getByRole('button', { name: `Прибрати ${A}` }).click();
  await dialog.getByRole('button', { name: 'Зберегти доступи' }).click();
  await expect(dialog.getByText(/щойно змінив інший адміністратор/)).toBeVisible();
  expect(await appNames(op)).toHaveLength(3);

  // Audit: one row per successful change, ids and counts only.
  const audit = await inRunSchema(async (q) => (await q(
    `SELECT details FROM audit_log WHERE event = 'access.updated' AND details->>'targetUserId' IN
       (SELECT id::text FROM users WHERE email = ANY($1)) ORDER BY id`, [[OPERATOR.email, VIEWER.email]])).rows.map((r) => r.details as Record<string, unknown>));
  expect(audit.map((d) => [d.revision, d.servers, d.services])).toEqual([[1, 1, 1], [1, 1, 0], [2, 1, 0]]);
  expect(JSON.stringify(audit)).not.toContain('svc-');
  for (const p of [op, admin, viewer]) await p.context().close();
});
