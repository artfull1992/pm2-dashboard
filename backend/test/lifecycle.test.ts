import { createServer, type Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycle, installFatalHandlers, installSignalHandlers, type Lifecycle, StartupError } from '../src/lifecycle.js';
import { FAKE_SECRET, fakeDatabase, freePort, testApp } from './helpers.js';

async function occupiedPort(): Promise<number> {
  const blocker = createServer();
  blockers.push(blocker);
  const port = await freePort();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  return port;
}

const blockers: Server[] = [];
afterEach(async () => {
  await Promise.all(blockers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('createLifecycle', () => {
  it('starts on loopback and shuts down cleanly, closing the database', async () => {
    const database = fakeDatabase();
    const { app, logs } = testApp(database);
    const port = await freePort();
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port, shutdownTimeoutMs: 2_000 });
    await lifecycle.start();
    expect(app.server.listening).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(res.status).toBe(200);

    await expect(lifecycle.shutdown('SIGTERM')).resolves.toBe(true);
    expect(app.server.listening).toBe(false);
    expect(database.close).toHaveBeenCalledOnce();
    expect(logs.text()).toContain('Shutdown complete');
  });

  it('repeated shutdown returns the same promise and cleans up once', async () => {
    const database = fakeDatabase();
    const { app, logs } = testApp(database);
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port: await freePort(), shutdownTimeoutMs: 2_000 });
    await lifecycle.start();
    const first = lifecycle.shutdown('SIGINT');
    const second = lifecycle.shutdown('SIGTERM');
    expect(second).toBe(first);
    await first;
    expect(database.close).toHaveBeenCalledOnce();
    expect(logs.text()).toContain('Shutdown already in progress');
  });

  it('startup failure (port in use) closes the app and database and rejects with StartupError', async () => {
    const port = await occupiedPort();
    const database = fakeDatabase();
    const { app, logs } = testApp(database);
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port, shutdownTimeoutMs: 2_000 });
    const error = await lifecycle.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StartupError);
    expect(error).toMatchObject({ meta: { category: 'system', code: 'EADDRINUSE' }, cleanedUp: true });
    expect(database.close).toHaveBeenCalledOnce();
    expect(logs.records().find((r) => r.msg === 'Failed to start listener')).toMatchObject({ error: { category: 'system', code: 'EADDRINUSE' } });
  });

  it('startup failure with hung cleanup rejects within the shutdown timeout and reports cleanedUp=false', async () => {
    const port = await occupiedPort();
    const database = fakeDatabase();
    database.close.mockReturnValue(new Promise(() => undefined));
    const { app, logs } = testApp(database);
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port, shutdownTimeoutMs: 100 });
    const started = Date.now();
    const error = await lifecycle.start().catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toMatchObject({ cleanedUp: false, meta: { code: 'EADDRINUSE' } });
    expect(database.close).toHaveBeenCalledOnce();
    expect(logs.records().find((r) => r.msg === 'Shutdown failed or timed out')).toMatchObject({ error: { category: 'timeout' } });
  });

  it('shutdown reports failure when cleanup exceeds the timeout', async () => {
    const database = fakeDatabase();
    database.close.mockReturnValue(new Promise(() => undefined));
    const { app, logs } = testApp(database);
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port: await freePort(), shutdownTimeoutMs: 50 });
    await expect(lifecycle.shutdown('SIGTERM')).resolves.toBe(false);
    expect(logs.text()).toContain('Shutdown failed or timed out');
  });

  it('shutdown reports failure when cleanup throws, without logging the error text', async () => {
    const database = fakeDatabase();
    database.close.mockRejectedValue(new Error(`pool end failed ${FAKE_SECRET}`));
    const { app, logs } = testApp(database);
    const lifecycle = createLifecycle(app, { host: '127.0.0.1', port: await freePort(), shutdownTimeoutMs: 1_000 });
    await expect(lifecycle.shutdown('SIGTERM')).resolves.toBe(false);
    expect(logs.text()).toContain('Shutdown failed or timed out');
    expect(logs.text()).not.toContain(FAKE_SECRET);
  });
});

describe('installSignalHandlers', () => {
  const fakeLifecycle = (result: boolean): Lifecycle & { shutdown: ReturnType<typeof vi.fn> } => {
    let pending: Promise<boolean> | undefined;
    return { start: vi.fn(), shutdown: vi.fn(() => (pending ??= Promise.resolve(result))) };
  };

  it('first signal triggers shutdown and exit 0; repeated signals do not exit twice', async () => {
    const target = new EventEmitter();
    const lifecycle = fakeLifecycle(true);
    const onExit = vi.fn();
    installSignalHandlers(target, lifecycle, onExit);
    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGINT', 'SIGINT');
    target.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => { expect(onExit).toHaveBeenCalled(); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onExit).toHaveBeenCalledExactlyOnceWith(0);
    expect(lifecycle.shutdown).toHaveBeenNthCalledWith(1, 'SIGTERM');
  });

  it('failed shutdown exits with 1', async () => {
    const target = new EventEmitter();
    const onExit = vi.fn();
    installSignalHandlers(target, fakeLifecycle(false), onExit);
    target.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => { expect(onExit).toHaveBeenCalledExactlyOnceWith(1); });
  });

  it('the returned function removes the listeners', () => {
    const target = new EventEmitter();
    const remove = installSignalHandlers(target, fakeLifecycle(true), vi.fn());
    expect(target.listenerCount('SIGTERM')).toBe(1);
    remove();
    expect(target.listenerCount('SIGTERM') + target.listenerCount('SIGINT')).toBe(0);
  });
});

describe('installFatalHandlers', () => {
  it.each(['uncaughtException', 'unhandledRejection'] as const)('%s writes metadata only and exits 1', (event) => {
    const target = new EventEmitter();
    let stderr = '';
    const exit = vi.fn();
    installFatalHandlers(target, { write: (chunk: string) => { stderr += chunk; } }, exit);
    const error = Object.assign(new Error(`boom ${FAKE_SECRET}`), { code: 'EPIPE' });
    error.stack = `at ${FAKE_SECRET}`;
    target.emit(event, error);
    expect(stderr).toBe(`Fatal ${event} (category=system code=EPIPE); exiting\n`);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('handles non-Error values', () => {
    const target = new EventEmitter();
    let stderr = '';
    installFatalHandlers(target, { write: (chunk: string) => { stderr += chunk; } }, vi.fn());
    target.emit('unhandledRejection', FAKE_SECRET);
    expect(stderr).toBe('Fatal unhandledRejection (category=non-error); exiting\n');
  });
});
