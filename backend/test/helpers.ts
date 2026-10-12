import { createServer, type Server } from 'node:net';
import { vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import type { Database } from '../src/database.js';

export const FAKE_SECRET = 'fakeDbPassword_0123456789abcdefABCDEF';

export function captureLogs() {
  const lines: string[] = [];
  return {
    stream: { write: (chunk: string) => { lines.push(chunk); } },
    text: () => lines.join(''),
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export function fakeDatabase(check: () => Promise<void> = () => Promise.resolve()): Database & {
  check: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    check: vi.fn(check),
    close: vi.fn(() => Promise.resolve()),
    stats: () => ({ total: 0, idle: 0, waiting: 0 }),
    // Health-only tests never query; auth tests inject a store instead of using these.
    query: () => Promise.reject(new Error('fakeDatabase.query not configured')),
    transaction: () => Promise.reject(new Error('fakeDatabase.transaction not configured')),
  };
}

export function testApp(database: Database, overrides: Partial<BuildAppOptions> = {}) {
  const logs = captureLogs();
  const app = buildApp({
    logLevel: 'info',
    readinessTimeoutMs: 200,
    createDatabase: () => database,
    logStream: logs.stream,
    ...overrides,
  });
  return { app, logs };
}

/**
 * A port that is free right now (listener opened on :0 and closed).
 * Rejects promptly on listen errors (EPERM in a sandbox, EADDRNOTAVAIL, …) instead of throwing uncaught.
 */
export async function freePort(host = '127.0.0.1', server: Server = createServer()): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('No port assigned');
  return address.port;
}
