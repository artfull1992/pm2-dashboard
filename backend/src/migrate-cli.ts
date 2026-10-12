import type pg from 'pg';
import { ConfigError, type DbConfig, type EnvSource, loadConfig } from './config.js';
import { describeError, formatErrorMeta } from './errors.js';
import { createMigrationClient, migrateUp, migrationStatus } from './migrations.js';

// Production migration CLI: `status` (read-only) and `up` (explicit apply). No down/reset: production
// schema changes are forward-only; recovery is a backup restore decided by an operator (docs/DEPLOYMENT.md).

export const MIGRATE_USAGE = 'usage: migrate.js <status|up>   (config: ENV_FILE and/or DB_* environment)';

export interface MigrateCliIo {
  env: EnvSource;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** Test seams. */
  createClient?: (db: DbConfig) => pg.Client;
  dir?: string;
}

export async function runMigrateCli(argv: readonly string[], io: MigrateCliIo): Promise<number> {
  const [command, ...rest] = argv;
  if ((command !== 'status' && command !== 'up') || rest.length > 0) {
    io.stderr.write(`${MIGRATE_USAGE}\n`);
    return 2;
  }

  let db: DbConfig;
  try {
    db = loadConfig(io.env).db;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(`Invalid configuration, nothing done:\n${error.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 1;
  }

  const client = (io.createClient ?? createMigrationClient)(db);
  const dirOption = io.dir === undefined ? {} : { dir: io.dir };
  // Identifies the target without credentials: database and user names are not secrets.
  const target = `${db.user}@${db.host}:${db.port}/${db.database}`;
  try {
    await client.connect();
    if (command === 'status') {
      const status = await migrationStatus(client, dirOption);
      io.stdout.write(`[migrate] target ${target}: applied=${status.applied.length} pending=${status.pending.length} unknown=${status.unknown.length}\n`);
      for (const name of status.applied) io.stdout.write(`  applied  ${name}\n`);
      for (const name of status.pending) io.stdout.write(`  pending  ${name}\n`);
      for (const name of status.unknown) io.stdout.write(`  unknown  ${name} (applied in DB, missing in this release)\n`);
      return 0;
    }
    const applied = await migrateUp(client, dirOption);
    io.stdout.write(applied.length === 0
      ? `[migrate] target ${target}: no pending migrations\n`
      : `[migrate] target ${target}: applied ${applied.join(', ')}\n`);
    return 0;
  } catch (error) {
    // Error text may contain SQL or connection details; only allowlisted metadata is printed.
    io.stderr.write(`[migrate] ${command} failed (${formatErrorMeta(describeError(error))}); nothing was committed by a failed up\n`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}
