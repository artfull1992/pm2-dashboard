import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import type { DbConfig } from './config.js';

// Versioned migrations via node-pg-migrate (ADR-009). SQL files in backend/migrations, applied with:
//  * advisory lock in "wait" mode (bounded by lock_timeout) → concurrent `up` runs serialize, never duplicate;
//  * singleTransaction → all pending migrations commit together or roll back together (incl. tracking rows);
//  * tracking table `pgmigrations` in the target schema (public in production, a per-run schema in tests).
// Migrations are never run by the API at startup — only by the explicit CLI (migrate.ts).

export const MIGRATIONS_TABLE = 'pgmigrations';
// backend/src or backend/dist → backend/migrations
export const DEFAULT_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const MIGRATION_TIMEOUTS = Object.freeze({ connectMs: 5_000, lockMs: 10_000, statementMs: 60_000 });

const MIGRATION_FILE_RE = /^(\d{13})_([a-z0-9][a-z0-9-]*)\.sql$/;
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export interface MigrationLogger {
  info(message: string): void;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  /** Applied in the database but missing from the directory (database is ahead of this release). */
  unknown: string[];
}

export function assertSchemaName(schema: string): string {
  if (!SCHEMA_RE.test(schema)) throw new TypeError('invalid schema name');
  return schema;
}

/** Migration names (file names without .sql), validated and sorted. Any other file in the directory is an error. */
export function listMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  const names = readdirSync(dir).sort().map((file) => {
    const match = MIGRATION_FILE_RE.exec(file);
    if (!match) throw new Error(`unexpected file in migrations directory: ${file}`);
    return file.slice(0, -'.sql'.length);
  });
  return names;
}

/** A client with finite connect/lock/statement timeouts, for the migration session only. */
export function createMigrationClient(db: DbConfig): pg.Client {
  return new pg.Client({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    connectionTimeoutMillis: MIGRATION_TIMEOUTS.connectMs,
    lock_timeout: MIGRATION_TIMEOUTS.lockMs,
    statement_timeout: MIGRATION_TIMEOUTS.statementMs,
    application_name: 'node-control-migrate',
  });
}

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Read-only: never creates the schema or the tracking table. */
export async function migrationStatus(client: Queryable, options: { schema?: string; dir?: string } = {}): Promise<MigrationStatus> {
  const schema = assertSchemaName(options.schema ?? 'public');
  const files = listMigrations(options.dir);
  const { rows } = await client.query<{ exists: boolean }>(
    'SELECT to_regclass(format($1, $2::text, $3::text)) IS NOT NULL AS exists',
    ['%I.%I', schema, MIGRATIONS_TABLE],
  );
  let applied: string[] = [];
  if (rows[0]?.exists) {
    const result = await client.query<{ name: string }>(`SELECT name FROM "${schema}"."${MIGRATIONS_TABLE}" ORDER BY run_on, id`);
    applied = result.rows.map((row) => row.name);
  }
  return {
    applied,
    pending: files.filter((name) => !applied.includes(name)),
    unknown: applied.filter((name) => !files.includes(name)),
  };
}

const silent = (): void => undefined;

/** Applies all pending migrations in one transaction under the advisory lock. Returns the applied names. */
export async function migrateUp(
  client: pg.Client,
  options: { schema?: string; dir?: string; logger?: MigrationLogger } = {},
): Promise<string[]> {
  const schema = assertSchemaName(options.schema ?? 'public');
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  listMigrations(dir); // validate file names before taking any lock
  const info = options.logger ? (message: string) => { options.logger?.info(message); } : silent;
  const applied = await runner({
    dbClient: client,
    dir,
    direction: 'up',
    migrationsTable: MIGRATIONS_TABLE,
    schema,
    singleTransaction: true,
    checkOrder: true,
    advisoryLockMode: 'wait',
    // Library output may contain SQL; only its info lines (file names) are forwarded.
    logger: { debug: silent, info, warn: silent, error: silent },
  });
  return applied.map((migration) => migration.name);
}
