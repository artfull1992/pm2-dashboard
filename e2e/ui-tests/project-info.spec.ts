import { expect, type Page, test } from '@playwright/test';

// «Про проєкт» in the application overview (ADR-036) in a real browser with a synthetic API only: the block first,
// «Параметри процесу» as a closed native disclosure (keyboard), safe external links, long URLs and description without
// horizontal overflow, inline editing by an admin (one PUT, nothing else sent — no PM2 command), a dirty draft that
// survives the list polling and guards a switch of service. Desktop/mobile, light/dark. Screenshots only when
// NC_UI_SHOTS is set.

const shots = process.env.NC_UI_SHOTS;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LONG_URL = `https://status.example.com/${'very-long-path-segment-'.repeat(8)}end?view=full`;
const LONG_TEXT = `${'Довгий опис проєкту без пробілів-'.repeat(4)}\nДругий рядок: публічний API замовлень, синтетичні дані.\n<script>alert(1)</script>`;

interface Api { mutations: { method: string; path: string; body: unknown }[] }

async function api(page: Page, role: 'admin' | 'viewer', filled: boolean): Promise<Api> {
  const state: Api = { mutations: [] };
  interface Info { serverId: string; serviceName: string; revision: number; githubUrl: string | null; projectUrl: string | null; description: string | null; updatedAt: string | null }
  let project: Info = filled
    ? { serverId: A, serviceName: 'orders-api', revision: 2, githubUrl: 'https://github.com/acme/orders-api', projectUrl: LONG_URL, description: LONG_TEXT, updatedAt: '2026-11-01T10:00:00.000Z' }
    : { serverId: A, serviceName: 'orders-api', revision: 0, githubUrl: null, projectUrl: null, description: null, updatedAt: null };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const now = new Date(Date.now() - 20_000).toISOString();
    const row = (name: string, pmId: number) => ({
      key: `${A}:pm2:${String(pmId)}`, serverId: A, serverName: 'app-server', serverStatus: 'online', source: 'pm2', pmId, name, status: 'online',
      uptimeSeconds: 608_460, restarts: 2, cpuPercent: 3.5, memoryBytes: 120 * 1024 ** 2, execMode: 'fork', firstSeenAt: now, inventoryState: 'current', capturedAt: now, collectedAt: now,
    });
    const items = [row('billing-api', 1), row('orders-api', 0)];
    if (req.method() !== 'GET') {
      state.mutations.push({ method: req.method(), path, body: req.postDataJSON() as unknown });
      if (req.method() === 'PUT' && path === `/api/servers/${A}/project-info`) {
        const body = req.postDataJSON() as { githubUrl: string | null; projectUrl: string | null; description: string | null };
        project = { ...project, ...body, revision: project.revision + 1, updatedAt: now };
        await route.fulfill({ json: { serverId: A, serviceName: 'orders-api', revision: project.revision, githubUrl: project.githubUrl, projectUrl: project.projectUrl, description: project.description, updatedAt: project.updatedAt } });
        return;
      }
      await route.fulfill({ status: 409, json: {} });
      return;
    }
    let data: unknown;
    if (path === '/api/auth/me') {
      data = role === 'admin'
        ? { user: { id: '00000000-0000-4000-8000-000000000001', email: 'admin@example.test', role: 'admin' }, csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage', 'applications:metadata:write'] }
        : { user: { id: '00000000-0000-4000-8000-000000000002', email: 'viewer@example.test', role: 'viewer' }, csrfToken: 'b'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: ['monitoring:read'] };
    } else if (path === '/api/servers') {
      data = { items: [{ id: A, name: 'app-server', isActive: true, createdAt: now, status: 'online', lastSeenAt: now, hasActiveCredential: true }], nextAfterId: null, onlineWindowSeconds: 90 };
    } else if (path === '/api/applications') {
      data = { items, nextCursor: null, freshWindowSeconds: 180 };
    } else if (path === `/api/servers/${A}/applications`) {
      data = { serverId: A, serverStatus: 'online', freshWindowSeconds: 180, items, inventory: { state: 'current', reason: null, source: 'pm2', capturedAt: now, collectedAt: now, reportedAt: now, processCount: 2 } };
    } else if (path === `/api/servers/${A}/project-info`) {
      const service = url.searchParams.get('service');
      data = service === 'orders-api' ? { serverId: A, serviceName: 'orders-api', revision: project.revision, githubUrl: project.githubUrl, projectUrl: project.projectUrl, description: project.description, updatedAt: project.updatedAt }
        : { serverId: A, serviceName: service, revision: 0, githubUrl: null, projectUrl: null, description: null, updatedAt: null };
    } else if (path === `/api/servers/${A}/control`) {
      data = { serverId: A, enabled: true, serverStatus: 'online', broker: { state: 'ok', daemon: 'ok', allowlist: 'ok', reportedAt: now, fresh: true }, targetFreshSeconds: 60,
        targets: [{ targetKey: 'orders-api', name: 'orders-api', pmId: 0, actions: ['restart'], matchStatus: 'ok' }] };
    } else if (path === `/api/servers/${A}/log-targets`) {
      data = { serverId: A, state: 'supported', reportedAt: now, targets: [] };
    } else {
      await route.fulfill({ status: 404, json: {} });
      return;
    }
    await route.fulfill({ json: data });
  });
  return state;
}

const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };
async function openOrders(page: Page) {
  await page.goto('/applications');
  await page.getByRole('button', { name: /^orders-api на app-server:/ }).click();
  const panel = page.getByRole('region', { name: 'Деталі: orders-api на app-server' });
  const block = panel.getByRole('region', { name: 'Про проєкт' });
  await expect(block).toBeVisible();
  return { panel, block };
}

for (const [vp, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`project information (${vp}, ${scheme})`, () => {
      test.use({ viewport, colorScheme: scheme });

      test('view: block first, long values wrap, safe links, closed process parameters toggled by keyboard', async ({ page }) => {
        const state = await api(page, 'viewer', true);
        const { panel, block } = await openOrders(page);
        await expect(block.getByRole('link', { name: /github\.com\/acme\/orders-api/ })).toBeVisible();
        for (const link of await block.getByRole('link').all()) {
          await expect(link).toHaveAttribute('target', '_blank');
          await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
          await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
        }
        await expect(block.getByText('<script>alert(1)</script>')).toBeVisible();
        expect(await page.locator('.project-info script').count()).toBe(0);
        await expect(block.getByRole('button')).toHaveCount(0); // viewer: read only
        const order = await panel.locator('.app-detail__content > *').evaluateAll((els) => els.map((e) => `${e.tagName}.${e.getAttribute('class') ?? ''}`));
        expect(order[0]).toContain('project-info');
        const details = panel.locator('details.app-disclosure');
        await expect(details).not.toHaveAttribute('open');
        await expect(panel.getByText('Рестарти, усього')).toBeHidden();
        const summary = details.locator('summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        await expect(details).toHaveAttribute('open');
        await expect(panel.getByText('Рестарти, усього')).toBeVisible();
        await page.keyboard.press('Space');
        await expect(details).not.toHaveAttribute('open');
        await noOverflow(page);
        expect(state.mutations).toEqual([]);
        if (shots) await page.screenshot({ path: `${shots}/project-view-${vp}-${scheme}.png`, fullPage: true });
      });

      test('admin: inline edit with long values, one PUT and nothing else; a dirty draft survives polling and guards another service', async ({ page }) => {
        const state = await api(page, 'admin', false);
        const { block } = await openOrders(page);
        await expect(block.getByText('Інформацію про проєкт ще не додано.')).toBeVisible();
        await block.getByRole('button', { name: 'Додати інформацію' }).click();
        const form = block.getByRole('form', { name: 'Редагування інформації про проєкт' });
        await expect(form.getByLabel('GitHub')).toBeFocused();
        await form.getByLabel('GitHub').fill('https://github.com/acme/orders-api.git');
        await page.keyboard.press('Tab');
        await expect(form.getByLabel('Адреса проєкту')).toBeFocused();
        await page.keyboard.type(LONG_URL);
        await form.getByLabel('Короткий опис').fill(LONG_TEXT);
        await expect(form.getByText('Усі поля необов’язкові. Порожнє поле очищує збережене значення.')).toBeVisible();
        await noOverflow(page);
        if (shots) await page.screenshot({ path: `${shots}/project-edit-${vp}-${scheme}.png`, fullPage: true });

        // Polling (15 s) does not touch the draft.
        await page.waitForTimeout(16_000);
        await expect(form.getByLabel('Адреса проєкту')).toHaveValue(LONG_URL);

        if (vp === 'desktop') {
          await page.getByRole('button', { name: /^billing-api на app-server:/ }).click();
          const dialog = page.getByRole('dialog', { name: 'Скасувати зміни?' });
          await expect(dialog).toBeVisible();
          await dialog.getByRole('button', { name: 'Продовжити редагування' }).click();
          await expect(form.getByLabel('Короткий опис')).toHaveValue(LONG_TEXT);
        }

        await form.getByRole('button', { name: 'Зберегти' }).click();
        await expect(block.getByText('Інформацію про проєкт збережено.')).toBeVisible();
        await expect(block.getByRole('button', { name: 'Редагувати інформацію про проєкт' })).toBeFocused();
        await expect(block.getByRole('link', { name: /status\.example\.com/ })).toBeVisible();
        expect(state.mutations).toEqual([{ method: 'PUT', path: `/api/servers/${A}/project-info`, body: {
          serviceName: 'orders-api', expectedRevision: 0, githubUrl: 'https://github.com/acme/orders-api.git', projectUrl: LONG_URL, description: LONG_TEXT.trim(),
        } }]);
        await noOverflow(page);
        if (shots) await page.screenshot({ path: `${shots}/project-saved-${vp}-${scheme}.png`, fullPage: true });
      });
    });
  }
}
