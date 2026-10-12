import { defineConfig, devices } from '@playwright/test';
import { UI_ORIGIN } from './support/env.js';

// Real backend + production frontend build against the isolated test DB (see support/global-setup.ts).
// No traces, screenshots or videos: they could capture typed credentials.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  globalSetup: './support/global-setup.ts',
  globalTeardown: './support/global-teardown.ts',
  outputDir: '../test-results',
  use: {
    baseURL: UI_ORIGIN,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    locale: 'uk-UA',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
