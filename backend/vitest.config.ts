import { defineConfig } from 'vitest/config';

// Suites: default (unit + API via inject, no network DB), "smoke" (compiled dist), "db" (opt-in real PostgreSQL).
const suite = process.env.BACKEND_TEST_SUITE ?? 'unit';
const include = {
  unit: ['test/*.test.ts'],
  smoke: ['test/smoke/*.test.ts'],
  db: ['test/db/*.test.ts'],
}[suite];

if (!include) throw new Error(`Unknown BACKEND_TEST_SUITE: ${suite}`);

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include,
    environment: 'node',
    testTimeout: 15_000,
    fileParallelism: suite === 'unit',
  },
});
