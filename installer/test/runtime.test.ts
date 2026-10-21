import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentMain } from '../src/agent.js';
import type { Context, Preflight } from '../src/engine.js';
import { executableTrust, nodeVersionOk, RUNTIME, runtimePreflight, runtimeStep } from '../src/runtime.js';
import { serverMain } from '../src/server.js';
import { capture, FakeHost } from './fake-host.js';

// The Node.js runtime contract (ADR-027): one absolute path for every Node.js process of Node Control, a minimum
// derived from the locked dependencies, a compatible system Node.js only linked (never changed), an existing runtime
// never switched.

const ROOT = join(import.meta.dirname, '..', '..');
const spec = Object.fromEntries(readFileSync(join(ROOT, 'installer', 'bootstrap', 'node-runtime.env'), 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => l.split('=') as [string, string]));

/** semver range check for the forms that occur in engines fields (>=, ^, x.y, ||, bare majors, .* wildcards, leading v). */
function satisfies(version: string, range: string): boolean {
  const v = version.split('.').map(Number) as [number, number, number];
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
  return range.split('||').some((alt) => alt.trim().replace(/(>=|<=|>|<|\^)\s+/g, '$1').replace(/\.[*xX]/g, '').split(/\s+/).filter(Boolean).every((part) => {
    const m = /^(>=|\^|>|<=|<)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
    if (!m) throw new Error(`unsupported range part ${part} in ${range}`);
    const want = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    const c = cmp(v, want);
    switch (m[1]) {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '^': return c >= 0 && v[0] === want[0];
      default: return m[3] === undefined ? v[0] === want[0] : m[4] === undefined ? v[0] === want[0] && v[1] === want[1] : c === 0;
    }
  }));
}

describe('runtime version contract', () => {
  it('NODE_MIN in node-runtime.env, RUNTIME.min and the locked dependencies agree; the pinned version satisfies them', () => {
    expect(spec.NODE_MIN).toBe(RUNTIME.min);
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { engines?: { node?: string }; optional?: boolean; os?: string[] }> };
    const ranges = Object.values(lock.packages).map((p) => p.engines?.node).filter((r): r is string => typeof r === 'string');
    expect(ranges.length).toBeGreaterThan(10);
    const ok = (v: string) => ranges.every((r) => satisfies(v, r));
    expect(ok(RUNTIME.min)).toBe(true);
    expect(ok(spec.NODE_VERSION ?? '')).toBe(true);
    // The minimum is tight: the patch level right below it (or the previous minor) fails some locked package.
    const [maj, min, patch] = RUNTIME.min.split('.').map(Number) as [number, number, number];
    expect(ok(patch > 0 ? `${String(maj)}.${String(min)}.${String(patch - 1)}` : `${String(maj)}.${String(min - 1)}.99`)).toBe(false);
    expect(ok('21.7.3')).toBe(false); // the failed server build of the user report
    expect(spec.SHA256_LINUX_X64).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.SHA256_LINUX_ARM64).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['v22.22.0', true], ['22.23.4', true], ['v22.30.1', true], ['v22.21.9', false], ['v22.0.0', false],
    ['v21.7.3', false], ['v24.14.0', false], ['v23.11.0', false], ['', false], ['v22.22', false], ['garbage', false],
  ])('nodeVersionOk(%j) → %s (Node.js 22 only, not below the minimum)', (v, expected) => {
    expect(nodeVersionOk(v)).toBe(expected);
  });
});

const pre = (): Preflight => ({ errors: [], warnings: [], notes: [] });

function runtimeHost(target: 'downloaded' | 'system' | 'none', version = 'v22.23.4') {
  const h = new FakeHost();
  if (target !== 'none') {
    h.dir(RUNTIME.dir);
    h.dir(RUNTIME.bin);
  }
  if (target === 'downloaded') {
    const real = `${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin`;
    h.dir(`${RUNTIME.dir}/versions`);
    h.dir(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64`);
    h.dir(real);
    h.file(`${real}/node`, 'bin', 0o755);
    h.file(`${real}/npm`, 'bin', 0o755);
    h.nodeVersions.set(`${real}/node`, version);
    h.symlink('../versions/node-v22.23.4-linux-x64/bin/node', RUNTIME.node);
  }
  if (target === 'system') h.symlink('/usr/bin/node', RUNTIME.node);
  h.changes.length = 0;
  return h;
}

describe('runtimePreflight', () => {
  it('a downloaded runtime: version and real path are reported; npm next to it is enough', () => {
    const h = runtimeHost('downloaded');
    h.files.delete('/usr/bin/npm');
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors).toEqual([]);
    expect(p.notes.join('\n')).toMatch(/v22\.23\.4 \(\/opt\/node-control-runtime\/bin\/node → \/opt\/node-control-runtime\/versions\/node-v22\.23\.4-linux-x64\/bin\/node\)/);
  });

  it('an existing but incompatible runtime is refused, never replaced', () => {
    const h = runtimeHost('downloaded', 'v22.21.0');
    const p = pre();
    runtimePreflight(h, p, { npm: false });
    expect(p.errors.join()).toMatch(/v22\.21\.0: потрібен Node\.js 22 не старший за 22\.22\.0.*не замінює/);
  });

  it.each([
    ['the runtime directory writable by others', (h: FakeHost) => { h.dir(RUNTIME.dir, 0o777); }],
    ['the real binary owned by a user', (h: FakeHost) => { h.file(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/node`, 'bin', 0o755, 1000); }],
    ['a dangling link', (h: FakeHost) => { h.files.delete(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/node`); }],
  ])('%s → refused', (_n, arrange) => {
    const h = runtimeHost('downloaded');
    arrange(h);
    const p = pre();
    runtimePreflight(h, p, { npm: false });
    expect(p.errors.join()).toMatch(/має належати root і бути доступним на запис лише root/);
  });

  it('no runtime + compatible /usr/bin/node → only a note: the link is a step of apply', () => {
    const h = runtimeHost('none');
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors).toEqual([]);
    expect(p.notes.join()).toMatch(/буде створено посилання \/opt\/node-control-runtime\/bin\/node → \/usr\/bin\/node; системний Node\.js не змінюється/);
  });

  it.each([['v21.7.3'], ['v22.20.0'], ['v24.14.0']])('no runtime + /usr/bin/node %s → refused with the way out (./install.sh)', (version) => {
    const h = runtimeHost('none');
    h.nodeVersions.set('/usr/bin/node', version);
    const p = pre();
    runtimePreflight(h, p, { npm: false });
    expect(p.errors.join()).toContain(`${RUNTIME.system} — ${version}`);
    expect(p.errors.join()).toMatch(/\.\/install\.sh встановить окремий runtime, не змінюючи системний/);
  });

  it('no Node.js at all → refused; the API needs npm next to the real binary', () => {
    const none = runtimeHost('none');
    none.files.delete('/usr/bin/node');
    const p = pre();
    runtimePreflight(none, p, { npm: false });
    expect(p.errors.join()).toMatch(/\/usr\/bin\/node — немає/);
    const h = runtimeHost('system');
    h.files.delete('/usr/bin/npm');
    const q = pre();
    runtimePreflight(h, q, { npm: true });
    expect(q.errors.join()).toMatch(/немає npm поруч із \/usr\/bin\/node/);
  });
});

describe('runtimeStep', () => {
  const ctx = (h: FakeHost): Context => ({ host: h, mode: 'apply', effects: new Set(), out: capture().out, persist: () => undefined });

  it('existing runtime → done (never switched); missing → link to the system Node.js with root 755 directories', async () => {
    const existing = runtimeHost('downloaded');
    expect(await runtimeStep().check(ctx(existing))).toMatchObject({ state: 'done' });
    const h = runtimeHost('none');
    const step = runtimeStep();
    expect(await step.check(ctx(h))).toMatchObject({ state: 'pending' });
    await step.apply(ctx(h));
    expect(h.changes).toEqual(['mkdir /opt/node-control-runtime', 'mkdir /opt/node-control-runtime/bin', 'symlink /opt/node-control-runtime/bin/node -> /usr/bin/node']);
    expect(h.stat(RUNTIME.dir)).toMatchObject({ uid: 0, mode: 0o755 });
    expect(await step.check(ctx(h))).toMatchObject({ state: 'done' });
  });

  it('a foreign runtime directory is a conflict', async () => {
    const h = runtimeHost('none');
    h.dir(RUNTIME.dir, 0o755, 1000);
    expect(await runtimeStep().check(ctx(h))).toMatchObject({ state: 'conflict' });
  });
});

describe('every Node.js command of the installers uses the runtime path', () => {
  it('server apply: release tool, migrations and bootstrap run on RUNTIME.node — never /usr/bin/node or PATH', async () => {
    const h = new FakeHost();
    h.artifact('api');
    h.file('/transfer/db.env', 'DB_NAME=n\nDB_USER=u\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASS=p\n', 0o600);
    h.dir('/etc/nginx');
    const out = capture();
    const code = await serverMain(['apply', '--artifact', `/transfer/node-control-api-${'a'.repeat(40)}.tar.gz`, '--db-env', '/transfer/db.env', '--public-url', 'https://control.example.com', '--admin-email', 'a@example.com', '--admin-password-file', '/transfer/db.env'], { host: h, out: out.out, releaseTool: '/transfer/server-release.js' });
    expect(code, out.all).toBe(0);
    // Version probes of the system Node.js (preflight) aside, every Node.js process runs the runtime path.
    const node = h.calls.filter((c) => c.args[0] !== '--version' && (c.command.endsWith('/node') || c.args.some((a) => a.endsWith('/node') || a === 'node')));
    expect(node.length).toBeGreaterThan(4);
    for (const c of node) {
      const used = [c.command, ...c.args].filter((a) => a.endsWith('/node') || a === 'node');
      expect(used.every((a) => a === RUNTIME.node), `${c.command} ${c.args.join(' ')}`).toBe(true);
    }
  });

  it('agent: the broker fingerprint hint names the runtime path', async () => {
    const h = new FakeHost();
    h.artifact('agent');
    h.addUser('deploy', 1000);
    h.dir('/home/deploy', 0o750, 1000, 1000);
    h.dir('/home/deploy/.pm2', 0o755, 1000, 1000);
    h.file('/transfer/agent.key', `ncag_${'a'.repeat(43)}\n`, 0o600);
    h.agentLogs = () => '{"msg":"heartbeat","outcome":"accepted"}';
    const out = capture();
    const code = await agentMain(['apply', '--artifact', `/transfer/node-control-agent-${'a'.repeat(40)}.tar.gz`, '--api-url', 'https://control.example.com', '--token-file', '/transfer/agent.key', '--pm2-owner', 'deploy', '--pm2-home', '/home/deploy/.pm2', '--enable-control', '--control-mode', 'allowlist'], { host: h, out: out.out, releaseTool: '/transfer/server-release.js' });
    expect(code, out.all).toBe(0);
    expect(out.all).toContain(`${RUNTIME.node} /opt/node-control-agent/current/agent/dist/pm2-broker.js fingerprint`);
    expect(out.all).not.toMatch(/\/usr\/bin\/node \/opt/);
  });
});

// Review Codex 2026-10-21 (P1): trust is checked BEFORE the runtime is executed — an untrusted binary is never run,
// not even for --version. Every refusal asserts ZERO calls of any Node.js binary.
describe('runtime trust before execution (P1)', () => {
  const REAL = `${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/node`;
  const nodeCalls = (h: FakeHost) => h.calls.filter((c) => c.command.endsWith('/node') || c.command === RUNTIME.node);
  const refused = (h: FakeHost, why: RegExp) => {
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors.join(), JSON.stringify(p.errors)).toMatch(why);
    expect(p.errors.join()).toMatch(/інсталятор його не запускає й не змінює/);
    expect(nodeCalls(h)).toEqual([]);
    expect(h.changes).toEqual([]);
  };

  it.each([
    ['an executable of another UID', (h: FakeHost) => { h.file(REAL, 'bin', 0o755, 1000); }, /належить UID 1000, не root/],
    ['a group-writable executable', (h: FakeHost) => { h.file(REAL, 'bin', 0o775); }, /доступний на запис групі\/іншим/],
    ['a world-writable executable', (h: FakeHost) => { h.file(REAL, 'bin', 0o757); }, /доступний на запис групі\/іншим/],
    ['a non-executable file', (h: FakeHost) => { h.file(REAL, 'bin', 0o644); }, /не виконуваний/],
    ['a root-owned executable under a user-owned intermediate directory', (h: FakeHost) => { h.dir(`${RUNTIME.dir}/versions`, 0o755, 1000); }, /каталог \/opt\/node-control-runtime\/versions належить UID 1000/],
    ['a root-owned executable under a world-writable (non-sticky) directory', (h: FakeHost) => { h.dir(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin`, 0o777); }, /bin доступний на запис групі\/іншим/],
    ['a writable /opt above everything', (h: FakeHost) => { h.dir('/opt', 0o777); }, /каталог \/opt доступний на запис/],
    ['a symlink to a user-owned target', (h: FakeHost) => { h.dir('/home/u', 0o755, 1000); h.file('/home/u/node', 'bin', 0o755, 1000); h.files.delete(RUNTIME.node); h.symlink('/home/u/node', RUNTIME.node); }, /\/home\/u.*UID 1000/],
    ['a dangling symlink', (h: FakeHost) => { h.files.delete(REAL); }, /нікуди не веде/],
    ['a link owned by another user', (h: FakeHost) => { const l = h.files.get(RUNTIME.node); if (l) l.uid = 1000; }, /посилання \/opt\/node-control-runtime\/bin\/node належить UID 1000/],
    ['a user-owned file inside the runtime tree (npm/lib)', (h: FakeHost) => { h.file(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/npm`, 'bin', 0o755, 1000); }, /npm належить UID 1000/],
  ])('existing runtime: %s → refused without running anything', (_n, arrange, why) => {
    const h = runtimeHost('downloaded');
    arrange(h);
    h.calls.length = 0;
    h.changes.length = 0;
    refused(h, why);
  });

  it('no runtime yet: an untrusted /usr/bin/node is not executed either', () => {
    const h = runtimeHost('none');
    h.file('/usr/bin/node', 'bin', 0o755, 1000);
    refused(h, /\/usr\/bin\/node належить UID 1000/);
  });

  it('allowed: a root-owned downloaded runtime and the link to a compatible system Node.js are run only after the checks', () => {
    for (const [kind, real] of [['downloaded', REAL], ['system', '/usr/bin/node']] as const) {
      const h = runtimeHost(kind);
      if (kind === 'downloaded') h.file(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/npm`, 'bin', 0o755);
      h.calls.length = 0;
      const p = pre();
      runtimePreflight(h, p, { npm: true });
      expect(p.errors, kind).toEqual([]);
      expect(p.notes.join()).toContain(real);
      expect(nodeCalls(h).map((c) => c.args)).toEqual([['--version']]);
    }
  });
});

// Review Codex 2026-10-21 (P2): npm must be present, trusted and run on the same Node.js — only where it is needed.
describe('npm next to the runtime', () => {
  const npmCalls = (h: FakeHost) => h.calls.filter((c) => c.command.endsWith('/npm'));
  it.each([
    ['missing', (h: FakeHost) => { h.files.delete('/usr/bin/npm'); }, /немає npm поруч із \/usr\/bin\/node/, 0],
    ['not working', (h: FakeHost) => { h.npmNode.set('/usr/bin/npm', 'broken'); }, /npm поруч із \/usr\/bin\/node не працює/, 1],
    ['running on another Node.js', (h: FakeHost) => { h.npmNode.set('/usr/bin/npm', 'v21.7.3'); }, /працює на Node\.js v21\.7\.3, а не v22\.23\.4/, 1],
    ['not trusted (user-owned) — and then never run', (h: FakeHost) => { h.file('/usr/bin/npm', 'bin', 0o755, 1000); }, /npm поруч із \/usr\/bin\/node не довірений/, 0],
  ])('Central API with npm %s → refused with the way to a complete runtime', (_n, arrange, why, npmRuns) => {
    const h = runtimeHost('none');
    arrange(h);
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors.join()).toMatch(why);
    expect(p.errors.join()).toMatch(/--component server запропонує окремий runtime Node Control із npm/);
    expect(npmCalls(h)).toHaveLength(npmRuns);
  });

  it('a compatible Node.js/npm pair passes (npm runs with that node first in PATH)', () => {
    const h = runtimeHost('none');
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors).toEqual([]);
    expect(npmCalls(h)).toHaveLength(1);
  });

  it('an existing runtime without a working npm is reported, never replaced', () => {
    const h = runtimeHost('downloaded');
    h.files.delete(`${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/npm`);
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors.join()).toMatch(/немає npm поруч.*Наявний runtime інсталятор не замінює/);
    expect(h.changes).toEqual([]);
  });

  it('the Agent (prepared artifact, no npm dependencies) does not require npm at all', () => {
    const h = runtimeHost('none');
    h.files.delete('/usr/bin/npm');
    const p = pre();
    runtimePreflight(h, p, { npm: false });
    expect(p.errors).toEqual([]);
    expect(npmCalls(h)).toEqual([]);
  });
});

// Review Codex 36413d3 (P1): the path is checked component by component as it is resolved — every directory of the
// ORIGINAL path, every intermediate/final symlink and the components of each target — never only its realpath.
describe('intermediate symlinks do not hide untrusted path components (P1, 36413d3)', () => {
  const nodeCalls = (h: FakeHost) => h.calls.filter((c) => c.command.endsWith('/node') || c.command === RUNTIME.node);
  /** /opt/node-control-runtime/bin → (symlink) … → a root-owned /usr/bin/node: only the path before it is varied. */
  function host(arrange: (h: FakeHost) => void) {
    const h = new FakeHost();
    h.dir(RUNTIME.dir);
    arrange(h);
    h.changes.length = 0;
    h.calls.length = 0;
    return h;
  }
  const refusedWithoutRun = (h: FakeHost, why: RegExp) => {
    expect(executableTrust(h, RUNTIME.node).problems.join('; ')).toMatch(why);
    const p = pre();
    runtimePreflight(h, p, { npm: true });
    expect(p.errors.join()).toMatch(why);
    expect(nodeCalls(h)).toEqual([]);
    expect(h.calls.filter((c) => c.command.endsWith('/npm'))).toEqual([]);
  };

  it.each([
    ['a foreign owner of the directory before the intermediate symlink', (h: FakeHost) => { h.dir(RUNTIME.dir, 0o755, 1000); h.symlink('/usr/bin', RUNTIME.bin); }, /каталог \/opt\/node-control-runtime належить UID 1000/],
    ['a world-writable (non-sticky) directory before the intermediate symlink', (h: FakeHost) => { h.dir(RUNTIME.dir, 0o777); h.symlink('/usr/bin', RUNTIME.bin); }, /каталог \/opt\/node-control-runtime доступний на запис/],
    ['a group-writable directory before the intermediate symlink', (h: FakeHost) => { h.dir(RUNTIME.dir, 0o775); h.symlink('/usr/bin', RUNTIME.bin); }, /каталог \/opt\/node-control-runtime доступний на запис/],
    ['an intermediate symlink owned by another user', (h: FakeHost) => { h.symlink('/usr/bin', RUNTIME.bin); const l = h.files.get(RUNTIME.bin); if (l) l.uid = 1000; }, /посилання \/opt\/node-control-runtime\/bin належить UID 1000/],
    ['several hops, a later one under a user-owned directory', (h: FakeHost) => { h.symlink('/opt/hop1', RUNTIME.bin); h.dir('/opt/user', 0o755, 1000); h.symlink('/opt/user/hop2', '/opt/hop1'); h.symlink('/usr/bin', '/opt/user/hop2'); }, /каталог \/opt\/user належить UID 1000/],
    ['a relative target with .. through a user-owned directory', (h: FakeHost) => { h.dir('/home/u', 0o755, 1000); h.dir('/home/u/bin', 0o755, 0); h.file('/home/u/bin/node', 'bin', 0o755); h.symlink('../../home/u/bin', RUNTIME.bin); }, /каталог \/home\/u належить UID 1000/],
    ['a symlink loop', (h: FakeHost) => { h.symlink('/opt/loop-b', RUNTIME.bin); h.symlink('/opt/loop-a', '/opt/loop-b'); h.symlink('/opt/loop-b', '/opt/loop-a'); }, /забагато посилань/],
    ['a dangling intermediate symlink', (h: FakeHost) => { h.symlink('/opt/gone', RUNTIME.bin); }, /\/opt\/gone не існує/],
  ])('%s → refused, nothing executed', (_n, arrange, why) => {
    refusedWithoutRun(host((h) => { arrange(h); if (!h.stat(RUNTIME.node) && h.stat(RUNTIME.bin)?.kind === 'dir') h.symlink('/usr/bin/node', RUNTIME.node); }), why);
  });

  it.each([
    ['safe root-owned system symlinks (/bin → usr/bin, relative with ..)', (h: FakeHost) => { h.dir(RUNTIME.bin); h.symlink('usr/bin', '/bin'); h.symlink('../../../bin/./node', RUNTIME.node); }, '/usr/bin/node'],
    ['several root-owned hops with relative targets', (h: FakeHost) => { h.symlink('../hop', RUNTIME.bin); h.symlink('/usr/lib/../bin', '/opt/hop'); h.dir('/usr/lib'); }, '/usr/bin/node'],
    ['the downloaded runtime layout', (h: FakeHost) => { const v = `${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin`; for (const d of [`${RUNTIME.dir}/versions`, `${RUNTIME.dir}/versions/node-v22.23.4-linux-x64`, v, RUNTIME.bin]) h.dir(d); h.file(`${v}/node`, 'bin', 0o755); h.file(`${v}/npm`, 'bin', 0o755); h.symlink('../versions/node-v22.23.4-linux-x64/bin/node', RUNTIME.node); }, `${RUNTIME.dir}/versions/node-v22.23.4-linux-x64/bin/node`],
    ['the link to a compatible system Node.js', (h: FakeHost) => { h.dir(RUNTIME.bin); h.symlink('/usr/bin/node', RUNTIME.node); }, '/usr/bin/node'],
  ])('%s → allowed; the version is read only after the checks', (_n, arrange, real) => {
    const h = host(arrange);
    expect(executableTrust(h, RUNTIME.node)).toEqual({ real, problems: [] });
    const p = pre();
    runtimePreflight(h, p, { npm: false });
    expect(p.errors).toEqual([]);
    expect(nodeCalls(h).map((c) => c.args)).toEqual([['--version']]);
  });
});
