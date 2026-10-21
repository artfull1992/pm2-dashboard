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

/**
 * Test fixture (ADR-028): grants a user (by email) access to a server — 'all' services or the named ones. Operators
 * and viewers see nothing without grants; specs that exercise their views set them up here (the admin UI for grants
 * is covered by access.spec.ts).
 */
export async function grantAccess(email: string, serverId: string, mode: 'all' | 'selected' = 'all', services: string[] = []): Promise<void> {
  await inRunSchema(async (q) => {
    const user = (await q('SELECT id FROM users WHERE email = $1', [email])).rows[0]?.id;
    if (typeof user !== 'string') throw new Error('grantAccess: unknown user');
    await q(`INSERT INTO user_server_access (user_id, server_id, mode) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, server_id) DO UPDATE SET mode = EXCLUDED.mode`, [user, serverId, mode]);
    await q('DELETE FROM user_service_access WHERE user_id = $1 AND server_id = $2', [user, serverId]);
    if (services.length > 0) {
      await q('INSERT INTO user_service_access (user_id, server_id, service_name) SELECT $1, $2, unnest($3::text[])', [user, serverId, services]);
    }
  });
}
