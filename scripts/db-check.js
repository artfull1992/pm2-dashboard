#!/usr/bin/env node
// Checks the database connection described in .env. Prints no secrets.
//   npm run db:check

import pg from 'pg';
import { ENV_PATH } from './lib/config.js';
import { dbConfigFromEnv, readEnvFile, validateEnv } from './lib/env.js';

const env = readEnvFile(ENV_PATH);
const errors = validateEnv(env);
if (errors.length) {
  console.error(`[db:check] Invalid ${ENV_PATH}: ${errors.join('; ')}`);
  process.exit(1);
}

const client = new pg.Client({ ...dbConfigFromEnv(env), connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows: [info] } = await client.query(`
    SELECT 1 AS ok, current_user AS "user", current_database() AS database,
           current_setting('server_version') AS version,
           coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl`);
  console.log(`[db:check] OK: SELECT ${info.ok} as ${info.user}@${env.DB_HOST}:${env.DB_PORT}/${info.database} (PostgreSQL ${info.version}, ssl=${info.ssl})`);
} catch (error) {
  console.error(`[db:check] FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
