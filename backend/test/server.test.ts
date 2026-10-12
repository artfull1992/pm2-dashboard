import { createServer, type Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runServer, type RunServerOptions } from '../src/server.js';
import { captureLogs, FAKE_SECRET, fakeDatabase, freePort } from './helpers.js';

const blockers: Server[] = [];
const emitters: EventEmitter[] = [];
afterEach(async () => {
  // Stop any server left listening by a test through its own signal handler.
  for (const signals of emitters.splice(0)) signals.emit('SIGTERM', 'SIGTERM');
  await Promise.all(blockers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function occupiedPort(): Promise<number> {
  const blocker = createServer();
  blockers.push(blocker);
  const port = await freePort();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  return port;
}

async function options(overrides: Partial<RunServerOptions> & { port?: number } = {}) {
  const signals = new EventEmitter();
  emitters.push(signals);
  const logs = captureLogs();
  let stderr = '';
  const exit = vi.fn();
  const { port, ...rest } = overrides;
  const opts: RunServerOptions = {
    env: {
      API_PORT: String(port ?? (await freePort())),
      LOG_LEVEL: 'info',
      DB_NAME: 'n', DB_USER: 'u', DB_PASS: FAKE_SECRET,
    },
    signals,
    exit,
    stderr: { write: (chunk: string) => { stderr += chunk; } },
    logStream: logs.stream,
    createDatabase: () => fakeDatabase(),
    ...rest,
  };
  return { opts, signals, exit, logs, stderr: () => stderr };
}

describe('runServer', () => {
  it('invalid config: returns 1, writes rule-only stderr, never calls exit', async () => {
    const { opts, exit, stderr } = await options();
    const code = await runServer({ ...opts, env: { API_PORT: 'x', DB_PASS: FAKE_SECRET } });
    expect(code).toBe(1);
    expect(stderr()).toContain('API_PORT must be an integer between 1 and 65535');
    expect(stderr()).not.toContain(FAKE_SECRET);
    expect(exit).not.toHaveBeenCalled();
  });

  it('success: returns 0, SIGTERM leads to exit(0) once', async () => {
    const database = fakeDatabase();
    const { opts, signals, exit, logs } = await options({ createDatabase: () => database });
    expect(await runServer(opts)).toBe(0);
    expect(logs.text()).toContain('API started');
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledExactlyOnceWith(0); });
    expect(database.close).toHaveBeenCalledOnce();
  });

  it('startup failure with hung cleanup: exit(1) right after the shutdown timeout', async () => {
    const database = fakeDatabase();
    database.close.mockReturnValue(new Promise(() => undefined));
    const { opts, exit, signals, logs } = await options({ port: await occupiedPort(), createDatabase: () => database, shutdownTimeoutMs: 100 });
    const started = Date.now();
    expect(await runServer(opts)).toBe(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(database.close).toHaveBeenCalledOnce();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(logs.text()).not.toContain(FAKE_SECRET);
  });

  it('startup failure with clean cleanup: bounded exit(1) via unref timer as a safety net', async () => {
    const { opts, exit } = await options({ port: await occupiedPort(), forceExitDelayMs: 50 });
    expect(await runServer(opts)).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledExactlyOnceWith(1); });
  });
});
