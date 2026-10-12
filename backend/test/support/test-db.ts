// Guard rails for real-PostgreSQL tests (ADR-009). Every DDL/DML test goes through these helpers.
//  * Configuration comes ONLY from TEST_DB_* (optionally loaded from the file named by TEST_DB_ENV_FILE).
//    There is no fallback to DB_* or to the repository .env.
//  * Production database/user names are rejected; test names must contain a "test" token.
//  * After connecting, current_database()/current_user must equal the configured test identity.
//  * Each run works in its own schema nc_test_<ms>_<hex8>; cleanup drops only names of that exact shape.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { type DbConfig, loadConfig } from '../../src/config.js';

export const TEST_DB_KEYS = ['TEST_DB_HOST', 'TEST_DB_PORT', 'TEST_DB_NAME', 'TEST_DB_USER', 'TEST_DB_PASS'] as const;
export const PRODUCTION_IDENTITIES = Object.freeze({ databases: ['node_control_db', 'postgres', 'secrets-manager'], users: ['node_control_user', 'postgres', 'secrets-manager'] });
const TEST_TOKEN_RE = /(^|_)test(_|$)/;
const RUN_SCHEMA_RE = /^nc_test_\d{13}_[0-9a-f]{8}$/;

export class TestDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestDbConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** TEST_DB_* from an explicit file (TEST_DB_ENV_FILE) overlaid by the process environment. Nothing else. */
export function readTestDbEnv(processEnv: Env = process.env): Record<string, string | undefined> {
  const file = processEnv.TEST_DB_ENV_FILE;
  let fromFile: Record<string, string> = {};
  if (file) {
    if (!existsSync(file)) throw new TestDbConfigError('TEST_DB_ENV_FILE points to a missing file');
    fromFile = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  }
  const env: Record<string, string | undefined> = {};
  for (const key of TEST_DB_KEYS) env[key] = processEnv[key] ?? fromFile[key];
  return env;
}

export function testDbConfig(env: Env): DbConfig {
  const missing = TEST_DB_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new TestDbConfigError(`real-DB tests need explicit ${missing.join(', ')} (or TEST_DB_ENV_FILE); there is no fallback to DB_* or .env`);
  }
  const name = env.TEST_DB_NAME ?? '';
  const user = env.TEST_DB_USER ?? '';
  if (PRODUCTION_IDENTITIES.databases.includes(name) || PRODUCTION_IDENTITIES.users.includes(user)) {
    throw new TestDbConfigError('TEST_DB_* points to a production database or role; refusing');
  }
  if (!TEST_TOKEN_RE.test(name) || !TEST_TOKEN_RE.test(user)) {
    throw new TestDbConfigError('TEST_DB_NAME and TEST_DB_USER must contain a "test" token (e.g. node_control_test_db)');
  }
  return loadConfig({
    DB_HOST: env.TEST_DB_HOST,
    DB_PORT: env.TEST_DB_PORT,
    DB_NAME: name,
    DB_USER: user,
    DB_PASS: env.TEST_DB_PASS,
  }).db;
}

/** Fails unless the live session is exactly the configured test identity. Call before any DDL/DML. */
export async function assertTestIdentity(client: Pick<pg.Client, 'query'>, config: DbConfig): Promise<void> {
  const { rows } = await client.query<{ db: string; usr: string }>('SELECT current_database() AS db, current_user AS usr');
  if (rows[0]?.db !== config.database || rows[0].usr !== config.user) {
    throw new TestDbConfigError('connected identity does not match the test configuration; refusing to continue');
  }
}

export function newRunSchemaName(now = Date.now()): string {
  return `nc_test_${String(now)}_${randomBytes(4).toString('hex')}`;
}

export function assertRunSchemaName(schema: string): string {
  if (!RUN_SCHEMA_RE.test(schema)) throw new TestDbConfigError('refusing to touch a schema that is not a per-run test schema');
  return schema;
}

export async function connectTestClient(config: DbConfig, overrides: Partial<pg.ClientConfig> = {}): Promise<pg.Client> {
  const client = new pg.Client({
    host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    connectionTimeoutMillis: 5_000, lock_timeout: 10_000, statement_timeout: 30_000, ...overrides,
  });
  await client.connect();
  try {
    await assertTestIdentity(client, config);
  } catch (error) {
    await client.end();
    throw error;
  }
  return client;
}

export async function createRunSchema(client: Pick<pg.Client, 'query'>, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA "${assertRunSchemaName(schema)}"`);
}

/** Drops exactly one per-run schema. Never DROP DATABASE, never another schema. */
export async function dropRunSchema(client: Pick<pg.Client, 'query'>, schema: string): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS "${assertRunSchemaName(schema)}" CASCADE`);
}
