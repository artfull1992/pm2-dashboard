import { defineConfig } from '@playwright/test';

// Browser verification with synthetic API data only: no DB, credentials or real PM2 commands.
export default defineConfig({
  testDir: './ui-tests', workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'off', screenshot: 'off', video: 'off', locale: 'uk-UA' },
  webServer: { command: 'npm run frontend:preview -- --port 4175', url: 'http://127.0.0.1:4175', reuseExistingServer: false },
});
