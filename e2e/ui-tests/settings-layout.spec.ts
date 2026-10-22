import { expect, type Page, test } from '@playwright/test';

// Alert-rules form layout (Task 013.2) with synthetic API data only: no DB, no credentials, no Slack.
// Checks the geometry the layout promises (equal control heights, aligned pairs, no horizontal overflow) at desktop and
// mobile widths in light and dark themes. Screenshots only when NC_UI_SHOTS is set (synthetic data).
// NC_UI_LAYOUT_STRICT=0 skips the geometry assertions (used once to capture the "before" state).

const strict = process.env.NC_UI_LAYOUT_STRICT !== '0';
const shots = process.env.NC_UI_SHOTS;
const ranges = Object.fromEntries(Object.entries({
  cpuOpenPercent: [1, 10000, 90], cpuClosePercent: [0, 10000, 70],
  confirmSamples: [1, 20, 3], recoverSamples: [1, 20, 2], statusConfirmSamples: [1, 20, 2], restartsThreshold: [1, 1000, 3], restartsWindowMinutes: [2, 1440, 10],
  intervalSeconds: [10, 600, 30], cooldownMinutes: [0, 1440, 15], reminderMinutes: [1, 10080, 60], httpTimeoutMs: [1000, 30000, 5000], maxAttempts: [1, 15, 6], queueMax: [10, 1000, 100],
}).map(([k, [min, max, d]]) => [k, { min, max, default: d }]));
const view = {
  revision: 3, updatedAt: '2026-10-15T09:00:00.000Z', engineEnabled: true, deliveryEnabled: true,
  rules: { cpuOpenPercent: 90, cpuClosePercent: 70, confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowMinutes: 10 },
  timing: { intervalSeconds: 30, cooldownMinutes: 15, reminderEnabled: false, reminderMinutes: 60 },
  advanced: { httpTimeoutMs: 5000, maxAttempts: 6, queueMax: 100 }, ranges,
  slack: { state: 'configured', error: null, generation: 1, configuredAt: '2026-10-15T09:10:00.000Z', keyAvailable: true, lastTest: { outcome: 'success', code: null, at: '2026-10-15T09:12:00.000Z' } },
  queue: { queued: 0, sending: 0, sent: 4, failed: 0, unknown: 0, dropped: 0, cancelled: 0 }, publicUrlConfigured: true,
};

async function open(page: Page) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') {
      await route.fulfill({ json: {
        user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test', role: 'admin' },
        permissions: ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'],
        csrfToken: 'a'.repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      } });
      return;
    }
    if (path === '/api/settings/alerts' && route.request().method() === 'GET') { await route.fulfill({ json: view }); return; }
    await route.fulfill({ status: 404, json: {} }); // no mutation is ever sent by this spec
  });
  await page.goto('/settings/rules');
  await expect(page.getByRole('heading', { name: 'Правила сповіщень' })).toBeVisible();
}

const box = async (page: Page, label: RegExp | string) => {
  const b = await page.getByLabel(label).boundingBox();
  if (!b) throw new Error(`no box for ${String(label)}`);
  return b;
};

for (const width of [1440, 390]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`alert rules layout at ${String(width)}px, ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await page.getByText('Додаткові параметри').click();
      if (shots) await page.screenshot({ path: `${shots}/settings-rules-${String(width)}-${scheme}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      if (!strict) return;

      // The visible field frame (input + unit suffix) is what must be equal; the bare input shrinks by the suffix width.
      expect(await page.locator('form input[inputmode="numeric"]').count()).toBe(13); // no OS memory thresholds (ADR-023)
      const numeric = page.locator('form .affix');
      const n = await numeric.count();
      expect(n).toBe(13);
      const heights = new Set<number>();
      const widths = new Set<number>();
      for (let i = 0; i < n; i++) {
        const b = await numeric.nth(i).boundingBox();
        if (!b) throw new Error('no box');
        heights.add(Math.round(b.height));
        widths.add(Math.round(b.width));
      }
      expect([...heights]).toHaveLength(1);
      const h = [...heights][0] ?? 0;
      expect(h).toBeGreaterThanOrEqual(36); // one control height token: 36 px desktop, 44 px touch
      expect(h).toBeLessThanOrEqual(46);
      expect([...widths]).toHaveLength(1); // one control width everywhere, single or paired

      // Pairs start on one horizontal line, opening before recovery.
      for (const [a, b] of [[/CPU.*поріг проблеми/, /CPU.*поріг відновлення/],
        [/Підтверджень проблеми/, /Підтверджень відновлення/], [/Рестартів для сповіщення/, /Вікно для рестартів/]] as const) {
        const [ba, bb] = [await box(page, a), await box(page, b)];
        expect(Math.abs(ba.y - bb.y)).toBeLessThanOrEqual(1);
        expect(ba.x).toBeLessThan(bb.x);
      }
      // The form does not stretch across a wide monitor.
      const form = await page.locator('form.rules-form').boundingBox();
      if (!form) throw new Error('no form');
      expect(form.width).toBeLessThanOrEqual(1100);

      // A validation error stays next to its field and does not break the alignment of the pair.
      const close = page.getByLabel(/CPU.*поріг відновлення/);
      await close.fill('95');
      await page.getByRole('button', { name: 'Зберегти' }).click();
      const err = page.getByText('Має бути нижче порогу проблеми.');
      await expect(err).toBeVisible();
      const [eb, cb] = [await err.boundingBox(), await close.boundingBox()];
      if (!eb || !cb) throw new Error('no box');
      expect(Math.abs(eb.x - cb.x)).toBeLessThanOrEqual(4);
      expect(eb.y).toBeGreaterThan(cb.y);
      const [o2, c2] = [await box(page, /CPU.*поріг проблеми/), await box(page, /CPU.*поріг відновлення/)];
      expect(Math.abs(o2.y - c2.y)).toBeLessThanOrEqual(1);
      if (shots) await page.screenshot({ path: `${shots}/settings-rules-${String(width)}-${scheme}-error.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });
  }
}
