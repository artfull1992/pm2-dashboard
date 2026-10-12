import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePort } from './helpers.js';

describe('freePort', () => {
  it('returns a usable port and releases it', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects promptly on a real listen error (address not available) without hanging', async () => {
    const started = Date.now();
    // 203.0.113.0/24 is TEST-NET-3: never assigned to a local interface.
    await expect(freePort('203.0.113.1')).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects on a controlled EPERM (sandbox) and closes the server', async () => {
    const server = createServer();
    let closed = false;
    server.listen = (() => {
      setImmediate(() => server.emit('error', Object.assign(new Error('listen EPERM'), { code: 'EPERM' })));
      return server;
    }) as typeof server.listen;
    server.close = ((cb?: () => void) => { closed = true; cb?.(); return server; });
    await expect(freePort('127.0.0.1', server)).rejects.toMatchObject({ code: 'EPERM' });
    expect(closed).toBe(true);
  });
});
