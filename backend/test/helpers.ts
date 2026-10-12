import { createServer } from 'node:net';
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

/** A port that is free right now (listener opened on :0 and closed). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  if (address === null || typeof address === 'string') throw new Error('No port assigned');
  return address.port;
}
