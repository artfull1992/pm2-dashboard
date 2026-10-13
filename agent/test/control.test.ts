import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect as createConnectionRaw, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { abortableSleep, runAgent } from '../src/agent.js';
import { loadAgentConfig } from '../src/config.js';
import { type AllowlistEntry, AllowlistError, parseAllowlist, readAllowlist } from '../src/control/allowlist.js';
import { createBroker, listenBroker, loadBrokerConfig } from '../src/control/broker.js';
import { BrokerError, brokerRequest } from '../src/control/client.js';
import { executeCommand, type ExecutorDeps, listTargets, type Pm2ActionMethod } from '../src/control/executor.js';
import { fingerprintOf, matchEntry, viewOf } from '../src/control/identity.js';
import { Journal } from '../src/control/journal.js';
import { type ControlCommand, deliver, parsePollReply, runControl } from '../src/control/loop.js';
import type { BrokerRequest } from '../src/control/protocol.js';
import { RpcError } from '../src/pm2/rpc.js';

const TOKEN = `ncag_${'C'.repeat(43)}`;
const SECRET = 'SYNTHETIC_CONTROL_SECRET_4b2d';
const ME = process.getuid?.() ?? 0;
const root = mkdtempSync(join(tmpdir(), 'nc-ctl-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
let seq = 0;
const freshDir = (mode = 0o700) => { const d = join(root, `d${String(seq++)}`); mkdirSync(d, { mode }); chmodSync(d, mode); return d; };

// ---- a tiny in-memory PM2 -------------------------------------------------------------------------------------
interface FakeProc { pm_id: number; name: string; pm2_env: Record<string, unknown> }
function proc(pmId: number, name: string, status = 'online', extra: Record<string, unknown> = {}): FakeProc {
  return {
    pm_id: pmId, name,
    pm2_env: {
      pm_id: pmId, name, status, restart_time: 2, pm_uptime: 1000, exec_mode: 'fork_mode', instances: 1,
      pm_exec_path: `/srv/${name}/index.js`, pm_cwd: `/srv/${name}`, exec_interpreter: 'node', args: ['--token', SECRET], node_args: [],
      env: { DB_PASSWORD: SECRET }, ...extra,
    },
  };
}
const entryFor = (p: FakeProc, id = p.name, actions: AllowlistEntry['actions'] = ['start', 'stop', 'restart']): AllowlistEntry =>
  ({ id, name: p.name, actions, fingerprint: fingerprintOf(viewOf(p) ?? (() => { throw new Error('x'); })()) });

function fakePm2(procs: FakeProc[]) {
  const calls: [Pm2ActionMethod, number][] = [];
  let down = false;
  let failNext: RpcError | null = null;
  let onAct: ((p: FakeProc, m: Pm2ActionMethod) => void) | null = null;
  return {
    calls,
    procs,
    setDown(v: boolean) { down = v; },
    failNextWith(e: RpcError) { failNext = e; },
    onAct(fn: (p: FakeProc, m: Pm2ActionMethod) => void) { onAct = fn; },
    list: () => (down ? Promise.reject(new RpcError('daemon_not_running')) : Promise.resolve(structuredClone(procs) as unknown[])),
    act: (method: Pm2ActionMethod, pmId: number) => {
      calls.push([method, pmId]);
      if (failNext) { const e = failNext; failNext = null; return Promise.reject(e); }
      const p = procs.find((x) => x.pm_id === pmId);
      if (!p) return Promise.reject(new RpcError('pm2_error'));
      const env = p.pm2_env;
      if (onAct) onAct(p, method);
      else if (method === 'stopProcessId') env.status = 'stopped';
      else if (method === 'startProcessId') env.status = 'online';
      else { if (env.status === 'online') env.restart_time = Number(env.restart_time) + 1; env.status = 'online'; }
      return Promise.resolve();
    },
  };
}

function deps(pm2: ReturnType<typeof fakePm2>, entries: AllowlistEntry[] | (() => Promise<AllowlistEntry[]>), extra: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    loadAllowlist: typeof entries === 'function' ? entries : () => Promise.resolve(entries),
    list: pm2.list, act: pm2.act, journal: new Journal(freshDir()), sleep: () => Promise.resolve(), verifyTimeoutMs: 50, ...extra,
  };
}
const exec = (targetKey: string, action: 'start' | 'stop' | 'restart', over: Partial<Extract<BrokerRequest, { op: 'execute' }>> = {}) =>
  ({ v: 1 as const, op: 'execute' as const, commandId: randomUUID(), targetKey, action, deadlineAt: new Date(Date.now() + 60_000).toISOString(), ...over });

// ---- allowlist ------------------------------------------------------------------------------------------------
describe('allowlist (root-owned, fail closed)', () => {
  const valid = { version: 1, targets: [{ id: 'api-prod', name: 'api', actions: ['restart'], fingerprint: `sha256:${'a'.repeat(64)}` }] };

  it('parses a valid list and rejects anything else', () => {
    expect(parseAllowlist(valid)).toHaveLength(1);
    const bad: unknown[] = [
      { ...valid, extra: 1 }, { version: 2, targets: [] }, { version: 1, targets: [{ ...valid.targets[0], extra: 1 }] },
      { version: 1, targets: [{ ...valid.targets[0], id: 'API' }] }, { version: 1, targets: [{ ...valid.targets[0], actions: ['delete'] }] },
      { version: 1, targets: [{ ...valid.targets[0], actions: [] }] }, { version: 1, targets: [{ ...valid.targets[0], actions: ['stop', 'stop'] }] },
      { version: 1, targets: [{ ...valid.targets[0], fingerprint: 'md5:x' }] }, { version: 1, targets: [{ ...valid.targets[0], name: 'a\u0000b' }] },
      { version: 1, targets: [valid.targets[0], { ...valid.targets[0], name: 'other' }] }, // duplicate id
      { version: 1, targets: [valid.targets[0], { ...valid.targets[0], id: 'other' }] }, // duplicate name → ambiguous config
      { version: 1, targets: Array.from({ length: 51 }, (_, i) => ({ ...valid.targets[0], id: `a${String(i)}`, name: `n${String(i)}` })) },
      { version: 1, targets: [{ ...valid.targets[0], id: '*' }] },
    ];
    for (const b of bad) expect(() => parseAllowlist(b)).toThrow(AllowlistError);
  });

  it('file checks: owner must be the configured owner (root), never the broker itself; no group/other write; no symlink', async () => {
    const dir = freshDir(0o755);
    const file = join(dir, 'allow.json');
    writeFileSync(file, JSON.stringify(valid), { mode: 0o644 });
    // Owned by the test user = the "broker" user here: refused unless the explicit test mode is on.
    await expect(readAllowlist(file, { ownerUid: 0, selfUid: ME })).rejects.toBeInstanceOf(AllowlistError);
    await expect(readAllowlist(file, { ownerUid: ME, selfUid: ME })).rejects.toBeInstanceOf(AllowlistError);
    await expect(readAllowlist(file, { ownerUid: 0, selfUid: ME, allowSelfOwned: true })).resolves.toHaveLength(1);
    // Owned by "someone else" (simulated) as configured: accepted.
    await expect(readAllowlist(file, { ownerUid: ME, selfUid: ME + 1 })).resolves.toHaveLength(1);
    chmodSync(file, 0o664);
    await expect(readAllowlist(file, { ownerUid: ME, selfUid: ME + 1 })).rejects.toBeInstanceOf(AllowlistError);
    chmodSync(file, 0o644);
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    await expect(readAllowlist(link, { ownerUid: ME, selfUid: ME + 1 })).rejects.toBeInstanceOf(AllowlistError);
    await expect(readAllowlist(join(dir, 'missing.json'), { ownerUid: ME, selfUid: ME + 1 })).rejects.toBeInstanceOf(AllowlistError);
    writeFileSync(join(dir, 'big.json'), ' '.repeat(70 * 1024), { mode: 0o644 });
    await expect(readAllowlist(join(dir, 'big.json'), { ownerUid: ME, selfUid: ME + 1 })).rejects.toBeInstanceOf(AllowlistError);
  });
});

// ---- identity -------------------------------------------------------------------------------------------------
describe('process identity', () => {
  it('fingerprint identifies the definition; secrets/paths are only hashed', () => {
    const a = proc(1, 'api');
    const fp = fingerprintOf(viewOf(a) ?? (() => { throw new Error('x'); })());
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fp).not.toContain(SECRET);
    expect(fingerprintOf(viewOf(proc(7, 'api')) ?? (() => { throw new Error('x'); })())).toBe(fp); // pm_id is not part of it
    const moved = proc(1, 'api', 'online', { pm_exec_path: '/srv/other/index.js' });
    expect(fingerprintOf(viewOf(moved) ?? (() => { throw new Error('x'); })())).not.toBe(fp);
  });

  it('matching: exactly one fork process with the allowlisted name and fingerprint', () => {
    const api = proc(1, 'api');
    const e = entryFor(api);
    expect(matchEntry(e, [api, proc(2, 'worker')]).status).toBe('ok');
    expect(matchEntry(e, [proc(2, 'worker')]).status).toBe('not_found');
    expect(matchEntry(e, [api, proc(3, 'api')]).status).toBe('ambiguous'); // duplicate names
    expect(matchEntry(e, [proc(1, 'api', 'online', { exec_mode: 'cluster_mode' })]).status).toBe('cluster_unsupported');
    expect(matchEntry(e, [proc(1, 'api', 'online', { instances: 2 })]).status).toBe('cluster_unsupported');
    // pm_id reuse: the allowlisted app was deleted and a DIFFERENT definition now has the same name/pm_id.
    expect(matchEntry(e, [proc(1, 'api', 'online', { pm_cwd: '/srv/evil' })]).status).toBe('fingerprint_mismatch');
    // Same definition under a new pm_id (deleted + recreated identically) still matches by name + fingerprint.
    const recreated = matchEntry(e, [proc(9, 'api')]);
    expect(recreated.status === 'ok' && recreated.view.pmId).toBe(9);
  });
});

// ---- executor -------------------------------------------------------------------------------------------------
describe('broker executor', () => {
  it('stop / start / restart succeed with verified before/after; nothing secret in results', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    const d = deps(pm2, [entryFor(api)]);
    const stop = await executeCommand(exec('api', 'stop'), d);
    expect(stop).toMatchObject({ outcome: 'succeeded', reason: null, before: { status: 'online' }, after: { status: 'stopped' } });
    const start = await executeCommand(exec('api', 'start'), d);
    expect(start).toMatchObject({ outcome: 'succeeded', before: { status: 'stopped' }, after: { status: 'online' } });
    const restart = await executeCommand(exec('api', 'restart'), d);
    expect(restart).toMatchObject({ outcome: 'succeeded', before: { status: 'online' }, after: { status: 'online' } });
    expect(pm2.calls).toEqual([['stopProcessId', 1], ['startProcessId', 1], ['restartProcessId', 1]]);
    expect(JSON.stringify([stop, start, restart])).not.toMatch(new RegExp(`${SECRET}|/srv`));
  });

  it.each([
    ['not allowlisted', 'other', 'restart', 'not_allowlisted'],
    ['action not allowed', 'api', 'stop', 'action_not_allowed'],
  ] as const)('%s → rejected, PM2 untouched', async (_n, target, action, reason) => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    expect(await executeCommand(exec(target, action), deps(pm2, [entryFor(api, 'api', ['restart'])]))).toMatchObject({ outcome: 'rejected', reason });
    expect(pm2.calls).toEqual([]);
  });

  it('identity/state problems are refused before any PM2 call', async () => {
    const api = proc(1, 'api');
    const e = entryFor(api);
    const cases: [FakeProc[], 'start' | 'stop' | 'restart', string][] = [
      [[api], 'start', 'invalid_state'], // start of an online process
      [[proc(1, 'api', 'stopped')], 'stop', 'invalid_state'],
      [[], 'restart', 'not_found'],
      [[api, proc(2, 'api')], 'restart', 'ambiguous'],
      [[proc(1, 'api', 'online', { exec_mode: 'cluster_mode' })], 'restart', 'cluster_unsupported'],
      [[proc(1, 'api', 'online', { pm_exec_path: '/srv/x.js' })], 'restart', 'fingerprint_mismatch'],
    ];
    for (const [procs, action, reason] of cases) {
      const pm2 = fakePm2(procs);
      expect(await executeCommand(exec('api', action), deps(pm2, [e]))).toMatchObject({ outcome: 'rejected', reason });
      expect(pm2.calls).toEqual([]);
    }
  });

  it('deadline: past → expired; far future → invalid_deadline; invalid allowlist → rejected; no daemon → failed (no auto-start)', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    expect(await executeCommand(exec('api', 'restart', { deadlineAt: new Date(Date.now() - 1000).toISOString() }), deps(pm2, [entryFor(api)]))).toMatchObject({ outcome: 'expired', reason: 'deadline_passed' });
    expect(await executeCommand(exec('api', 'restart', { deadlineAt: new Date(Date.now() + 3_600_000).toISOString() }), deps(pm2, [entryFor(api)]))).toMatchObject({ outcome: 'rejected', reason: 'invalid_deadline' });
    expect(await executeCommand(exec('api', 'restart'), deps(pm2, () => Promise.reject(new AllowlistError('perm'))))).toMatchObject({ outcome: 'rejected', reason: 'allowlist_invalid' });
    pm2.setDown(true);
    expect(await executeCommand(exec('api', 'restart'), deps(pm2, [entryFor(api)]))).toMatchObject({ outcome: 'failed', reason: 'daemon_unavailable' });
    expect(pm2.calls).toEqual([]);
  });

  it('PM2 error → failed; lost connection/timeout after sending → unknown (never success)', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    pm2.failNextWith(new RpcError('pm2_error'));
    expect(await executeCommand(exec('api', 'restart'), deps(pm2, [entryFor(api)]))).toMatchObject({ outcome: 'failed', reason: 'pm2_error' });
    pm2.failNextWith(new RpcError('timeout'));
    expect(await executeCommand(exec('api', 'restart'), deps(pm2, [entryFor(api)]))).toMatchObject({ outcome: 'unknown', reason: 'timeout' });
  });

  it('identity changed during the action → unknown; expected state never reached → failed/verification_failed', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    pm2.onAct((p) => { p.pm2_env.pm_exec_path = '/srv/replaced.js'; });
    expect(await executeCommand(exec('api', 'restart'), deps(pm2, [entryFor(proc(1, 'api'))]))).toMatchObject({ outcome: 'unknown', reason: 'identity_changed' });
    const b = proc(1, 'api');
    const pm2b = fakePm2([b]);
    pm2b.onAct((p) => { p.pm2_env.status = 'launching'; });
    expect(await executeCommand(exec('api', 'restart'), deps(pm2b, [entryFor(proc(1, 'api'))]))).toMatchObject({ outcome: 'failed', reason: 'verification_failed', after: { status: 'launching' } });
    // restart of an online process must show a new start (restart_time/pm_uptime), not merely "online".
    const c = proc(1, 'api');
    const pm2c = fakePm2([c]);
    pm2c.onAct(() => undefined);
    expect(await executeCommand(exec('api', 'restart'), deps(pm2c, [entryFor(proc(1, 'api'))]))).toMatchObject({ outcome: 'failed', reason: 'verification_failed' });
  });

  it('dedup: a redelivered command returns the stored result and never acts twice; a crash mid-action → unknown', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    const d = deps(pm2, [entryFor(api)]);
    const req = exec('api', 'restart');
    const first = await executeCommand(req, d);
    const again = await executeCommand(req, d);
    expect(again).toEqual(first);
    expect(pm2.calls).toHaveLength(1);
    expect(await executeCommand({ ...req, action: 'stop' }, d)).toMatchObject({ outcome: 'rejected', reason: 'command_conflict' });
    // Simulated crash: "started" persisted, "completed" missing.
    const crashed = exec('api', 'restart');
    await d.journal.put({ commandId: crashed.commandId, targetKey: 'api', action: 'restart', state: 'started', at: new Date().toISOString(), result: null });
    expect(await executeCommand(crashed, d)).toMatchObject({ outcome: 'unknown', reason: 'interrupted' });
    expect(await executeCommand(crashed, d)).toMatchObject({ outcome: 'unknown', reason: 'interrupted' });
    expect(pm2.calls).toHaveLength(1);
  });

  it('listTargets reports match status per allowlist entry; invalid allowlist or no daemon is explicit', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api, proc(2, 'dup'), proc(3, 'dup')]);
    const res = await listTargets({ loadAllowlist: () => Promise.resolve([entryFor(api, 'api-prod'), entryFor(proc(2, 'dup'))]), list: pm2.list });
    expect(res).toEqual({ daemon: 'ok', allowlist: 'ok', targets: [
      { targetKey: 'api-prod', name: 'api', pmId: 1, actions: ['start', 'stop', 'restart'], matchStatus: 'ok' },
      { targetKey: 'dup', name: 'dup', pmId: null, actions: ['start', 'stop', 'restart'], matchStatus: 'ambiguous' },
    ] });
    pm2.setDown(true);
    expect((await listTargets({ loadAllowlist: () => Promise.resolve([entryFor(api)]), list: pm2.list })).targets[0]?.matchStatus).toBe('daemon_unavailable');
    expect(await listTargets({ loadAllowlist: () => Promise.reject(new AllowlistError('x')), list: pm2.list })).toEqual({ daemon: 'ok', allowlist: 'invalid', targets: [] });
  });
});

// ---- journal --------------------------------------------------------------------------------------------------
describe('journal', () => {
  it('atomic files, strict directory, bounded retention', async () => {
    const dir = freshDir(0o700);
    const j = new Journal(dir);
    await j.verify();
    const id = randomUUID();
    await j.put({ commandId: id, targetKey: 'api', action: 'restart', state: 'started', at: new Date().toISOString(), result: null });
    expect((await j.get(id))?.state).toBe('started');
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
    expect(lstatSync(join(dir, `${id}.json`)).mode & 0o777).toBe(0o600);
    expect(await j.prune(Date.now() + 8 * 24 * 3600 * 1000)).toBe(1);
    expect(await j.get(id)).toBeNull();
    await expect(j.get('../etc/passwd')).rejects.toThrow();
    chmodSync(dir, 0o750);
    await expect(j.verify()).rejects.toThrow();
  });
});

// ---- broker socket ----------------------------------------------------------------------------------------------
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); }))); });

describe('broker socket', () => {
  async function startBroker(d: ExecutorDeps) {
    const dir = freshDir(0o750);
    const sock = join(dir, 'b.sock');
    const { server } = createBroker(d, { info: () => undefined, warn: () => undefined });
    servers.push(server);
    await listenBroker(server, sock);
    return sock;
  }

  it('socket is 0660 in a closed directory; list and execute work; garbage is dropped', async () => {
    const api = proc(1, 'api');
    const pm2 = fakePm2([api]);
    const sock = await startBroker(deps(pm2, [entryFor(api)]));
    expect(lstatSync(sock).mode & 0o777).toBe(0o660);
    const list = await brokerRequest(sock, { v: 1, op: 'list' }, 2000);
    expect(list).toMatchObject({ op: 'list', daemon: 'ok', targets: [{ targetKey: 'api', matchStatus: 'ok', pmId: 1 }] });
    const req = exec('api', 'stop');
    expect(await brokerRequest(sock, req, 5000)).toMatchObject({ op: 'execute', outcome: 'succeeded' });
    // A free-text "command" or unknown op is not a request at all.
    for (const garbage of ['{"v":1,"op":"shell","cmd":"rm -rf /"}\n', '{"v":1,"op":"execute","commandId":"x"}\n', 'not json\n']) {
      const reply = await new Promise<string>((resolve) => {
        let data = '';
        const s = createConnectionRaw({ path: sock });
        s.on('data', (c) => { data += String(c); });
        s.on('close', () => { resolve(data); });
        s.write(garbage);
      });
      expect(reply).toBe('');
    }
    expect(pm2.calls).toHaveLength(1);
  });

  it('executions are serialised (never two PM2 actions at once); beyond the queue → broker_busy', async () => {
    const procs = Array.from({ length: 6 }, (_, i) => proc(i, `app${String(i)}`));
    const pm2 = fakePm2(procs);
    let inFlight = 0;
    let maxInFlight = 0;
    const slowAct = async (m: Pm2ActionMethod, id: number) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return pm2.act(m, id);
    };
    const sock = await startBroker({ ...deps(pm2, procs.map((p) => entryFor(p))), act: slowAct });
    const results = await Promise.all(procs.map((p) => brokerRequest(sock, exec(p.name, 'stop'), 10_000)));
    expect(maxInFlight).toBe(1);
    const outcomes = results.map((r) => (r.op === 'execute' ? r.outcome : 'x'));
    expect(outcomes.filter((o) => o === 'succeeded').length).toBeGreaterThanOrEqual(4);
    expect(results.some((r) => r.op === 'execute' && r.reason === 'broker_busy')).toBe(true);
  });

  it('refuses to listen in a directory open to others or over a foreign file', async () => {
    const open = freshDir(0o755);
    const { server } = createBroker(deps(fakePm2([]), []), { info: () => undefined, warn: () => undefined });
    await expect(listenBroker(server, join(open, 'b.sock'))).rejects.toThrow(/closed to others/);
    const dir = freshDir(0o750);
    writeFileSync(join(dir, 'b.sock'), 'x');
    await expect(listenBroker(server, join(dir, 'b.sock'))).rejects.toThrow(/occupied/);
  });

  it('broker config: root refused; socket outside PM2_HOME; allowlist required', () => {
    expect(() => loadBrokerConfig({ NC_PM2_HOME: '/home/u/.pm2', NC_BROKER_ALLOWLIST: '/etc/x.json' }, 0)).toThrow();
    expect(() => loadBrokerConfig({ NC_PM2_HOME: '/home/u/.pm2', NC_BROKER_ALLOWLIST: '/etc/x.json', NC_BROKER_SOCKET: '/home/u/.pm2/b.sock' }, 1000)).toThrow();
    expect(() => loadBrokerConfig({ NC_PM2_HOME: '/home/u/.pm2' }, 1000)).toThrow();
    expect(loadBrokerConfig({ NC_PM2_HOME: '/home/u/.pm2', NC_BROKER_ALLOWLIST: '/etc/x.json' }, 1000)).toMatchObject({
      socketPath: '/run/goit-node-control-pm2-broker/broker.sock', journalDir: '/var/lib/goit-node-control-pm2-broker', allowSelfOwnedAllowlist: false,
    });
  });
});


// ---- agent side -------------------------------------------------------------------------------------------------
describe('agent control delivery', () => {
  const cmd = (attempt = 1): ControlCommand => ({ id: randomUUID(), attempt, targetKey: 'api', action: 'restart', deadlineAt: new Date(Date.now() + 60_000).toISOString() });

  it('client distinguishes "never sent" from "sent, no answer"', async () => {
    await expect(brokerRequest(join(freshDir(), 'missing.sock'), { v: 1, op: 'list' }, 500)).rejects.toMatchObject({ kind: 'connect', sent: false });
    const dir = freshDir(0o750);
    const sock = join(dir, 's.sock');
    const silent = createServer((s) => { s.on('data', () => { s.destroy(); }); });
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(sock, r));
    await expect(brokerRequest(sock, { v: 1, op: 'list' }, 1000)).rejects.toMatchObject({ sent: true });
  });

  it('only a first delivery that provably never reached the broker is reported (as rejected); otherwise nothing', async () => {
    const neverSent = () => Promise.reject(new BrokerError('connect', false));
    const lost = () => Promise.reject(new BrokerError('transport', true));
    expect(await deliver('/x', cmd(1), neverSent)).toMatchObject({ outcome: 'rejected', reason: 'broker_unavailable' });
    expect(await deliver('/x', cmd(2), neverSent)).toBeNull();
    expect(await deliver('/x', cmd(1), lost)).toBeNull();
  });

  it('poll reply contract', () => {
    const ok = { controlEnabled: true, commands: [{ id: randomUUID(), attempt: 1, targetKey: 'api', action: 'restart', deadlineAt: new Date().toISOString() }], intervalSeconds: 10 };
    expect(parsePollReply(JSON.stringify(ok))).not.toBeNull();
    for (const bad of [{ ...ok, commands: [ok.commands[0], ok.commands[0]] }, { ...ok, intervalSeconds: 1 },
      { ...ok, commands: [{ ...ok.commands[0], action: 'delete' }] }, { ...ok, commands: [{ ...ok.commands[0], cmd: 'rm' }] },
      { ...ok, commands: [{ ...ok.commands[0], attempt: 4 }] }]) {
      expect(parsePollReply(JSON.stringify(bad))).toBeNull();
    }
  });

  it('loop: poll → broker → result; the acknowledgement is retried, the action is not; heartbeat is never blocked', async () => {
    const config = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: '/run/b.sock' });
    const command = cmd(1);
    const executed: string[] = [];
    const results: unknown[] = [];
    let resultCalls = 0;
    let heartbeats = 0;
    let polls = 0;
    const controller = new AbortController();
    const fetchImpl = (url: string, init: RequestInit) => {
      if (url.endsWith('/api/agent/heartbeat')) {
        heartbeats += 1;
        if (heartbeats >= 3 && resultCalls >= 3) controller.abort();
        return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', receivedAt: new Date().toISOString(), intervalSeconds: 5 }), { status: 200 }));
      }
      if (url.endsWith('/api/agent/control/poll')) {
        polls += 1;
        const body = JSON.parse(init.body as string) as { targets: unknown[] };
        expect(body.targets).toHaveLength(1);
        return Promise.resolve(new Response(JSON.stringify({ controlEnabled: true, commands: polls === 1 ? [command] : [], intervalSeconds: 5 }), { status: 200 }));
      }
      resultCalls += 1;
      results.push(JSON.parse(init.body as string));
      // The first two acknowledgements fail (API hiccup); the third is accepted.
      return Promise.resolve(resultCalls < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ status: 'recorded' }), { status: 200 }));
    };
    const broker: typeof brokerRequest = (_s, req) => {
      if (req.op === 'list') return Promise.resolve({ v: 1, op: 'list', daemon: 'ok', allowlist: 'ok', targets: [{ targetKey: 'api', name: 'api', pmId: 1, actions: ['restart'], matchStatus: 'ok' }] });
      executed.push(req.commandId);
      return Promise.resolve({ v: 1, op: 'execute', commandId: req.commandId, outcome: 'succeeded', reason: null, before: { status: 'online' }, after: { status: 'online' } });
    };
    const logged: string[] = [];
    const logger = { info: (e: Record<string, unknown>) => logged.push(JSON.stringify(e)), warn: (e: Record<string, unknown>) => logged.push(JSON.stringify(e)) };
    const sleep = (_ms: number, s: AbortSignal) => abortableSleep(1, s);
    await Promise.all([
      runAgent(config, controller.signal, { fetchImpl, sleep, logger }),
      runControl(config, controller.signal, { fetchImpl, broker, sleep, logger }),
    ]);
    expect(executed).toEqual([command.id]);
    expect(resultCalls).toBe(3);
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(heartbeats).toBeGreaterThanOrEqual(3);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('control disabled in the Agent (no NC_AGENT_CONTROL_SOCKET) → no polling at all', async () => {
    const config = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN });
    expect(config.control).toBeNull();
    let calls = 0;
    expect(await runControl(config, new AbortController().signal, { fetchImpl: () => { calls += 1; return Promise.reject(new Error('x')); }, logger: { info: () => undefined, warn: () => undefined } })).toBe(0);
    expect(calls).toBe(0);
    expect(() => loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_CONTROL_SOCKET: 'rel.sock' })).toThrow(/CONTROL_SOCKET/);
  });
});
