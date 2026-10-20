import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AgentOptions, JOURNAL_LIMITS, verifyAgent } from '../src/agent.js';
import type { Context } from '../src/engine.js';
import { type RunOptions, type RunResult, realHost } from '../src/host.js';
import { capture, FakeHost } from './fake-host.js';

// Review ADR-027 (2026-10-20, P2): the Agent journal of a long-running invocation can be large. Verification reads it
// with bounded memory and time and still finds the LAST heartbeat of the current invocation. Here systemd metadata comes
// from FakeHost, but the "journalctl" process is a REAL child process (Node) printing synthetic journal lines.

const UNIT = 'node-control-agent.service';
const SECRET = `ncag_${'S'.repeat(43)}`;
const line = (msg: string, outcome: string, extra = '') => `{"level":"info","msg":"${msg}","outcome":"${outcome}"${extra}}`;

/** A child that prints the given lines, then `fillBytes` of other events (each line < 200 bytes), then optionally hangs. */
function journalScript(lines: string[], fillBytes: number, after: string[] = [], hang = false): string {
  return `
    const out = process.stdout;
    const head = ${JSON.stringify(lines.map((l) => `${l}\n`).join(''))};
    const tail = ${JSON.stringify(after.map((l) => `${l}\n`).join(''))};
    const filler = '{"level":"warn","msg":"control poll","outcome":"broker_unavailable","detail":"${'x'.repeat(100)}"}\\n';
    out.write(head);
    let left = ${String(fillBytes)};
    const chunk = filler.repeat(500);
    function pump() {
      while (left > 0) { left -= chunk.length; if (!out.write(chunk)) { out.once('drain', pump); return; } }
      out.write(tail);
      ${hang ? 'setInterval(() => {}, 1000);' : 'out.end();'}
    }
    pump();`;
}

/** FakeHost for systemd state; journalctl is replaced by a real Node child running `script()`. */
class HybridHost extends FakeHost {
  constructor(private readonly script: () => string) { super(); }
  override run(command: string, args: readonly string[], options?: RunOptions): RunResult {
    if (command === 'journalctl') { this.calls.push({ command, args: [...args] }); return realHost.run(process.execPath, ['-e', this.script()]); }
    return super.run(command, args, options);
  }
  override scan(...a: Parameters<FakeHost['scan']>): ReturnType<FakeHost['scan']> {
    const [command, args, options] = a;
    if (command === 'journalctl') { this.calls.push({ command, args: [...args] }); return realHost.scan(process.execPath, ['-e', this.script()], options); }
    return super.scan(...a);
  }
}

function running(h: FakeHost): FakeHost {
  h.units.set(UNIT, { enabled: true, active: true });
  h.invocations.set(UNIT, 'run-1');
  return h;
}
const options: AgentOptions = { mode: 'apply', artifact: '/x', apiUrl: 'https://control.example.com', tokenFile: null, tokenStdin: false, pm2: null, enableControl: false, releaseTool: '/x' };
async function verify(h: FakeHost, o: AgentOptions = options) {
  const c = capture();
  const ctx: Context = { host: h, mode: 'apply', effects: new Set(), out: c.out, persist: () => undefined };
  const ok = await verifyAgent(ctx, o);
  return { ok, all: c.all };
}

describe('Agent verification on a large journal (real child process)', () => {
  it('early accepted + more than 2 MiB of other events → the heartbeat is found, no overflow', async () => {
    const h = running(new HybridHost(() => journalScript([line('heartbeat', 'accepted')], 2.5 * 1024 * 1024)));
    const r = await verify(h);
    expect(r.ok).toBe(true);
    expect(r.all).toMatch(/зв'язок Agent підтверджено/);
  }, 30_000);

  it('accepted, then a later unauthorized buried under megabytes of events → not confirmed', async () => {
    const h = running(new HybridHost(() => journalScript([line('heartbeat', 'accepted')], 1024 * 1024, [line('heartbeat', 'unauthorized'), ...Array.from({ length: 2000 }, () => line('control poll', 'ok'))])));
    const r = await verify(h);
    expect(r.ok).toBe(false);
    expect(r.all).toMatch(/API відхилив ключ/);
  }, 30_000);

  it('old unauthorized, then accepted → confirmed; synthetic secrets in the journal never reach the output', async () => {
    const h = running(new HybridHost(() => journalScript([line('heartbeat', 'unauthorized', `,"note":"${SECRET}"`), line('heartbeat', 'accepted', `,"token":"${SECRET}"`)], 512 * 1024)));
    const r = await verify(h);
    expect(r.ok).toBe(true);
    expect(r.all).not.toContain(SECRET);
    expect(r.all).not.toContain('"msg"');
    expect(r.all).not.toContain('broker_unavailable');
  }, 30_000);
});

describe('Agent verification: explicit failures and inventory events (FakeHost with scan semantics)', () => {
  it('journal read times out → explicit failure, not confirmed', async () => {
    const h = running(new FakeHost());
    h.journalHangs = true;
    const r = await verify(h);
    expect(r.ok).toBe(false);
    expect(r.all).toMatch(/не завершилось за 10 с/);
  });

  it('journal larger than the limit (real child, > 64 MiB) → explicit failure, the child is stopped', async () => {
    const h = running(new HybridHost(() => journalScript([line('heartbeat', 'accepted')], JOURNAL_LIMITS.maxBytes + 1024 * 1024)));
    const r = await verify(h);
    expect(r.ok).toBe(false);
    expect(r.all).toMatch(/більший за 64 MiB/);
  }, 60_000);

  it('journal command fails → explicit failure; an empty journal or inventory-only events are not "accepted"', async () => {
    const failing = running(new FakeHost());
    failing.journalFails = true;
    expect((await verify(failing)).all).toMatch(/не вдалося прочитати журнал/);
    const empty = running(new FakeHost());
    const r = await verify(empty);
    expect(r.ok).toBe(false);
    expect(r.all).toMatch(/не звітував про heartbeat за 75 с/);
    const inventoryOnly = running(new FakeHost());
    inventoryOnly.agentLogs = () => line('inventory', 'accepted', ',"state":"ok"');
    expect((await verify(inventoryOnly, { ...options, pm2: { owner: 'deploy', home: '/home/deploy/.pm2' } })).ok).toBe(false);
  });

  it('inventory is read from the same bounded pass and never replaces the heartbeat', async () => {
    const h = running(new FakeHost());
    h.agentLogs = (_inv, n) => (n === 0 ? `${line('heartbeat', 'accepted')}\n${line('inventory', 'accepted', ',"state":"stale"')}` : null);
    const r = await verify(h, { ...options, pm2: { owner: 'deploy', home: '/home/deploy/.pm2' } });
    expect(r.ok).toBe(true);
    expect(r.all).toMatch(/inventory: accepted, стан stale/);
  });

  it('the journal of another invocation is never read: the query names the current InvocationID', async () => {
    const h = running(new FakeHost());
    h.historical(line('heartbeat', 'accepted'));
    h.agentLogs = (_inv, n) => (n === 0 ? line('heartbeat', 'unauthorized') : null);
    const r = await verify(h);
    expect(r.ok).toBe(false);
    expect(h.calls.filter((c) => c.command === 'journalctl').every((c) => c.args.includes('_SYSTEMD_INVOCATION_ID=run-1'))).toBe(true);
  });
});

describe('realHost.scan: bounded memory and time on real child processes', () => {
  const node = (code: string) => [process.execPath, ['-e', code]] as const;
  const opts = (over: Partial<Parameters<typeof realHost.scan>[2]> = {}) => {
    const lines: string[] = [];
    return { lines, o: { timeoutMs: 5000, maxBytes: 8 * 1024 * 1024, maxLineChars: 1024, onLine: (l: string) => { lines.push(l); }, ...over } };
  };

  it('large output is streamed line by line within the byte limit; the last line without a newline counts', async () => {
    const { lines, o } = opts({ onLine: () => undefined });
    let count = 0;
    let last = '';
    o.onLine = (l) => { count += 1; last = l; };
    const [cmd, args] = node("const s='y'.repeat(99)+'\\n'; let n=40000; (function p(){ while(n-->0){ if(!process.stdout.write(s)) return process.stdout.once('drain',p);} process.stdout.write('end'); })()");
    expect(await realHost.scan(cmd, args, o)).toEqual({ status: 'exit', code: 0 });
    expect(count).toBe(40001);
    expect(last).toBe('end');
    expect(lines).toEqual([]);
  }, 30_000);

  it('more than maxBytes → "limit", the child is killed (no unbounded accumulation)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-scan-'));
    try {
      const pidFile = join(dir, 'pid');
      const { o } = opts({ maxBytes: 1024 * 1024 });
      const [cmd, args] = node(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const s='z'.repeat(4096)+'\\n'; (function p(){ while(process.stdout.write(s)); process.stdout.once('drain',p); })()`);
      expect(await realHost.scan(cmd, args, o)).toEqual({ status: 'limit' });
      await new Promise((r) => setTimeout(r, 200));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('a hanging child → "timeout" at the deadline, and it is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-scan-'));
    try {
      const pidFile = join(dir, 'pid');
      const { o } = opts({ timeoutMs: 500 });
      const [cmd, args] = node(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{"msg":"heartbeat"'); setInterval(() => {}, 1000)`);
      const started = Date.now();
      expect(await realHost.scan(cmd, args, o)).toEqual({ status: 'timeout' });
      expect(Date.now() - started).toBeLessThan(3000);
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(pidFile)).toBe(true);
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('overlong lines are skipped without being accumulated; exit codes are reported; stderr is not captured', async () => {
    const { lines, o } = opts({ maxLineChars: 100 });
    const [cmd, args] = node("process.stdout.write('a'.repeat(5000)); process.stdout.write('b'.repeat(5000)+'\\nshort\\n'); process.stderr.write('SECRET-on-stderr'); process.exitCode = 3");
    expect(await realHost.scan(cmd, args, o)).toEqual({ status: 'exit', code: 3 });
    expect(lines).toEqual(['short']);
  }, 30_000);

  it('a command that cannot start → "error"', async () => {
    const { o } = opts();
    expect(await realHost.scan('/nonexistent/journalctl', [], o)).toEqual({ status: 'error' });
  });
});

