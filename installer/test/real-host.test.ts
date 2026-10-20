import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realHost } from '../src/host.js';

// The real host primitives on a temporary directory (any OS, no root: the owner is the current user). The privileged
// parts (useradd, systemctl, other owners) are NOT covered here — see docs/PROJECT_STATUS.md for the Linux limits.

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'nc-installer-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const me = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

describe('realHost', () => {
  it('writeFileAtomic: exact mode from the start, replaces a file, leaves no temporary file, refuses a symlink or directory', () => {
    const d = tmp();
    const f = join(d, 'agent.env');
    realHost.writeFileAtomic(f, 'A=1\n', { mode: 0o600, ...me });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    realHost.writeFileAtomic(f, 'A=2\n', { mode: 0o600, ...me });
    expect(readFileSync(f, 'utf8')).toBe('A=2\n');
    expect(realHost.list(d)).toEqual(['agent.env']);
    const target = join(d, 'target');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(d, 'link'));
    expect(() => { realHost.writeFileAtomic(join(d, 'link'), 'x', { mode: 0o600, ...me }); }).toThrow(/not a regular file/);
    expect(readFileSync(target, 'utf8')).toBe('keep');
    mkdirSync(join(d, 'sub'));
    expect(() => { realHost.writeFileAtomic(join(d, 'sub'), 'x', { mode: 0o600, ...me }); }).toThrow();
  });

  it('writeFileAtomic and mkdir: the requested mode exactly, also under umask 077 (operator shells after secret setup)', () => {
    const d = tmp();
    const previous = process.umask(0o077);
    try {
      realHost.writeFileAtomic(join(d, 'allowlist.json'), '{}', { mode: 0o644, ...me });
      realHost.mkdir(join(d, 'snap'), { mode: 0o2750, ...me });
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(d, 'allowlist.json')).mode & 0o7777).toBe(0o644);
    expect(statSync(join(d, 'snap')).mode & 0o777).toBe(0o750);
  });

  it('mkdir: exact mode despite the umask, one level, never over an existing path; stat/readlink do not follow links', () => {
    const d = tmp();
    const sub = join(d, 'snap');
    realHost.mkdir(sub, { mode: 0o750, ...me });
    expect(realHost.stat(sub)).toMatchObject({ kind: 'dir', mode: 0o750 });
    expect(() => { realHost.mkdir(sub, { mode: 0o750, ...me }); }).toThrow();
    expect(() => { realHost.mkdir(join(d, 'a', 'b'), { mode: 0o750, ...me }); }).toThrow();
    symlinkSync('releases/x', join(d, 'current'));
    expect(realHost.stat(join(d, 'current'))?.kind).toBe('symlink');
    expect(realHost.readlink(join(d, 'current'))).toBe('releases/x');
    expect(realHost.readlink(sub)).toBeNull();
    expect(realHost.stat(join(d, 'missing'))).toBeNull();
  });

  it('run: argv only (no shell expansion), stdin input, exit codes', () => {
    const r = realHost.run('/bin/echo', ['$(id)', '`id`', '; rm -rf /']);
    expect(r).toEqual({ code: 0, stdout: '$(id) `id` ; rm -rf /\n', stderr: '' });
    expect(realHost.run('/bin/cat', [], { input: 'secret-in\n' }).stdout).toBe('secret-in\n');
    expect(realHost.run('/bin/sh', ['-c', 'exit 3']).code).toBe(3);
  });

  it('httpStatus does not follow redirects; tcpReachable for open/closed ports', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/r') { res.writeHead(302, { location: 'http://example.invalid/' }); res.end(); return; }
      res.writeHead(401); res.end('{}');
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      expect(await realHost.httpStatus(`http://127.0.0.1:${String(port)}/api/auth/me`, 2000)).toBe(401);
      expect(await realHost.httpStatus(`http://127.0.0.1:${String(port)}/r`, 2000)).toBe(302);
      expect(await realHost.tcpReachable('127.0.0.1', port, 1000)).toBe(true);
    } finally {
      await new Promise((r) => { server.close(r); });
    }
    expect(await realHost.tcpReachable('127.0.0.1', port, 1000)).toBe(false);
    expect(await realHost.httpStatus(`http://127.0.0.1:${String(port)}/`, 1000)).toBeNull();
  });
});
