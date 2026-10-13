import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { abortableSleep, runAgent } from '../src/agent.js';
import { type AgentConfig, loadAgentConfig } from '../src/config.js';
import { INVENTORY_FORMAT, INVENTORY_LIMITS, type InventorySnapshot, parseInventorySnapshot } from '../src/inventory/contract.js';
import {
  buildInventoryReport, inventoryDelaySeconds, type InventoryOutcome, parseInventoryReply, runInventory,
} from '../src/inventory/report.js';
import { readSnapshotSecure, SnapshotFileError, writeSnapshotAtomic } from '../src/inventory/snapshot-file.js';
import { collectInventory, ExporterConfigError, loadExporterConfig, runExporter } from '../src/pm2/exporter.js';
import { decodeFrame, encodeFrame, getMonitorData, RpcError } from '../src/pm2/rpc.js';
import { InventoryDataError, sanitizeName, sanitizeProcessList } from '../src/pm2/sanitize.js';

const TOKEN = `ncag_${'S'.repeat(43)}`;
const SECRET = 'SYNTHETIC_PM2_SECRET_value_9c1e';
const ME = process.getuid?.() ?? 0;
const OTHER_UID = ME + 4242;
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const root = mkdtempSync(join(tmpdir(), 'nc-inv-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });
let seq = 0;
const freshDir = (mode = 0o750) => { const d = join(root, `d${String(seq++)}`); mkdirSync(d, { mode }); chmodSync(d, mode); return d; };

/** A raw PM2 getMonitorData entry with secrets everywhere the exporter must NOT look. */
function rawProcess(pmId: number, overrides: Record<string, unknown> = {}, env: Record<string, unknown> = {}) {
  return {
    pid: 4321, name: `app-${String(pmId)}`, pm_id: pmId,
    monit: { cpu: 12.345, memory: 104_857_600 },
    pm2_env: {
      name: `app-${String(pmId)}`, pm_id: pmId, status: 'online', pm_uptime: NOW - 3_600_000, restart_time: 3, exec_mode: 'fork_mode',
      env: { DB_PASSWORD: SECRET, API_TOKEN: SECRET }, DB_PASSWORD: SECRET, args: ['--token', SECRET], node_args: [SECRET],
      pm_cwd: `/srv/${SECRET}`, pm_exec_path: `/srv/${SECRET}/index.js`, pm_out_log_path: `/var/log/${SECRET}.log`,
      pm_err_log_path: `/var/log/${SECRET}.err`, axm_options: { secret: SECRET }, versioning: { url: `https://u:${SECRET}@git` },
      ...env,
    },
    ...overrides,
  };
}

const snapshotOk = (processes: InventorySnapshot['processes'], capturedAt = new Date(NOW).toISOString()): InventorySnapshot =>
  ({ format: INVENTORY_FORMAT, version: 1, source: 'pm2', capturedAt, state: 'ok', reason: null, processes });

describe('sanitisation (allowlist serialisation)', () => {
  it('copies only allowlisted fields: no env, args, paths, logs or other pm2_env content', () => {
    const out = sanitizeProcessList([rawProcess(1), rawProcess(0)], NOW);
    expect(out).toEqual([
      { pmId: 0, name: 'app-0', status: 'online', uptimeSeconds: 3600, restarts: 3, cpuPercent: 12.3, memoryBytes: 104_857_600, execMode: 'fork' },
      { pmId: 1, name: 'app-1', status: 'online', uptimeSeconds: 3600, restarts: 3, cpuPercent: 12.3, memoryBytes: 104_857_600, execMode: 'fork' },
    ]);
    const text = JSON.stringify(out);
    for (const forbidden of [SECRET, 'srv', 'log', 'args', 'env', 'cwd', 'pid', 'axm', 'versioning']) expect(text).not.toContain(forbidden);
  });

  it('missing/implausible metrics become null, never a made-up 0', () => {
    const [stopped] = sanitizeProcessList([rawProcess(1, { monit: { cpu: 0, memory: 0 } }, { status: 'stopped' })], NOW);
    expect(stopped).toMatchObject({ status: 'stopped', uptimeSeconds: null, cpuPercent: null, memoryBytes: null });
    const [odd] = sanitizeProcessList([rawProcess(2, { monit: { cpu: -1, memory: 1.5 } }, { pm_uptime: NOW + 3_600_000, restart_time: 'x', exec_mode: 'weird', status: 'hacked' })], NOW);
    expect(odd).toMatchObject({ status: 'unknown', uptimeSeconds: null, restarts: null, cpuPercent: null, memoryBytes: null, execMode: null });
    const [ancient] = sanitizeProcessList([rawProcess(3, {}, { pm_uptime: 1 })], NOW);
    expect(ancient?.uptimeSeconds).toBeNull();
    const [noMonit] = sanitizeProcessList([rawProcess(4, { monit: undefined })], NOW);
    expect(noMonit).toMatchObject({ cpuPercent: null, memoryBytes: null });
  });

  it('cluster mode is reported; small clock skew gives 0 uptime, not negative', () => {
    const [p] = sanitizeProcessList([rawProcess(5, {}, { exec_mode: 'cluster_mode', pm_uptime: NOW + 30_000 })], NOW);
    expect(p).toMatchObject({ execMode: 'cluster', uptimeSeconds: 0 });
  });

  it('names: control characters replaced, length bounded without splitting surrogate pairs, empty → invalid', () => {
    expect(sanitizeName('api\u0000\u001b[31m\u007f')).toBe('api��[31m�');
    const long = sanitizeName('😀'.repeat(100));
    expect(long?.length).toBe(128);
    expect(long).toBe('😀'.repeat(64));
    expect(sanitizeName('a\uD800b')).toBe('a�b');
    expect(sanitizeName('   ')).toBeNull();
    expect(sanitizeName(42)).toBeNull();
    expect(() => sanitizeProcessList([rawProcess(1, { name: undefined }, { name: undefined })], NOW)).toThrow(InventoryDataError);
  });

  it('duplicate pm_id, invalid pm_id, non-array and too many processes are rejected as a whole', () => {
    expect(() => sanitizeProcessList([rawProcess(1), rawProcess(1)], NOW)).toThrow(/invalid_data/);
    expect(() => sanitizeProcessList([rawProcess(1, { pm_id: -1 }, { pm_id: -1 })], NOW)).toThrow(/invalid_data/);
    expect(() => sanitizeProcessList({ length: 1 }, NOW)).toThrow(/invalid_data/);
    expect(() => sanitizeProcessList([null], NOW)).toThrow(/invalid_data/);
    expect(() => sanitizeProcessList(Array.from({ length: 3 }, (_, i) => rawProcess(i)), NOW, 2)).toThrow(/too_many_processes/);
  });
});

describe('snapshot contract', () => {
  const valid = () => snapshotOk(sanitizeProcessList([rawProcess(0)], NOW));
  it('accepts a valid snapshot and rejects anything off-contract', () => {
    expect(parseInventorySnapshot(valid())).not.toBeNull();
    expect(parseInventorySnapshot({ ...valid(), extra: 1 })).toBeNull();
    expect(parseInventorySnapshot({ ...valid(), version: 2 })).toBeNull();
    expect(parseInventorySnapshot({ ...valid(), format: 'x' })).toBeNull();
    expect(parseInventorySnapshot({ ...valid(), source: 'Bad Source' })).toBeNull();
    expect(parseInventorySnapshot({ ...valid(), capturedAt: '2026-02-31T00:00:00.000Z' })).toBeNull();
    expect(parseInventorySnapshot({ ...valid(), reason: 'timeout' })).toBeNull();
    expect(parseInventorySnapshot({ ...valid(), state: 'unavailable', reason: 'timeout' })).toBeNull(); // processes must be empty
    expect(parseInventorySnapshot({ ...valid(), state: 'unavailable', reason: 'nope', processes: [] })).toBeNull();
    const dup = valid();
    expect(parseInventorySnapshot({ ...dup, processes: [...dup.processes, ...dup.processes] })).toBeNull();
    expect(parseInventorySnapshot({ ...dup, processes: [{ ...dup.processes[0], env: { x: 1 } }] })).toBeNull();
    expect(parseInventorySnapshot({ ...dup, processes: Array.from({ length: INVENTORY_LIMITS.maxProcesses + 1 }, (_, i) => ({ ...dup.processes[0], pmId: i })) })).toBeNull();
    expect(parseInventorySnapshot(null)).toBeNull();
  });
});

// A fake PM2 daemon RPC endpoint speaking the axon/amp wire format on a unix socket.
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); }))); });

function fakeDaemon(socketPath: string, respond: (request: unknown[], socket: Socket) => void): Promise<{ requests: unknown[][] }> {
  const requests: unknown[][] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const frame = decodeFrame(buf);
      if ('need' in frame) return;
      requests.push(frame.args);
      respond(frame.args, socket);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => { resolve({ requests }); }));
}

describe('PM2 RPC client (existing daemon only)', () => {
  it('sends exactly one getMonitorData call and returns the raw result (reply delivered byte by byte)', async () => {
    const sock = join(freshDir(), 'rpc.sock');
    const daemon = await fakeDaemon(sock, (req, socket) => {
      const reply = encodeFrame([{ args: [[rawProcess(0)]] }, req[1] as string]);
      let i = 0;
      const drip = () => { if (i < reply.length) { socket.write(reply.subarray(i, i + 1)); i += 1; setImmediate(drip); } };
      drip();
    });
    const raw = await getMonitorData({ socketPath: sock, timeoutMs: 5000 });
    expect(Array.isArray(raw) && (raw as unknown[]).length).toBe(1);
    expect(daemon.requests).toHaveLength(1);
    expect(daemon.requests[0]?.[0]).toEqual({ type: 'call', method: 'getMonitorData', args: [{}] });
  });

  it('missing socket / stale socket file → daemon_not_running; nothing is created', async () => {
    const dir = freshDir();
    await expect(getMonitorData({ socketPath: join(dir, 'rpc.sock'), timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'daemon_not_running' });
    writeFileSync(join(dir, 'stale.sock'), '');
    await expect(getMonitorData({ socketPath: join(dir, 'stale.sock'), timeoutMs: 1000 })).rejects.toMatchObject({ reason: 'daemon_not_running' });
    expect(readdirSync(dir)).toEqual(['stale.sock']);
  });

  it('error reply, wrong id, oversized frame, garbage and silence are protocol errors / timeout', async () => {
    const cases: [(req: unknown[], s: Socket) => void, string][] = [
      [(req, s) => { s.write(encodeFrame([{ error: `boom ${SECRET}` }, req[1] as string])); }, 'protocol_error'],
      [(_req, s) => { s.write(encodeFrame([{ args: [[]] }, 'someone-else:1'])); }, 'protocol_error'],
      [(_req, s) => { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(0xffffffff, 1); s.write(b); }, 'protocol_error'],
      [(_req, s) => { s.write(Buffer.from([0x71, 0, 0, 0, 1, 0x41])); }, 'protocol_error'],
      [(_req, s) => { s.end(); }, 'protocol_error'],
      [() => undefined, 'timeout'],
    ];
    for (const [respond, reason] of cases) {
      const sock = join(freshDir(), 'rpc.sock');
      await fakeDaemon(sock, respond);
      const error = await getMonitorData({ socketPath: sock, timeoutMs: 300 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).reason).toBe(reason);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it('reply larger than the bound is refused', async () => {
    const sock = join(freshDir(), 'rpc.sock');
    await fakeDaemon(sock, (req, s) => { s.write(encodeFrame([{ args: [['x'.repeat(2048)]] }, req[1] as string])); });
    await expect(getMonitorData({ socketPath: sock, timeoutMs: 2000, maxReplyBytes: 1024 })).rejects.toMatchObject({ reason: 'protocol_error' });
  });
});

describe('exporter', () => {
  const config = (home: string, file: string) => loadExporterConfig({ NC_PM2_HOME: home, NC_PM2_SNAPSHOT_FILE: file }, ME === 0 ? 1000 : ME);

  it('configuration: root refused, paths absolute/normalized, snapshot outside PM2_HOME, bounded settings', () => {
    const issues = (env: Record<string, string>, uid = 1000) => { try { loadExporterConfig(env, uid); return []; } catch (e) { return (e as ExporterConfigError).issues; } };
    expect(issues({ NC_PM2_HOME: '/home/a/.pm2', NC_PM2_SNAPSHOT_FILE: '/var/lib/x/i.json' })).toEqual([]);
    expect(issues({ NC_PM2_HOME: '/home/a/.pm2', NC_PM2_SNAPSHOT_FILE: '/var/lib/x/i.json' }, 0).join()).toMatch(/root/);
    expect(issues({ NC_PM2_HOME: 'rel/.pm2', NC_PM2_SNAPSHOT_FILE: '/var/lib/x/i.json' }).join()).toMatch(/NC_PM2_HOME/);
    expect(issues({ NC_PM2_HOME: '/home/a/../b/.pm2', NC_PM2_SNAPSHOT_FILE: '/var/lib/x/i.json' }).join()).toMatch(/NC_PM2_HOME/);
    expect(issues({ NC_PM2_HOME: '/home/a/.pm2', NC_PM2_SNAPSHOT_FILE: '/home/a/.pm2/i.json' }).join()).toMatch(/inside/);
    expect(issues({ NC_PM2_HOME: '/home/a/.pm2', NC_PM2_SNAPSHOT_FILE: '/var/lib/x/i.json', NC_PM2_SOURCE: 'A B' }).join()).toMatch(/SOURCE/);
    expect(issues({ NC_PM2_HOME: '/home/a/.pm2', NC_PM2_SNAPSHOT_FILE: '/var/lib/x/i.json', NC_PM2_TIMEOUT_SECONDS: '999' }).join()).toMatch(/TIMEOUT/);
  });

  it('no daemon (no rpc.sock) → unavailable/daemon_not_running; PM2 is not contacted or started, PM2_HOME unchanged', async () => {
    const home = freshDir(0o700);
    writeFileSync(join(home, 'dump.pm2'), '[]');
    let called = 0;
    const result = await collectInventory(config(home, join(freshDir(), 'i.json')), { uid: ME, now: () => NOW, fetchMonitorData: () => { called += 1; return Promise.resolve([]); } });
    expect(result).toMatchObject({ state: 'unavailable', reason: 'daemon_not_running', processes: [] });
    expect(called).toBe(0);
    expect(readdirSync(home)).toEqual(['dump.pm2']);
  });

  it('the exporter code cannot start PM2: no pm2 package, no child processes, only getMonitorData', () => {
    const src = join(import.meta.dirname, '..', 'src');
    for (const file of ['pm2/rpc.ts', 'pm2/exporter.ts', 'pm2/sanitize.ts', 'pm2-exporter.ts', 'inventory/snapshot-file.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text).not.toMatch(/from ['"](node:)?child_process['"]|from ['"]pm2['"]|require\(/);
    }
    const rpc = readFileSync(join(src, 'pm2/rpc.ts'), 'utf8');
    expect(rpc.match(/method: '([A-Za-z]+)'/g)).toEqual(["method: 'getMonitorData'"]);
  });

  it('PM2_HOME / socket that are not ours or not what they claim → pm2_home_invalid', async () => {
    const home = freshDir(0o700);
    const cfg = config(home, join(freshDir(), 'i.json'));
    expect(await collectInventory(cfg, { uid: OTHER_UID })).toMatchObject({ reason: 'pm2_home_invalid' });
    writeFileSync(join(home, 'rpc.sock'), '');
    expect(await collectInventory(cfg, { uid: ME })).toMatchObject({ reason: 'pm2_home_invalid' });
    expect(await collectInventory(config(join(root, 'missing-home'), join(freshDir(), 'i.json')), { uid: ME })).toMatchObject({ reason: 'pm2_home_invalid' });
  });

  it('end to end against a fake daemon: sanitised snapshot written atomically, no secret on disk', async () => {
    const home = freshDir(0o700);
    await fakeDaemon(join(home, 'rpc.sock'), (req, s) => { s.write(encodeFrame([{ args: [[rawProcess(0), rawProcess(1, {}, { status: 'errored' })]] }, req[1] as string])); });
    const out = join(freshDir(), 'inventory.json');
    const { snapshot } = await runExporter(config(home, out), { uid: ME, now: () => NOW });
    expect(snapshot).toMatchObject({ state: 'ok', processes: [{ pmId: 0 }, { pmId: 1, status: 'errored', cpuPercent: null }] });
    const disk = readFileSync(out, 'utf8');
    expect(disk).not.toContain(SECRET);
    expect(lstatSync(out).mode & 0o777).toBe(0o640);
  });

  it('daemon problems become metadata-only unavailable reasons', async () => {
    const home = freshDir(0o700);
    await fakeDaemon(join(home, 'rpc.sock'), (req, s) => { s.write(encodeFrame([{ args: [[rawProcess(0), rawProcess(0)]] }, req[1] as string])); });
    expect(await collectInventory(config(home, join(freshDir(), 'i.json')), { uid: ME, now: () => NOW })).toMatchObject({ state: 'unavailable', reason: 'invalid_data', processes: [] });
  });
});

describe('snapshot file security', () => {
  it('atomic write: 0640, no temp files left, old snapshot replaced', async () => {
    const dir = freshDir();
    const file = join(dir, 'inventory.json');
    await writeSnapshotAtomic(file, snapshotOk([]), ME);
    await writeSnapshotAtomic(file, snapshotOk([], '2026-10-13T12:00:30.000Z'), ME);
    expect(readdirSync(dir)).toEqual(['inventory.json']);
    expect(lstatSync(file).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ capturedAt: '2026-10-13T12:00:30.000Z' });
  });

  it('writer refuses: group-writable dir, foreign dir, symlinked target, relative path', async () => {
    const writable = freshDir(0o770);
    await expect(writeSnapshotAtomic(join(writable, 'i.json'), snapshotOk([]), ME)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
    await expect(writeSnapshotAtomic(join(freshDir(), 'i.json'), snapshotOk([]), OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
    const dir = freshDir();
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(dir, 'i.json'));
    await expect(writeSnapshotAtomic(join(dir, 'i.json'), snapshotOk([]), ME)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    await expect(writeSnapshotAtomic('rel/i.json', snapshotOk([]), ME)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
  });

  async function written(mode = 0o640) {
    const dir = freshDir();
    const file = join(dir, 'inventory.json');
    await writeSnapshotAtomic(file, snapshotOk(sanitizeProcessList([rawProcess(0)], NOW)), ME);
    chmodSync(file, mode);
    return { dir, file };
  }

  it('reader accepts a file written by another user (simulated) and validates it', async () => {
    const { file } = await written();
    await expect(readSnapshotSecure(file, OTHER_UID)).resolves.toMatchObject({ state: 'ok', processes: [{ pmId: 0 }] });
  });

  it('reader refuses: own file (Agent could forge it), symlink, group/other-writable, missing, oversized, malformed', async () => {
    const { dir, file } = await written();
    await expect(readSnapshotSecure(file, ME)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
    await expect(readSnapshotSecure(file, ME, { allowSameOwner: true })).resolves.toMatchObject({ state: 'ok' });
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    await expect(readSnapshotSecure(link, OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
    chmodSync(file, 0o662);
    await expect(readSnapshotSecure(file, OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
    await expect(readSnapshotSecure(join(dir, 'nope.json'), OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_missing' });
    await expect(readSnapshotSecure(join(root, 'no-dir', 'i.json'), OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_missing' });
    const big = join(freshDir(), 'big.json');
    writeFileSync(big, ' '.repeat(INVENTORY_LIMITS.maxFileBytes + 1), { mode: 0o640 });
    await expect(readSnapshotSecure(big, OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_invalid' });
    const bad = join(freshDir(), 'bad.json');
    writeFileSync(bad, '{"format":', { mode: 0o640 });
    await expect(readSnapshotSecure(bad, OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_invalid' });
    const offContract = join(freshDir(), 'off.json');
    writeFileSync(offContract, JSON.stringify({ ...snapshotOk([]), env: { x: SECRET } }), { mode: 0o640 });
    await expect(readSnapshotSecure(offContract, OTHER_UID)).rejects.toBeInstanceOf(SnapshotFileError);
  });

  it('reader refuses a group-writable directory', async () => {
    const { dir, file } = await written();
    chmodSync(dir, 0o770);
    await expect(readSnapshotSecure(file, OTHER_UID)).rejects.toMatchObject({ reason: 'snapshot_insecure' });
  });
});

const agentConfig = (file: string, extra: Record<string, string> = {}): AgentConfig => loadAgentConfig({
  NC_AGENT_API_URL: 'https://nodecontrol.example.test', NC_AGENT_TOKEN: TOKEN, NC_AGENT_INVENTORY_FILE: file, ...extra,
});

describe('agent inventory configuration', () => {
  it('disabled without NC_AGENT_INVENTORY_FILE; bounded settings; same-owner only in loopback test mode', () => {
    expect(loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN }).inventory).toBeNull();
    expect(agentConfig('/var/lib/goit-node-control-pm2/inventory.json').inventory).toEqual({
      file: '/var/lib/goit-node-control-pm2/inventory.json', intervalSeconds: 60, maxAgeSeconds: 120, allowSameOwner: false,
    });
    expect(() => agentConfig('relative.json')).toThrow(/NC_AGENT_INVENTORY_FILE/);
    expect(() => agentConfig('/a/i.json', { NC_AGENT_INVENTORY_INTERVAL_SECONDS: '5' })).toThrow(/INTERVAL/);
    expect(() => agentConfig('/a/i.json', { NC_AGENT_INVENTORY_ALLOW_SAME_OWNER: 'true' })).toThrow(/only allowed/);
    const dev = loadAgentConfig({
      NC_AGENT_API_URL: 'http://127.0.0.1:3100', NC_AGENT_ALLOW_INSECURE_LOOPBACK: 'true', NC_AGENT_TOKEN: TOKEN,
      NC_AGENT_INVENTORY_FILE: '/a/i.json', NC_AGENT_INVENTORY_ALLOW_SAME_OWNER: 'true',
    });
    expect(dev.inventory?.allowSameOwner).toBe(true);
  });
});

describe('agent inventory report', () => {
  const inv = { file: '/x/i.json', intervalSeconds: 60, maxAgeSeconds: 120, allowSameOwner: false };
  const reading = (s: InventorySnapshot) => () => Promise.resolve(s);
  const processes = sanitizeProcessList([rawProcess(0)], NOW);

  it('fresh ok → ok with processes; old → stale WITHOUT processes; future → invalid; unavailable forwarded; file errors forwarded', async () => {
    expect(await buildInventoryReport(inv, NOW + 10_000, reading(snapshotOk(processes)))).toMatchObject({ state: 'ok', processes: [{ pmId: 0 }] });
    expect(await buildInventoryReport(inv, NOW + 121_000, reading(snapshotOk(processes)))).toEqual({
      version: 1, state: 'stale', reason: null, source: 'pm2', capturedAt: new Date(NOW).toISOString(), processes: [],
    });
    expect(await buildInventoryReport(inv, NOW - 600_000, reading(snapshotOk(processes)))).toMatchObject({ state: 'unavailable', reason: 'snapshot_invalid', processes: [] });
    const down: InventorySnapshot = { format: INVENTORY_FORMAT, version: 1, source: 'pm2', capturedAt: new Date(NOW).toISOString(), state: 'unavailable', reason: 'daemon_not_running', processes: [] };
    expect(await buildInventoryReport(inv, NOW, reading(down))).toMatchObject({ state: 'unavailable', reason: 'daemon_not_running', source: 'pm2' });
    expect(await buildInventoryReport(inv, NOW, () => Promise.reject(new SnapshotFileError('snapshot_missing')))).toEqual({
      version: 1, state: 'unavailable', reason: 'snapshot_missing', source: null, capturedAt: null, processes: [],
    });
    expect(await buildInventoryReport(inv, NOW, () => Promise.reject(new Error('boom')))).toMatchObject({ reason: 'snapshot_invalid' });
  });

  it('reply contract: accepted/ignored, ISO receivedAt, interval 30..600', () => {
    const ok = { status: 'accepted', receivedAt: '2026-10-13T12:00:00.000Z', intervalSeconds: 60 };
    expect(parseInventoryReply(JSON.stringify(ok))).toEqual({ status: 'accepted', intervalSeconds: 60 });
    expect(parseInventoryReply(JSON.stringify({ ...ok, status: 'ignored' }))).toEqual({ status: 'ignored', intervalSeconds: 60 });
    for (const bad of ['', 'null', '[]', JSON.stringify({ ...ok, status: 'ok' }), JSON.stringify({ ...ok, intervalSeconds: 29 }),
      JSON.stringify({ ...ok, intervalSeconds: 601 }), JSON.stringify({ ...ok, receivedAt: 'now' })]) {
      expect(parseInventoryReply(bad)).toBeNull();
    }
  });

  it('scheduling: 404 (older API) and 401 → long maximum; failures back off and are never reset by a failure', () => {
    const cfg = agentConfig('/x/i.json');
    const state = { failures: 0 };
    expect(inventoryDelaySeconds({ kind: 'not_found' }, state, cfg)).toBe(900);
    expect(inventoryDelaySeconds({ kind: 'unauthorized' }, state, cfg)).toBe(900);
    expect(state.failures).toBe(2);
    expect(inventoryDelaySeconds({ kind: 'invalid_response' }, state, cfg, () => 0)).toBe(240); // 60·2³ = 480 → ×0.5
    expect(state.failures).toBe(3);
    const ok: InventoryOutcome = { kind: 'ok', value: { status: 'accepted', intervalSeconds: 30 } };
    expect(inventoryDelaySeconds(ok, state, cfg)).toBe(60); // never faster than the local interval
    expect(state.failures).toBe(0);
    expect(inventoryDelaySeconds({ kind: 'ok', value: { status: 'accepted', intervalSeconds: 300 } }, state, cfg)).toBe(300);
    expect(inventoryDelaySeconds({ kind: 'rate_limited', retryAfterSeconds: 5 }, state, cfg)).toBe(60);
  });
});

describe('agent loops', () => {
  const quietSleep = (_ms: number, signal: AbortSignal) => abortableSleep(1, signal);

  it('inventory disabled → no inventory requests at all (legacy configuration)', async () => {
    const cfg = loadAgentConfig({ NC_AGENT_API_URL: 'https://x.example.test', NC_AGENT_TOKEN: TOKEN });
    let calls = 0;
    expect(await runInventory(cfg, new AbortController().signal, { fetchImpl: () => { calls += 1; return Promise.reject(new Error('x')); }, logger: { info: () => undefined, warn: () => undefined } })).toBe(0);
    expect(calls).toBe(0);
  });

  it('a hanging inventory endpoint and a missing exporter file never delay the heartbeat', async () => {
    const cfg = agentConfig(join(root, 'missing', 'inventory.json'));
    const controller = new AbortController();
    let heartbeats = 0;
    let inventories = 0;
    const fetchImpl = (url: string, init: RequestInit) => {
      if (url.endsWith('/api/agent/inventory')) {
        inventories += 1;
        expect(JSON.parse(init.body as string)).toMatchObject({ state: 'unavailable', reason: 'snapshot_missing' });
        return new Promise<Response>((_, reject) => { init.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); });
      }
      heartbeats += 1;
      if (heartbeats >= 4) controller.abort();
      return Promise.resolve(new Response(JSON.stringify({ status: 'accepted', receivedAt: '2026-10-13T12:00:00.000Z', intervalSeconds: 5 }), { status: 200 }));
    };
    const logger = { info: () => undefined, warn: () => undefined };
    await Promise.all([runAgent(cfg, controller.signal, { fetchImpl, sleep: quietSleep, logger }), runInventory(cfg, controller.signal, { fetchImpl, sleep: quietSleep, logger })]);
    expect(heartbeats).toBe(4);
    expect(inventories).toBe(1);
  });

  it('older API without the route (404): one request, then the long backoff; logs carry no names, paths or token', async () => {
    const dir = freshDir();
    const file = join(dir, 'inventory.json');
    await writeSnapshotAtomic(file, snapshotOk(sanitizeProcessList([rawProcess(0, { name: 'secret-app-name' }, { name: 'secret-app-name' })], Date.now()), new Date().toISOString()), ME);
    const cfg = loadAgentConfig({
      NC_AGENT_API_URL: 'http://127.0.0.1:9', NC_AGENT_ALLOW_INSECURE_LOOPBACK: 'true', NC_AGENT_TOKEN: TOKEN,
      NC_AGENT_INVENTORY_FILE: file, NC_AGENT_INVENTORY_ALLOW_SAME_OWNER: 'true',
    });
    const controller = new AbortController();
    const delays: number[] = [];
    const logged: Record<string, unknown>[] = [];
    let calls = 0;
    await runInventory(cfg, controller.signal, {
      fetchImpl: (_u, init) => { calls += 1; expect(init.body as string).toContain('secret-app-name'); return Promise.resolve(new Response('Not Found', { status: 404 })); },
      sleep: (ms, signal) => { delays.push(ms); controller.abort(); return abortableSleep(0, signal); },
      logger: { info: (e) => logged.push(e), warn: (e) => logged.push(e) },
    });
    expect(calls).toBe(1);
    expect(delays).toEqual([900_000]);
    expect(logged).toEqual([{ msg: 'inventory', outcome: 'not_found', state: 'ok', reason: null, processCount: 1, nextInSeconds: 900, consecutiveFailures: 1 }]);
    const text = JSON.stringify(logged);
    for (const s of ['secret-app-name', TOKEN, file]) expect(text).not.toContain(s);
    expect(existsSync(file)).toBe(true);
  });
});
