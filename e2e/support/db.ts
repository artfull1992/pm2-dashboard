import { connectTestClient, readTestDbEnv, testDbConfig } from '../../backend/test/support/test-db.js';

/** Runs SQL in this run's schema only (guards: test identity, per-run schema name). */
export async function inRunSchema<T>(fn: (query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  const schema = process.env.E2E_SCHEMA ?? '';
  if (!/^nc_test_\d{13}_[0-9a-f]{8}$/.test(schema)) throw new Error('E2E_SCHEMA missing');
  const client = await connectTestClient(testDbConfig(readTestDbEnv()));
  try {
    await client.query(`SET search_path TO "${schema}"`);
    return await fn((sql, values) => client.query(sql, values));
  } finally {
    await client.end();
  }
}
