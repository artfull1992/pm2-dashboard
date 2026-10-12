import { existsSync, readFileSync, rmSync } from 'node:fs';
import { connectTestClient, dropRunSchema, readTestDbEnv, testDbConfig } from '../../backend/test/support/test-db.js';
import { STATE_FILE } from './env.js';

/** Stops only the processes this run started and drops only this run's schema. */
export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { schema: string; pids: (number | undefined)[] };
  for (const pid of state.pids) {
    if (pid === undefined) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 1_000));
  const client = await connectTestClient(testDbConfig(readTestDbEnv()));
  try {
    await dropRunSchema(client, state.schema);
  } finally {
    await client.end();
  }
  rmSync(STATE_FILE, { force: true });
}
