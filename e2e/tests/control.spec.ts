import { createHash } from 'node:crypto';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { startAgent } from '../support/agent.js';
import { grantAccess, inRunSchema } from '../support/db.js';
import { credentials, type E2eRole } from '../support/env.js';

// Task 009 E2E (opt-in: NC_E2E_REAL_PM2=1): real backend + UI + compiled Agent + compiled broker + a DISPOSABLE PM2
// daemon in a temporary PM2_HOME (pm2 via npx, pinned). Never touches a user's PM2 or production processes.
// Run it on its own (npm run test:e2e:pm2): together with the other specs the admin would exceed the per-account
// login limit (5 per 15 min), which is deliberately not relaxed for tests.

const enabled = process.env.NC_E2E_REAL_PM2 === '1';
const ROOT = join(import.meta.dirname, '..', '..');
const PM2 = 'pm2@7.0.4';
const LOG_SECRET = 'SYNTHETIC_E2E_LOG_SECRET_4410';

async function login(page: Page, role: E2eRole) {
  const { email, password } = credentials(role);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
}

test.skip(!enabled, 'opt-in: NC_E2E_REAL_PM2=1 (needs npx pm2@7.0.4)');

test('operator stops and starts an allowlisted process through Agent + broker; viewer cannot; broker down → disabled', async ({ page, browser }) => {
  test.setTimeout(300_000);
  // Real path: the broker refuses log paths with a symlinked component (macOS /var → /private/var).
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nc-e2e-ctl-')));
  const home = join(base, 'h');
  const run = join(base, 'run');
  const state = join(base, 'state');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(run, { mode: 0o750 });
  mkdirSync(state, { mode: 0o700 });
  chmodSync(run, 0o750);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_'))), PM2_HOME: home };
  const pm2 = (...args: string[]) => {
    const r = spawnSync('npx', ['-y', PM2, ...args], { env, encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error(`pm2 ${args[0] ?? ''} failed`);
    return r.stdout;
  };
  const statusOf = (name: string) => {
    const list = JSON.parse(pm2('jlist')) as { name: string; pm2_env: { status: string } }[];
    return list.find((p) => p.name === name)?.pm2_env.status;
  };
  const brokerEnv = {
    PATH: process.env.PATH ?? '', NC_PM2_HOME: home, NC_BROKER_SOCKET: join(run, 'broker.sock'),
    NC_BROKER_ALLOWLIST: join(base, 'allowlist.json'), NC_BROKER_JOURNAL_DIR: state, NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST: 'true',
  };
  let broker: ChildProcess | null = null;
  let agent: ReturnType<typeof startAgent> | null = null;
  try {
    const script = join(base, 'app.cjs');
    // Synthetic stdout/stderr, including a fake credential that must arrive masked.
    writeFileSync(script, `console.log('e2e stdout line password=${LOG_SECRET}'); console.error('e2e stderr line'); setInterval(() => { console.log('tick'); }, 1000);\n`);
    pm2('start', script, '--name', 'e2e-allowed');
    pm2('start', script, '--name', 'e2e-other');

    // Fingerprint via the broker CLI (no paths in its output), then the allowlist.
    const fp = spawnSync(process.execPath, [join(ROOT, 'agent', 'dist', 'pm2-broker.js'), 'fingerprint'], { env: brokerEnv, encoding: 'utf8' });
    const entry = fp.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { name: string; fingerprint: string }).find((p) => p.name === 'e2e-allowed');
    expect(fp.stdout).not.toContain(base);
    writeFileSync(brokerEnv.NC_BROKER_ALLOWLIST, JSON.stringify({ version: 1, targets: [{ id: 'e2e-allowed', name: 'e2e-allowed', actions: ['start', 'stop', 'restart'], fingerprint: entry?.fingerprint, logs: true }] }), { mode: 0o644 });
    broker = spawn(process.execPath, [join(ROOT, 'agent', 'dist', 'pm2-broker.js'), 'serve'], { env: brokerEnv, stdio: 'ignore' });
    await expect.poll(() => spawnSync('test', ['-S', brokerEnv.NC_BROKER_SOCKET]).status, { timeout: 10_000 }).toBe(0);

    // Provision a server and start the Agent with control enabled.
    await login(page, 'admin');
    await page.getByRole('link', { name: 'Сервери', exact: true }).click();
    await page.getByRole('button', { name: 'Додати сервер' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Новий сервер' });
    await createDialog.getByLabel('Назва нового сервера').fill('e2e-control');
    await createDialog.getByRole('button', { name: 'Додати', exact: true }).click();
    await expect(createDialog).toHaveCount(0);
    await page.getByRole('link', { name: 'e2e-control' }).click();
    await page.getByRole('button', { name: 'Видати ключ' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ключ агента видано' });
    const token = await dialog.getByRole('textbox').inputValue();
    await dialog.getByRole('button', { name: /закрити/ }).click();
    const serverUrl = page.url();
    const serverId = new URL(serverUrl).pathname.split('/').at(-1) ?? '';
    const snapshotFile = join(base, 'inventory.json');
    const exported = spawnSync(process.execPath, [join(ROOT, 'agent', 'dist', 'pm2-exporter.js')], {
      env: { PATH: process.env.PATH ?? '', NC_PM2_HOME: home, NC_PM2_SNAPSHOT_FILE: snapshotFile }, encoding: 'utf8',
    });
    expect(exported.status).toBe(0);
    agent = startAgent(token, {
      NC_AGENT_CONTROL_SOCKET: brokerEnv.NC_BROKER_SOCKET, NC_AGENT_INVENTORY_FILE: snapshotFile,
      NC_AGENT_INVENTORY_ALLOW_SAME_OWNER: 'true', NC_AGENT_INVENTORY_MAX_AGE_SECONDS: '3600',
    });

    // ADR-028: operator and viewer act/see only on granted servers (here: all services of this one).
    for (const role of ['operator', 'viewer'] as const) await grantAccess(credentials(role).email, serverId);

    // Operator: the allowlisted target becomes controllable; the other process is visible in inventory but has no control actions.
    const opContext = await browser.newContext();
    const op = await opContext.newPage();
    await login(op, 'operator');
    await op.goto(serverUrl);
    const control = op.getByRole('region', { name: 'Сервіси сервера' });
    await expect(async () => {
      await op.reload();
      await expect(control.getByRole('button', { name: 'Дії: e2e-allowed' })).toBeEnabled({ timeout: 3_000 });
      await control.getByRole('button', { name: 'Дії: e2e-allowed' }).click();
      await expect(op.getByRole('menuitem', { name: 'Зупинити' })).toBeEnabled({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await expect(control.getByText('e2e-other', { exact: true })).toBeVisible();
    await expect(control.getByRole('button', { name: 'Дії: e2e-other' })).toHaveCount(0);

    await op.getByRole('menuitem', { name: 'Зупинити' }).click();
    const confirm = op.getByRole('dialog', { name: 'Зупинити процес?' });
    await expect(confirm).toContainText('«e2e-allowed» (e2e-allowed) на сервері «e2e-control»');
    await confirm.getByRole('button', { name: 'Зупинити' }).click();
    await expect(control.getByRole('status').filter({ hasText: /Зупинити «e2e-allowed»: Виконано й підтверджено/ })).toBeVisible({ timeout: 60_000 });
    expect(statusOf('e2e-allowed')).toBe('stopped');
    expect(statusOf('e2e-other')).toBe('online');

    await expect(control.getByRole('button', { name: 'Дії: e2e-allowed' })).toBeEnabled({ timeout: 30_000 });
    await control.getByRole('button', { name: 'Дії: e2e-allowed' }).click();
    await expect(op.getByRole('menuitem', { name: 'Запустити', exact: true })).toBeEnabled({ timeout: 30_000 });
    await op.getByRole('menuitem', { name: 'Запустити', exact: true }).click();
    await op.getByRole('dialog', { name: 'Запустити процес?' }).getByRole('button', { name: 'Запустити', exact: true }).click();
    await expect(control.getByRole('status').filter({ hasText: /Запустити «e2e-allowed»: Виконано й підтверджено/ })).toBeVisible({ timeout: 60_000 });
    expect(statusOf('e2e-allowed')).toBe('online');

    const audit = await inRunSchema(async (q) => (await q(
      `SELECT event FROM audit_log WHERE event LIKE 'process.%' AND details->>'serverId' = $1 ORDER BY id`, [serverId])).rows.map((r) => r.event));
    expect(audit).toEqual(['process.command_requested', 'process.command_dispatched', 'process.command_succeeded',
      'process.command_requested', 'process.command_dispatched', 'process.command_succeeded']);

    // Logs (ADR-018): the allowed process from its row menu; the secret arrives masked; the other process has none.
    await expect(control.getByText('Логи не дозволені')).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await control.getByRole('button', { name: 'Дії: e2e-allowed' }).click();
      await expect(op.getByRole('menuitem', { name: 'Переглянути логи' })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await op.getByRole('menuitem', { name: 'Переглянути логи' }).click();
    const viewerDialog = op.getByRole('dialog', { name: 'Логи: e2e-allowed' });
    await expect(viewerDialog.getByText(/e2e stdout line password=\*\*\*/)).toBeVisible({ timeout: 30_000 });
    expect(await viewerDialog.textContent()).not.toContain(LOG_SECRET);
    await viewerDialog.getByRole('tab', { name: 'stderr' }).click();
    await expect(viewerDialog.getByText(/e2e stderr line/)).toBeVisible();
    await op.keyboard.press('Escape');
    await expect(viewerDialog).toHaveCount(0);
    const logAudit = await inRunSchema(async (q) => (await q(
      `SELECT event, details FROM audit_log WHERE event LIKE 'logs.%' AND details->>'serverId' = $1`, [serverId])).rows);
    expect(logAudit).toEqual([{ event: 'logs.view_opened', details: { serverId, targetKey: 'e2e-allowed' } }]);
    const leaked = await inRunSchema(async (q) => (await q(`SELECT count(*)::int AS n FROM audit_log WHERE details::text LIKE '%e2e stdout%' OR details::text LIKE $1`, [`%${LOG_SECRET}%`])).rows[0]);
    expect(leaked).toEqual({ n: 0 });

    // The same control from the all-applications list, without the server page: addressed by server + confirmed target.
    const uptimeOf = (name: string) => (JSON.parse(pm2('jlist')) as { name: string; pm2_env: { pm_uptime: number } }[]).find((p) => p.name === name)?.pm2_env.pm_uptime ?? 0;
    const startedAt = uptimeOf('e2e-allowed');
    await op.goto('/applications');
    await expect(op.getByRole('button', { name: 'Дії: e2e-other на e2e-control' })).toBeVisible({ timeout: 15_000 });
    await op.getByRole('button', { name: 'Дії: e2e-other на e2e-control' }).click();
    await expect(op.getByText(/Не дозволено керування/)).toBeVisible();
    await expect(op.getByRole('menuitem')).toHaveCount(0);
    await op.keyboard.press('Escape');
    await op.getByRole('button', { name: 'Дії: e2e-allowed на e2e-control' }).click();
    await op.getByRole('menuitem', { name: 'Перезапустити' }).click();
    const restartDialog = op.getByRole('dialog', { name: 'Перезапустити процес?' });
    await expect(restartDialog).toContainText('«e2e-allowed» (e2e-allowed) на сервері «e2e-control»');
    await restartDialog.getByRole('button', { name: 'Перезапустити' }).click();
    await expect(op.getByRole('status').filter({ hasText: /Перезапустити «e2e-allowed» на сервері «e2e-control»: Виконано й підтверджено/ })).toBeVisible({ timeout: 60_000 });
    expect(statusOf('e2e-allowed')).toBe('online');
    expect(uptimeOf('e2e-allowed')).toBeGreaterThan(startedAt);
    expect(statusOf('e2e-other')).toBe('online');
    const restartAudit = await inRunSchema(async (q) => (await q(
      `SELECT event FROM audit_log WHERE event LIKE 'process.%' AND details->>'serverId' = $1 ORDER BY id`, [serverId])).rows.map((r) => r.event));
    expect(restartAudit.slice(6)).toEqual(['process.command_requested', 'process.command_dispatched', 'process.command_succeeded']);
    await opContext.close();

    // Viewer: sees the target, has no buttons; the API refuses even with a valid CSRF token.
    const viewerContext = await browser.newContext();
    const viewer = await viewerContext.newPage();
    await login(viewer, 'viewer');
    await viewer.goto(serverUrl);
    const viewerControl = viewer.getByRole('region', { name: 'Сервіси сервера' });
    await expect(viewerControl.getByRole('rowheader', { name: 'e2e-allowed' })).toBeVisible({ timeout: 15_000 });
    await expect(viewerControl.getByRole('button', { name: /^Дії:/ })).toHaveCount(0);
    await expect(viewer.getByRole('menuitem', { name: /^(Запустити|Зупинити|Перезапустити)$/ })).toHaveCount(0);
    const status = await viewer.evaluate(async (id) => {
      const me = await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json() as { csrfToken: string };
      const res = await fetch(`/api/servers/${id}/control-commands`, {
        method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ targetKey: 'e2e-allowed', action: 'stop', idempotencyKey: crypto.randomUUID() }),
      });
      return res.status;
    }, serverId);
    expect(status).toBe(403);
    const logStatus = await viewer.evaluate(async (id) => {
      const me = await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json() as { csrfToken: string };
      const res = await fetch(`/api/servers/${id}/log-requests`, {
        method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ targetKey: 'e2e-allowed' }),
      });
      return res.status;
    }, serverId);
    expect(logStatus).toBe(403);
    expect(statusOf('e2e-allowed')).toBe('online');
    await viewerContext.close();

    // Broker down → the UI says so and the buttons are disabled.
    broker.kill('SIGTERM');
    await new Promise((r) => { broker?.once('exit', r); });
    broker = null;
    await page.goto(serverUrl);
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('region', { name: 'Сервіси сервера' }).getByText(/Broker недоступний/)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    // No broker report → no targets: the row offers no actions and says why (not "not allowed").
    await expect(page.getByRole('button', { name: 'Дії: e2e-allowed' })).toHaveCount(0);
    await expect(page.getByRole('row', { name: /e2e-allowed/ }).getByText('Керування зараз недоступне')).toBeVisible();
  } finally {
    if (agent) { const code = await agent.stop(); expect(code).toBe(0); }
    if (broker) { broker.kill('SIGTERM'); await new Promise((r) => { broker?.once('exit', r); }); }
    try { pm2('kill'); } catch { /* already gone */ }
    rmSync(base, { recursive: true, force: true });
  }
});

// ADR-028: auto broker (no allowlist, no fingerprint step) + scoped access. The operator is granted ONE service of the
// server: only it is visible and controllable (logs included); the other process of the same PM2 owner is hidden and
// refused by the API; a revoked grant stops the next command. Same disposable PM2 daemon approach as above.
test('auto broker: operator controls and reads logs only of the granted service; the other is hidden; revocation applies', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nc-e2e-auto-')));
  const home = join(base, 'h');
  const run = join(base, 'run');
  const state = join(base, 'state');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(run, { mode: 0o750 });
  mkdirSync(state, { mode: 0o700 });
  chmodSync(run, 0o750);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_'))), PM2_HOME: home };
  const pm2 = (...args: string[]) => {
    const r = spawnSync('npx', ['-y', PM2, ...args], { env, encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) throw new Error(`pm2 ${args[0] ?? ''} failed`);
    return r.stdout;
  };
  const statusOf = (name: string) => (JSON.parse(pm2('jlist')) as { name: string; pm2_env: { status: string } }[]).find((p) => p.name === name)?.pm2_env.status;
  const keyOf = (name: string) => `n-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 24)}`;
  const brokerEnv = { PATH: process.env.PATH ?? '', NC_PM2_HOME: home, NC_BROKER_SOCKET: join(run, 'broker.sock'), NC_BROKER_JOURNAL_DIR: state, NC_BROKER_MODE: 'auto' };
  let broker: ChildProcess | null = null;
  let agent: ReturnType<typeof startAgent> | null = null;
  try {
    const script = join(base, 'app.cjs');
    writeFileSync(script, `console.log('auto stdout line password=${LOG_SECRET}'); setInterval(() => { console.log('tick'); }, 1000);\n`);
    pm2('start', script, '--name', 'e2e-granted');
    pm2('start', script, '--name', 'e2e-hidden');
    broker = spawn(process.execPath, [join(ROOT, 'agent', 'dist', 'pm2-broker.js'), 'serve'], { env: brokerEnv, stdio: 'ignore' });
    await expect.poll(() => spawnSync('test', ['-S', brokerEnv.NC_BROKER_SOCKET]).status, { timeout: 10_000 }).toBe(0);

    await login(page, 'admin');
    await page.getByRole('link', { name: 'Сервери', exact: true }).click();
    await page.getByRole('button', { name: 'Додати сервер' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Новий сервер' });
    await createDialog.getByLabel('Назва нового сервера').fill('e2e-auto');
    await createDialog.getByRole('button', { name: 'Додати', exact: true }).click();
    await expect(createDialog).toHaveCount(0);
    await page.getByRole('link', { name: 'e2e-auto' }).click();
    await page.getByRole('button', { name: 'Видати ключ' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ключ агента видано' });
    const token = await dialog.getByRole('textbox').inputValue();
    await dialog.getByRole('button', { name: /закрити/ }).click();
    const serverUrl = page.url();
    const serverId = new URL(serverUrl).pathname.split('/').at(-1) ?? '';
    const snapshotFile = join(base, 'inventory.json');
    expect(spawnSync(process.execPath, [join(ROOT, 'agent', 'dist', 'pm2-exporter.js')], {
      env: { PATH: process.env.PATH ?? '', NC_PM2_HOME: home, NC_PM2_SNAPSHOT_FILE: snapshotFile }, encoding: 'utf8',
    }).status).toBe(0);
    agent = startAgent(token, {
      NC_AGENT_CONTROL_SOCKET: brokerEnv.NC_BROKER_SOCKET, NC_AGENT_INVENTORY_FILE: snapshotFile,
      NC_AGENT_INVENTORY_ALLOW_SAME_OWNER: 'true', NC_AGENT_INVENTORY_MAX_AGE_SECONDS: '3600',
    });
    // The broker reports protocol v2 / auto with every process of the owner.
    await expect.poll(async () => (await inRunSchema(async (q) => (await q('SELECT protocol, mode, targets_total FROM server_control_status WHERE server_id = $1', [serverId])).rows[0])), { timeout: 60_000 })
      .toEqual({ protocol: 2, mode: 'auto', targets_total: 2 });
    await grantAccess(credentials('operator').email, serverId, 'selected', ['e2e-granted']);

    const opContext = await browser.newContext();
    const op = await opContext.newPage();
    await login(op, 'operator');
    await op.goto(serverUrl);
    const control = op.getByRole('region', { name: 'Сервіси сервера' });
    await expect(async () => {
      await op.reload();
      await expect(control.getByRole('button', { name: 'Дії: e2e-granted' })).toBeEnabled({ timeout: 3_000 });
      await control.getByRole('button', { name: 'Дії: e2e-granted' }).click();
      await expect(op.getByRole('menuitem', { name: 'Зупинити' })).toBeEnabled({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
    await expect(op.getByText(/режим auto/)).toBeVisible();
    await expect(op.getByText('e2e-hidden')).toHaveCount(0);
    await op.getByRole('menuitem', { name: 'Зупинити' }).click();
    await op.getByRole('dialog', { name: 'Зупинити процес?' }).getByRole('button', { name: 'Зупинити' }).click();
    await expect(control.getByRole('status').filter({ hasText: /Зупинити «e2e-granted»: Виконано й підтверджено/ })).toBeVisible({ timeout: 60_000 });
    expect(statusOf('e2e-granted')).toBe('stopped');
    expect(statusOf('e2e-hidden')).toBe('online');
    await expect(control.getByRole('button', { name: 'Дії: e2e-granted' })).toBeEnabled({ timeout: 30_000 });
    await control.getByRole('button', { name: 'Дії: e2e-granted' }).click();
    await expect(op.getByRole('menuitem', { name: 'Запустити', exact: true })).toBeEnabled({ timeout: 30_000 });
    await op.getByRole('menuitem', { name: 'Запустити', exact: true }).click();
    await op.getByRole('dialog', { name: 'Запустити процес?' }).getByRole('button', { name: 'Запустити', exact: true }).click();
    await expect(control.getByRole('status').filter({ hasText: /Запустити «e2e-granted»: Виконано й підтверджено/ })).toBeVisible({ timeout: 60_000 });
    expect(statusOf('e2e-granted')).toBe('online');

    // Logs of the granted service (masked); never of the hidden one.
    await expect(async () => {
      await control.getByRole('button', { name: 'Дії: e2e-granted' }).click();
      await expect(op.getByRole('menuitem', { name: 'Переглянути логи' })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await op.getByRole('menuitem', { name: 'Переглянути логи' }).click();
    const logs = op.getByRole('dialog', { name: 'Логи: e2e-granted' });
    await expect(logs.getByText(/auto stdout line password=\*\*\*/)).toBeVisible({ timeout: 30_000 });
    expect(await logs.textContent()).not.toContain(LOG_SECRET);
    await op.keyboard.press('Escape');

    // The hidden service through the API: refused without disclosing it; PM2 untouched.
    const direct = await op.evaluate(async ({ id, key }) => {
      const me = await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json() as { csrfToken: string };
      const headers = { 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' };
      const cmd = await fetch(`/api/servers/${id}/control-commands`, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ targetKey: key, action: 'stop', idempotencyKey: crypto.randomUUID() }) });
      const log = await fetch(`/api/servers/${id}/log-requests`, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ targetKey: key }) });
      return [cmd.status, log.status];
    }, { id: serverId, key: keyOf('e2e-hidden') });
    expect(direct[0]).toBe(404);
    expect(direct[1]).not.toBe(202);
    expect(statusOf('e2e-hidden')).toBe('online');

    // Revocation: the next command is refused, the server disappears for the operator.
    await inRunSchema((q) => q('DELETE FROM user_server_access WHERE server_id = $1', [serverId]));
    const afterRevoke = await op.evaluate(async ({ id, key }) => {
      const me = await (await fetch('/api/auth/me', { credentials: 'same-origin' })).json() as { csrfToken: string };
      const res = await fetch(`/api/servers/${id}/control-commands`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': me.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ targetKey: key, action: 'stop', idempotencyKey: crypto.randomUUID() }) });
      return res.status;
    }, { id: serverId, key: keyOf('e2e-granted') });
    expect(afterRevoke).toBe(404);
    await op.reload();
    await expect(op.getByRole('heading', { name: 'Сервер не знайдено' })).toBeVisible();
    expect(statusOf('e2e-granted')).toBe('online');
    const audit = await inRunSchema(async (q) => (await q(
      `SELECT event, details->>'targetKey' AS key FROM audit_log WHERE event LIKE 'process.%' AND details->>'serverId' = $1 ORDER BY id`, [serverId])).rows);
    expect(audit.every((r) => r.key === keyOf('e2e-granted'))).toBe(true);
    expect(audit.filter((r) => r.event === 'process.command_succeeded')).toHaveLength(2);
    await opContext.close();
  } finally {
    if (agent) { const code = await agent.stop(); expect(code).toBe(0); }
    if (broker) { broker.kill('SIGTERM'); await new Promise((r) => { broker?.once('exit', r); }); }
    try { pm2('kill'); } catch { /* already gone */ }
    rmSync(base, { recursive: true, force: true });
  }
});
