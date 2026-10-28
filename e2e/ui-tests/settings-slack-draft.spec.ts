import { expect, type Page, test } from '@playwright/test';

// Review faff773 (P2): a replacement webhook draft survives a delivery change and is cleared by a confirmed removal.
// Synthetic API data and a synthetic webhook only (never a real Slack URL); the field is a password input, so
// screenshots never show the value. Screenshots only when NC_UI_SHOTS is set.

const shots = process.env.NC_UI_SHOTS;
const HOOK = `https://hooks.slack.com/services/T0SYNTH09/B0SYNTH09/${'d'.repeat(24)}`;
const ranges = Object.fromEntries(Object.entries({
  cpuOpenPercent: [1, 10000, 90], cpuClosePercent: [0, 10000, 70],
  confirmSamples: [1, 20, 3], recoverSamples: [1, 20, 2], statusConfirmSamples: [1, 20, 2], restartsThreshold: [1, 1000, 3], restartsWindowMinutes: [2, 1440, 10],
  intervalSeconds: [10, 600, 30], cooldownMinutes: [0, 1440, 15], reminderMinutes: [1, 10080, 60], httpTimeoutMs: [1000, 30000, 5000], maxAttempts: [1, 15, 6], queueMax: [10, 1000, 100],
}).map(([k, [min, max, d]]) => [k, { min, max, default: d }]));
const view = (revision: number, deliveryEnabled: boolean, configured: boolean) => ({
  revision, updatedAt: '2026-10-15T09:00:00.000Z', engineEnabled: true, deliveryEnabled,
  rules: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
  timing: { intervalSeconds: 30, cooldownMinutes: 15, reminderEnabled: false, reminderMinutes: 60 },
  advanced: { httpTimeoutMs: 5000, maxAttempts: 6, queueMax: 100 }, ranges,
  slack: configured
    ? { state: 'configured', error: null, generation: 1, configuredAt: '2026-10-15T09:10:00.000Z', keyAvailable: true, lastTest: null }
    : { state: 'not_configured', error: null, generation: 2, configuredAt: null, keyAvailable: true, lastTest: null },
  queue: { queued: 0, sending: 0, sent: 4, failed: 0, unknown: 0, dropped: 0, cancelled: 0 }, publicUrlConfigured: true,
});

async function open(page: Page) {
  let state = view(3, false, true);
  const sent: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/auth/me') {
      await route.fulfill({ json: {
        user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test', role: 'admin' },
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
        csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      } });
      return;
    }
    if (path === '/api/settings/alerts' && req.method() === 'GET') { await route.fulfill({ json: state }); return; }
    sent.push(`${req.method()} ${path}`);
    if (path === '/api/settings/alerts' && req.method() === 'PATCH') { state = view(4, true, true); await route.fulfill({ json: state }); return; }
    if (path === '/api/settings/integrations/slack' && req.method() === 'DELETE') { state = view(5, false, false); await route.fulfill({ json: state }); return; }
    await route.fulfill({ status: 404, json: {} }); // no other mutation, never a test message
  });
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Замінити webhook' }).click();
  await page.getByLabel('Новий webhook').fill(HOOK);
  return sent;
}
const noOverflow = async (page: Page) => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); };

for (const [vp, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`Slack draft (${vp}, ${scheme})`, () => {
      test.use({ viewport, colorScheme: scheme });

      test('a delivery change keeps the replacement draft; leaving still asks', async ({ page }) => {
        const sent = await open(page);
        await page.getByRole('switch', { name: /Автоматична доставка/ }).click();
        await expect(page.getByText('Автоматичну доставку увімкнено.')).toBeVisible();
        await expect(page.getByRole('switch', { name: /Автоматична доставка/ })).toBeChecked();
        await expect(page.getByLabel('Новий webhook')).toHaveValue(HOOK);
        await expect(page.getByLabel('Новий webhook')).toHaveAttribute('type', 'password');
        expect(sent).toEqual(['PATCH /api/settings/alerts']);
        await noOverflow(page);
        await page.waitForTimeout(300); // the switch knob animates for 150 ms
        if (shots) await page.screenshot({ path: `${shots}/slack-draft-delivery--${scheme}--${vp}.png`, fullPage: true });
        await page.getByRole('link', { name: 'Правила сповіщень' }).click();
        await expect(page.getByRole('dialog', { name: 'Скасувати зміни?' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(/\/settings\/integrations$/);
        await expect(page.getByLabel('Новий webhook')).toHaveValue(HOOK);
      });

      test('a confirmed removal clears the draft; the new connection is empty; no leave question', async ({ page }) => {
        const sent = await open(page);
        await page.getByRole('button', { name: 'Видалити інтеграцію' }).click();
        const dialog = page.getByRole('dialog', { name: 'Видалити Slack-інтеграцію?' });
        await expect(dialog.getByText(/не збережений новий webhook також буде очищено/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Скасувати' }).click();
        await expect(page.getByLabel('Новий webhook')).toHaveValue(HOOK);
        expect(sent).toEqual([]);
        await page.getByRole('button', { name: 'Видалити інтеграцію' }).click();
        await page.getByRole('dialog', { name: 'Видалити Slack-інтеграцію?' }).getByRole('button', { name: 'Видалити' }).click();
        await expect(page.getByText('Інтеграцію видалено.')).toBeVisible();
        await expect(page.getByLabel('Webhook URL')).toHaveValue('');
        expect(sent).toEqual(['DELETE /api/settings/integrations/slack']);
        await noOverflow(page);
        if (shots) await page.screenshot({ path: `${shots}/slack-draft-removed--${scheme}--${vp}.png`, fullPage: true });
        await page.getByRole('link', { name: 'Правила сповіщень' }).click();
        await expect(page).toHaveURL(/\/settings\/rules$/);
        await expect(page.getByRole('dialog')).toHaveCount(0);
      });
    });
  }
}
