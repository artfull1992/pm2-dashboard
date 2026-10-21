import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { abortableSleep } from '../src/agent.js';
import { loadAgentConfig } from '../src/config.js';
import { type AllowlistEntry, AllowlistError, parseAllowlist } from '../src/control/allowlist.js';
import { createBroker, listenBroker } from '../src/control/broker.js';
import { BrokerError, brokerCall } from '../src/control/client.js';
import { listTargets } from '../src/control/executor.js';
import { autoTargetKey, fingerprintOf, viewOf } from '../src/control/identity.js';
import { Journal } from '../src/control/journal.js';
import {
  allowedLogPath, buildStreams, maskSecrets, prepareLines, readLogs, readTail, sanitizeLine, shrinkToFrame,
} from '../src/control/logs.js';
import { runLogs } from '../src/control/logs-loop.js';
import { LOG_LIMITS, type LogsRequest, type LogsResponse, parseLogsResponse } from '../src/control/logs-protocol.js';

const TOKEN = `ncag_${'L'.repeat(43)}`;
const SECRET = 'SYNTHETIC_LOG_SECRET_6f1c';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-logs-')));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
let seq = 0;
const fresh = () => { const d = join(root, `d${String(seq++)}`); mkdirSync(d, { mode: 0o750 }); return d; };

function proc(pmId: number, name: string, out: string, err: string, extra: Record<string, unknown> = {}) {
  return {
    pm_id: pmId, name,
    pm2_env: {
      pm_id: pmId, name, status: 'online', exec_mode: 'fork_mode', instances: 1, pm_exec_path: `/srv/${name}.js`, pm_cwd: '/srv',
      exec_interpreter: 'node', args: [], node_args: [], env: { DB_PASSWORD: SECRET }, pm_out_log_path: out, pm_err_log_path: err, ...extra,
    },
  };
}
const fp = (p: ReturnType<typeof proc>) => fingerprintOf(viewOf(p) ?? (() => { throw new Error('x'); })());
const entry = (p: ReturnType<typeof proc>, logs = true, actions: AllowlistEntry['actions'] = ['restart']): AllowlistEntry =>
  ({ id: p.name, name: p.name, actions, fingerprint: fp(p), ...(logs ? { logs: true } : {}) });
const logsReq = (targetKey: string, over: Partial<LogsRequest> = {}): LogsRequest =>
  ({ v: 1, op: 'logs', requestId: randomUUID(), targetKey, lines: 100, deadlineAt: new Date(Date.now() + 10_000).toISOString(), ...over });

describe('allowlist: explicit, optional logs permission', () => {
  const base = { id: 'api', name: 'api', actions: ['restart'], fingerprint: `sha256:${'a'.repeat(64)}` };
  it('old entries stay valid without logs; logs must be boolean; logs-only entries may have no actions', () => {
    expect(parseAllowlist({ version: 1, targets: [base] })).toEqual([base]);
    expect(parseAllowlist({ version: 1, targets: [{ ...base, logs: true }] })[0]?.logs).toBe(true);
    expect(parseAllowlist({ version: 1, targets: [{ ...base, logs: false }] })[0]?.logs).toBeUndefined();
    expect(parseAllowlist({ version: 1, targets: [{ ...base, actions: [], logs: true }] })[0]?.actions).toEqual([]);
    for (const bad of [{ ...base, logs: 'yes' }, { ...base, actions: [] }, { ...base, actions: [], logs: false }, { ...base, paths: ['/etc'] }]) {
      expect(() => parseAllowlist({ version: 1, targets: [bad] })).toThrow(AllowlistError);
    }
  });

  it('logs-only entries are not control targets', async () => {
    const dir = fresh();
    const p = proc(1, 'api', join(dir, 'o.log'), join(dir, 'e.log'));
    const res = await listTargets({ loadAllowlist: () => Promise.resolve([{ ...entry(p), actions: [] }]), list: () => Promise.resolve([p]) });
    expect(res.targets).toEqual([]);
  });
});

describe('file access guard', () => {
  const dirs = ['/home/u/.pm2/logs'];
  it.each([
    ['inside the allowed dir', '/home/u/.pm2/logs/api-out.log', true],
    ['nested inside', '/home/u/.pm2/logs/a/b.log', true],
    ['the dir itself', '/home/u/.pm2/logs', false],
    ['prefix trick', '/home/u/.pm2/logs-evil/x.log', false],
    ['traversal', '/home/u/.pm2/logs/../.ssh/id_rsa', false],
    ['relative', 'logs/x.log', false],
    ['outside', '/etc/passwd', false],
    ['/proc', '/proc/self/environ', false],
    ['/dev/null', '/dev/null', false],
    ['trailing slash', '/home/u/.pm2/logs/x/', false],
    ['NUL', '/home/u/.pm2/logs/x\0.log', false],
    ['not a string', 42, false],
  ])('%s', (_n, path, ok) => {
    expect(allowedLogPath(path, dirs) !== null).toBe(ok);
  });

  it('reads only regular files: symlink file, symlinked directory, FIFO, directory → unavailable; missing → missing', async () => {
    const dir = fresh();
    const real = join(dir, 'real.log');
    writeFileSync(real, 'hello\n');
    expect(await readTail(real)).toMatchObject({ state: 'ok', text: 'hello\n' });
    symlinkSync(real, join(dir, 'link.log'));
    expect((await readTail(join(dir, 'link.log'))).state).toBe('unavailable');
    const other = fresh();
    writeFileSync(join(other, 'x.log'), 'x\n');
    symlinkSync(other, join(dir, 'linkdir'));
    expect((await readTail(join(dir, 'linkdir', 'x.log'))).state).toBe('unavailable');
    expect(spawnSync('mkfifo', [join(dir, 'fifo.log')]).status).toBe(0);
    expect((await readTail(join(dir, 'fifo.log'))).state).toBe('unavailable');
    expect((await readTail(dir)).state).toBe('unavailable');
    expect((await readTail(join(dir, 'none.log'))).state).toBe('missing');
    writeFileSync(join(dir, 'locked.log'), 'secret\n');
    chmodSync(join(dir, 'locked.log'), 0o000);
    if (process.getuid?.() !== 0) expect((await readTail(join(dir, 'locked.log'))).state).toBe('unavailable');
  });

  it('a large file: only the last 256 KiB are read and the first partial line is dropped', async () => {
    const dir = fresh();
    const file = join(dir, 'big.log');
    writeFileSync(file, `${'x'.repeat(1000)}\n`.repeat(2000)); // ~2 MB
    appendFileSync(file, 'last line\n');
    const r = await readTail(file);
    if (r.state !== 'ok') throw new Error('expected ok');
    expect(r.startedMidFile).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(LOG_LIMITS.tailBytes);
    const lines = prepareLines(r.text, true);
    expect(lines.at(-1)).toBe('last line');
    expect(lines.every((l) => l.length <= LOG_LIMITS.maxLineChars + 1)).toBe(true);
  });
});

describe('text hygiene and masking', () => {
  it('strips ANSI/OSC and control characters, keeps tabs, bounds long lines, repairs surrogates', () => {
    expect(sanitizeLine('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\tx\u0007\u0000')).toBe('red ok\tx');
    const long = sanitizeLine('é'.repeat(5000));
    expect(long.length).toBe(LOG_LIMITS.maxLineChars + 1);
    expect(long.endsWith('…')).toBe(true);
    expect(sanitizeLine('a\uD800b')).toBe('a\uFFFDb');
  });

  it('invalid UTF-8, CRLF, partial last line', async () => {
    const dir = fresh();
    const file = join(dir, 'u.log');
    writeFileSync(file, Buffer.concat([Buffer.from('ok\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\npartial')]));
    const r = await readTail(file);
    if (r.state !== 'ok') throw new Error('x');
    expect(prepareLines(r.text, false)).toEqual(['ok', '\uFFFD\uFFFD', 'partial']);
  });

  it.each([
    ['password=hunter2', 'password=***'],
    ['DB_PASSWORD: "s3cr3t"', 'DB_PASSWORD: "***"'],
    ['token=abc.def', 'token=***'],
    ['api_key=XYZ123', 'api_key=***'],
    ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer ***'],
    ['GET with bearer abcdefghijklmnop', 'GET with bearer ***'],
    // Synthetic fixtures are assembled at runtime so the repository secret scanner does not see a literal credential.
    [`postgres://user:${'pa' + '55'}@db:5432/x`, 'postgres://user:***@db:5432/x'],
    ['jwt eyJhbGciOiJ.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4', 'jwt ***jwt***'],
    [`agent ${TOKEN}`, 'agent ncag_***'],
    ['key AKIAABCDEFGHIJKLMNOP', 'key ***aws-key***'],
    ['plain message 42 ok', 'plain message 42 ok'],
  ])('masks %s', (input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it('private key blocks are redacted line by line', () => {
    const kind = 'RSA ' + 'PRIVATE KEY';
    expect(prepareLines(`a\n-----BEGIN ${kind}-----\nMIIEow\n-----END ${kind}-----\nb\n`, false))
      .toEqual(['a', '[PRIVATE KEY REDACTED]', '[PRIVATE KEY REDACTED]', '[PRIVATE KEY REDACTED]', 'b']);
  });

  it('budgets: ≤ 100 lines per stream, ≤ 8 KiB together; unused budget goes to the other stream; frame fits even with heavy escaping', () => {
    const file = (text: string) => ({ state: 'ok' as const, text, startedMidFile: false, size: text.length, mtime: new Date() });
    const many = Array.from({ length: 500 }, (_, i) => `line ${String(i)} ${'y'.repeat(60)}`).join('\n');
    const { stdout, stderr } = buildStreams(file(many), file('only\n'), 100, false);
    expect(stdout.lines).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(stdout.text) + Buffer.byteLength(stderr.text)).toBeLessThanOrEqual(LOG_LIMITS.totalTextBytes);
    expect(stdout.truncated).toBe(true);
    expect(stderr).toMatchObject({ state: 'ok', text: 'only', lines: 1, truncated: false });
    const merged = buildStreams(file('a\n'), file('a\n'), 10, true);
    expect(merged.stderr.state).toBe('merged');
    const quotes = Array.from({ length: 100 }, () => '"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"\\"').join('\n');
    const heavy: LogsResponse = { v: 1, op: 'logs', requestId: randomUUID(), outcome: 'ok', reason: null, readAt: new Date().toISOString(),
      stdout: { state: 'ok', text: quotes.slice(0, 8000), lines: 100, truncated: false, sizeBytes: 1, modifiedAt: null },
      stderr: { state: 'ok', text: '', lines: 0, truncated: false, sizeBytes: 0, modifiedAt: null } };
    const shrunk = shrinkToFrame(heavy, 4096);
    expect(Buffer.byteLength(JSON.stringify(shrunk)) + 1).toBeLessThanOrEqual(4096);
    expect(shrunk.stdout?.truncated).toBe(true);
  });
});

describe('readLogs (broker)', () => {
  function setup(extra: Record<string, unknown> = {}) {
    const dir = fresh();
    const out = join(dir, 'api-out.log');
    const err = join(dir, 'api-error.log');
    writeFileSync(out, `start\n\u001b[32mready\u001b[0m password=${SECRET}\n`);
    writeFileSync(err, 'boom\n');
    const p = proc(1, 'api', out, err, extra);
    return { dir, p };
  }

  it('reads both streams of an allowed target; response has no paths, env or raw errors', async () => {
    const { dir, p } = setup();
    const r = await readLogs(logsReq('api'), { loadAllowlist: () => Promise.resolve([entry(p)]), list: () => Promise.resolve([p]), logDirs: [dir] });
    expect(r).toMatchObject({ outcome: 'ok', reason: null, stdout: { state: 'ok', text: 'start\nready password=***', lines: 2 }, stderr: { state: 'ok', text: 'boom' } });
    const json = JSON.stringify(r);
    expect(json).not.toContain(dir);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain('\u001b');
    expect(parseLogsResponse(r, logsReq('api', { requestId: r.requestId }))).not.toBeNull();
  });

  it.each([
    ['no logs permission', (p: ReturnType<typeof proc>) => [entry(p, false)], 'logs_not_allowed'],
    ['not allowlisted', () => [], 'not_allowlisted'],
    ['fingerprint mismatch', (p: ReturnType<typeof proc>) => [{ ...entry(p), fingerprint: `sha256:${'0'.repeat(64)}` }], 'fingerprint_mismatch'],
  ])('%s → rejected, nothing read', async (_n, entries, reason) => {
    const { dir, p } = setup();
    const r = await readLogs(logsReq('api'), { loadAllowlist: () => Promise.resolve(entries(p)), list: () => Promise.resolve([p]), logDirs: [dir] });
    expect(r).toMatchObject({ outcome: 'rejected', reason, stdout: null, stderr: null });
  });

  it('ambiguous / cluster / no daemon / invalid allowlist / deadline', async () => {
    const { dir, p } = setup();
    const deps = (over: object) => ({ loadAllowlist: () => Promise.resolve([entry(p)]), list: () => Promise.resolve([p]), logDirs: [dir], ...over });
    expect((await readLogs(logsReq('api'), deps({ list: () => Promise.resolve([p, { ...p, pm_id: 2 }]) }))).reason).toBe('ambiguous');
    const cluster = proc(1, 'api', '', '', { exec_mode: 'cluster_mode' });
    expect((await readLogs(logsReq('api'), deps({ list: () => Promise.resolve([cluster]) }))).reason).toBe('cluster_unsupported');
    expect(await readLogs(logsReq('api'), deps({ list: () => Promise.reject(new Error('down')) }))).toMatchObject({ outcome: 'failed', reason: 'daemon_unavailable' });
    expect((await readLogs(logsReq('api'), deps({ loadAllowlist: () => Promise.reject(new AllowlistError('x')) }))).reason).toBe('allowlist_invalid');
    expect((await readLogs(logsReq('api', { deadlineAt: new Date(Date.now() - 1).toISOString() }), deps({}))).reason).toBe('deadline_passed');
  });

  it('log paths outside the allowed dirs or under /dev are not read (stream unavailable, not an error)', async () => {
    const { p } = setup({ pm_err_log_path: '/dev/null' });
    const r = await readLogs(logsReq('api'), { loadAllowlist: () => Promise.resolve([entry(p)]), list: () => Promise.resolve([p]), logDirs: [fresh()] });
    expect(r).toMatchObject({ outcome: 'ok', stdout: { state: 'unavailable', text: '' }, stderr: { state: 'unavailable' } });
  });
});

// --- socket + agent ------------------------------------------------------------------------------------------------
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); }))); });

describe('broker socket and agent loop', () => {
  async function broker(logDirs: string[], p: ReturnType<typeof proc>, entries: AllowlistEntry[], mode: 'allowlist' | 'auto' = 'allowlist') {
    const sockDir = fresh();
    const sock = join(sockDir, 'b.sock');
    const jdir = join(sockDir, 'j');
    mkdirSync(jdir, { mode: 0o700 });
    const { server } = createBroker({
      loadAllowlist: () => Promise.resolve(entries), list: () => Promise.resolve([p]), act: () => Promise.resolve(), journal: new Journal(jdir), logDirs, mode,
    }, { info: () => undefined, warn: () => undefined });
    servers.push(server);
    await listenBroker(server, sock);
    return sock;
  }

  it('logTargets and logs over the real socket; a free-form "read file" request gets no answer', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'o.log'), 'hello\n');
    const p = proc(3, 'api', join(dir, 'o.log'), join(dir, 'e.log'));
    const sock = await broker([dir], p, [entry(p), { ...entry(proc(4, 'other', '', ''), false), id: 'other' }]);
    const targetsReq = { v: 1 as const, op: 'logTargets' as const };
    expect(await brokerCall(sock, targetsReq, 2000, (v) => parseLogsResponse(v, targetsReq))).toEqual({
      v: 1, op: 'logTargets', daemon: 'ok', allowlist: 'ok', targets: [{ targetKey: 'api', name: 'api', pmId: 3, matchStatus: 'ok' }],
    });
    const req = logsReq('api');
    expect(await brokerCall(sock, req, 5000, (v) => parseLogsResponse(v, req))).toMatchObject({ outcome: 'ok', stdout: { text: 'hello' }, stderr: { state: 'missing' } });
    await expect(brokerCall(sock, { v: 1, op: 'readFile', path: '/etc/passwd' }, 2000, (v) => v)).rejects.toMatchObject({ sent: true });
  });

  it('agent: poll → broker → result; an old broker (drops unknown ops) is reported as unsupported; log text is never logged', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'o.log'), `line with password=${SECRET}\nvisible text\n`);
    const p = proc(3, 'api', join(dir, 'o.log'), join(dir, 'e.log'));
    const sock = await broker([dir], p, [entry(p)]);
    const config = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: sock });
    const controller = new AbortController();
    const polls: Record<string, unknown>[] = [];
    const results: Record<string, unknown>[] = [];
    const logged: string[] = [];
    const requestId = randomUUID();
    const fetchImpl = (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      if (url.endsWith('/api/agent/logs/poll')) {
        polls.push(body);
        if (polls.length >= 2) controller.abort();
        const requests = polls.length === 1 ? [{ requestId, targetKey: 'api', lines: 50, deadlineAt: new Date(Date.now() + 10_000).toISOString() }] : [];
        return Promise.resolve(new Response(JSON.stringify({ requests }), { status: 200 }));
      }
      results.push(body);
      return Promise.resolve(new Response(JSON.stringify({ status: 'recorded' }), { status: 200 }));
    };
    await runLogs(config, controller.signal, { fetchImpl, logger: { info: (e) => logged.push(JSON.stringify(e)), warn: (e) => logged.push(JSON.stringify(e)) }, sleep: (_m, s) => abortableSleep(1, s) });
    expect(polls[0]).toMatchObject({ version: 2, mode: 'allowlist', total: 1, broker: 'ok', targets: [{ targetKey: 'api', matchStatus: 'ok' }] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ version: 1, requestId, outcome: 'ok', stdout: { text: 'line with password=***\nvisible text' } });
    expect(logged.join('\n')).not.toMatch(new RegExp(`visible text|${SECRET}|${TOKEN}`));

    // Old broker: accepts the connection, drops the unknown operation.
    const oldDir = fresh();
    const oldSock = join(oldDir, 'old.sock');
    const old = createServer((s) => { s.on('data', () => { s.destroy(); }); });
    servers.push(old);
    await new Promise<void>((r) => old.listen(oldSock, r));
    const oldConfig = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: oldSock });
    const c2 = new AbortController();
    const oldPolls: Record<string, unknown>[] = [];
    const oldResults: Record<string, unknown>[] = [];
    await runLogs(oldConfig, c2.signal, {
      fetchImpl: (url, init) => {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        if (url.endsWith('/poll')) {
          oldPolls.push(body);
          if (oldPolls.length >= 2) c2.abort();
          return Promise.resolve(new Response(JSON.stringify({ requests: oldPolls.length === 1 ? [{ requestId, targetKey: 'api', lines: 5, deadlineAt: new Date(Date.now() + 10_000).toISOString() }] : [] }), { status: 200 }));
        }
        oldResults.push(body);
        return Promise.resolve(new Response(JSON.stringify({ status: 'recorded' }), { status: 200 }));
      },
      logger: { info: () => undefined, warn: () => undefined }, sleep: (_m, s) => abortableSleep(1, s),
    });
    expect(oldPolls[0]).toMatchObject({ broker: 'unsupported', targets: [] });
    expect(oldResults[0]).toMatchObject({ outcome: 'failed', reason: 'broker_unsupported', stdout: null });
  });

  it('version negotiation (ADR-028): allowlist broker falls back to v1 for an old API; an auto broker never does', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'o.log'), 'auto line\n');
    const p = proc(3, 'api', join(dir, 'o.log'), join(dir, 'e.log'));
    const requestId = randomUUID();
    const run = async (sock: string, api: (body: Record<string, unknown>, n: number) => Response) => {
      const config = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: sock });
      const controller = new AbortController();
      const polls: Record<string, unknown>[] = [];
      const results: Record<string, unknown>[] = [];
      const warned: string[] = [];
      await runLogs(config, controller.signal, {
        fetchImpl: (url, init) => {
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          if (!url.endsWith('/poll')) { results.push(body); return Promise.resolve(new Response(JSON.stringify({ status: 'recorded' }), { status: 200 })); }
          polls.push(body);
          if (polls.length >= 3) controller.abort();
          return Promise.resolve(api(body, polls.length));
        },
        logger: { info: () => undefined, warn: (e) => warned.push(JSON.stringify(e)) }, sleep: (_m, s) => abortableSleep(1, s),
      });
      return { polls, results, warned };
    };
    const oneRequest = (targetKey: string, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ requests: [{ requestId, targetKey, lines: 5, deadlineAt: new Date(Date.now() + 10_000).toISOString() }], ...extra }), { status: 200 });
    const oldApi = (body: Record<string, unknown>, n: number) => (body.version === 2 ? new Response('{}', { status: 400 }) : n === 2 ? oneRequest('api') : new Response('{"requests":[]}', { status: 200 }));

    // Allowlist broker + old API: v2 rejected → the v1 subset; the root-owned allowlist still bounds what is read.
    const al = await run(await broker([dir], p, [entry(p)]), oldApi);
    expect(al.polls.map((x) => x.version)).toEqual([2, 1, 1]);
    expect(al.polls[1]).toEqual({ version: 1, broker: 'ok', daemon: 'ok', allowlist: 'ok', targets: [{ targetKey: 'api', name: 'api', pmId: 3, matchStatus: 'ok' }] });
    expect(al.results).toHaveLength(1);

    // Auto broker + old API: no fallback, nothing served, an explicit warning.
    const autoSock = await broker([dir], p, [], 'auto');
    const au = await run(autoSock, oldApi);
    expect(au.polls.every((x) => x.version === 2 && x.mode === 'auto')).toBe(true);
    expect(au.results).toEqual([]);
    expect(au.warned.join('\n')).toMatch(/does not support scoped access/);

    // Auto broker + new API that does not declare scoped access: requests are ignored (fail closed).
    const key = autoTargetKey('api');
    const unscoped = await run(autoSock, (_b, n) => (n === 1 ? oneRequest(key) : new Response('{"requests":[]}', { status: 200 })));
    expect(unscoped.results).toEqual([]);
    // …and with accessModel 'scoped' the read is served as protocol v2.
    const scoped = await run(autoSock, (_b, n) => (n === 1 ? oneRequest(key, { accessModel: 'scoped' }) : new Response('{"requests":[],"accessModel":"scoped"}', { status: 200 })));
    expect(scoped.polls[0]).toMatchObject({ version: 2, mode: 'auto', total: 1, targets: [{ targetKey: key, name: 'api', matchStatus: 'ok' }] });
    expect(scoped.results).toEqual([expect.objectContaining({ requestId, outcome: 'ok', stdout: expect.objectContaining({ text: 'auto line' }) as unknown })]);
  });

  it('agent: an older API (404) gets the long backoff; no control socket → no log polling', async () => {
    const config = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: join(fresh(), 'none.sock') });
    const controller = new AbortController();
    const delays: number[] = [];
    await runLogs(config, controller.signal, {
      fetchImpl: () => Promise.resolve(new Response('', { status: 404 })),
      sleep: (ms, s) => { delays.push(ms); controller.abort(); return abortableSleep(0, s); }, logger: { info: () => undefined, warn: () => undefined },
    });
    expect(delays).toEqual([900_000]);
    let calls = 0;
    expect(await runLogs(loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN }), new AbortController().signal, {
      fetchImpl: () => { calls += 1; return Promise.reject(new Error('x')); }, logger: { info: () => undefined, warn: () => undefined },
    })).toBe(0);
    expect(calls).toBe(0);
    expect(new BrokerError('connect', false).sent).toBe(false);
  });
});

describe('agent busy-loop guard', () => {
  it('an API answering empty polls instantly still gets ≥ 1 s between polls', async () => {
    const config = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: join(fresh(), 'none.sock') });
    const controller = new AbortController();
    const sleeps: number[] = [];
    let polls = 0;
    await runLogs(config, controller.signal, {
      fetchImpl: () => { polls += 1; if (polls >= 3) controller.abort(); return Promise.resolve(new Response(JSON.stringify({ requests: [] }), { status: 200 })); },
      sleep: (ms, s) => { sleeps.push(ms); return abortableSleep(0, s); }, logger: { info: () => undefined, warn: () => undefined },
    });
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps.every((ms) => ms >= 900 && ms <= 1_000)).toBe(true);
  });
});

// Task 010.1: a reply timeout must not free the slot of a read that is still running (the file/PM2 calls are not
// cancellable), so the real number of unfinished reads never exceeds LOG_LIMITS.maxConcurrentReads.
describe('broker log-read concurrency', () => {
  const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  async function until(check: () => boolean) {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  }

  it('timed-out reads keep their slots; repeated timeouts never raise real concurrency; late resolve/reject free a slot exactly once', async () => {
    const dir = fresh();
    writeFileSync(join(dir, 'o.log'), 'hello\n');
    const p = proc(3, 'api', join(dir, 'o.log'), join(dir, 'e.log'));
    const hung: { resolve: (v: unknown[]) => void; reject: (e: Error) => void; settled: boolean }[] = [];
    let hang = true;
    const list = () => (hang
      ? new Promise<unknown[]>((resolve, reject) => {
        const h = { settled: false, resolve: (v: unknown[]) => { h.settled = true; resolve(v); }, reject: (e: Error) => { h.settled = true; reject(e); } };
        hung.push(h);
      })
      : Promise.resolve([p]));
    const unfinished = () => hung.filter((h) => !h.settled).length;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const events: Record<string, unknown>[] = [];
    const sockDir = fresh();
    const sock = join(sockDir, 'b.sock');
    mkdirSync(join(sockDir, 'j'), { mode: 0o700 });
    const timersBefore = timeouts();
    const broker = createBroker(
      { loadAllowlist: () => Promise.resolve([entry(p)]), list, act: () => Promise.resolve(), journal: new Journal(join(sockDir, 'j')), logDirs: [dir] },
      { info: (e) => events.push(e), warn: (e) => events.push(e) },
      { logReadTimeoutMs: 50 },
    );
    servers.push(broker.server);
    await listenBroker(broker.server, sock);
    const read = () => { const req = logsReq('api'); return brokerCall(sock, req, 8_000, (v) => parseLogsResponse(v, req)) as Promise<LogsResponse>; };
    try {
      // Two reads hang in PM2 list(); both clients get a bounded "timeout" answer.
      expect((await Promise.all([read(), read()])).map((r) => r.reason)).toEqual(['timeout', 'timeout']);
      // The slots stay taken: further reads are refused and start no new underlying operation.
      for (let i = 0; i < 10; i++) expect((await read()).reason).toBe('broker_busy');
      expect(hung).toHaveLength(2);
      expect(broker.logStats()).toEqual({ inFlight: 2, overdue: 2 });
      // Many timeout cycles: each settled read frees exactly one slot; never more than 2 unfinished reads.
      for (let i = 0; i < 5; i++) {
        hung.find((h) => !h.settled)?.resolve([p]);
        await until(() => broker.logStats().inFlight === 1);
        expect((await read()).reason).toBe('timeout');
        expect((await read()).reason).toBe('broker_busy');
        expect(unfinished()).toBe(2);
        expect(broker.logStats().inFlight).toBe(2);
      }
      expect(hung).toHaveLength(7);
      // Late resolve and late reject: each frees its slot once; no second answer, no unhandled rejection.
      const [a, b] = hung.filter((h) => !h.settled);
      a?.resolve([p]);
      await until(() => broker.logStats().inFlight === 1);
      b?.reject(new Error('late failure'));
      await until(() => broker.logStats().inFlight === 0);
      expect(broker.logStats()).toEqual({ inFlight: 0, overdue: 0 });
      // After completion a new read is admitted and succeeds normally.
      hang = false;
      expect(await read()).toMatchObject({ outcome: 'ok', stdout: { text: 'hello' } });
      // The limit is intact after all of this (no double release): 3 at once → 2 run, 1 busy.
      hang = true;
      expect((await Promise.all([read(), read(), read()])).map((r) => r.reason).sort()).toEqual(['broker_busy', 'timeout', 'timeout']);
      expect(unfinished()).toBe(2);
      for (const h of hung) if (!h.settled) h.resolve([p]);
      await until(() => broker.logStats().inFlight === 0);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
      expect(timeouts()).toBeLessThanOrEqual(timersBefore);
      // Hangs are visible as metadata only.
      expect(events.filter((e) => e.msg === 'log read overdue').length).toBeGreaterThanOrEqual(9);
      expect(events.filter((e) => e.msg === 'log read settled late').length).toBeGreaterThanOrEqual(9);
      expect(JSON.stringify(events)).not.toMatch(/hello|late failure/);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 60_000);
});
