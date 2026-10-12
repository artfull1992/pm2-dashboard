// Test-only executable: runs the compiled runServer with a controlled failure.
// FIXTURE_MODE=hung-cleanup — database.close() never settles;
// FIXTURE_MODE=open-handle  — cleanup succeeds but an interval keeps the event loop alive.
// The spawning test occupies API_PORT beforehand so listen fails with EADDRINUSE.
import { runServer } from '../../../dist/server.js';

setInterval(() => {}, 1_000); // open handle: without a forced exit this process would never end

const mode = process.env.FIXTURE_MODE;
const code = await runServer({
  env: process.env,
  signals: process,
  exit: (c) => process.exit(c),
  stderr: process.stderr,
  createDatabase: () => ({
    check: async () => {},
    close: () => (mode === 'hung-cleanup' ? new Promise(() => {}) : Promise.resolve()),
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
  }),
  shutdownTimeoutMs: 300,
  forceExitDelayMs: 300,
});
if (code !== 0) process.exitCode = code;
