// E2E only: runs the COMPILED production API (backend/dist) against the isolated test database, with the pool
// pinned to the per-run schema. Configuration comes from the process environment set by global-setup
// (never argv, never the repository .env).
import { createDatabase, createPool } from '../../backend/dist/database.js';
import { runServer } from '../../backend/dist/server.js';

const schema = process.env.E2E_SCHEMA ?? '';
if (!/^nc_test_\d{13}_[0-9a-f]{8}$/.test(schema)) {
  process.stderr.write('E2E_SCHEMA must be a per-run test schema\n');
  process.exit(2);
}

const exit = (code) => process.exit(code);
const code = await runServer({
  env: process.env,
  signals: process,
  exit,
  stderr: process.stderr,
  createDatabase: (config, log) => createDatabase(config, log, createPool(config, { searchPath: schema })),
});
if (code !== 0) process.exitCode = code;
