import { createHash } from 'node:crypto';
import { basename, dirname, normalize } from 'node:path';
import { parseEnv } from 'node:util';
import type { FileInfo, GroupInfo, Host, Owner, ProcessInfo, RunOptions, RunResult, ScanOptions, ScanResult, UserInfo } from '../src/host.js';
import { RUNTIME } from '../src/runtime.js';

// In-memory Linux host for the installer tests: a file tree with owners/modes, users and groups, systemd units, and
// simulations of exactly the external tools the installers call (server-release.js, migrate.js, bootstrap-admin.js,
// systemctl, useradd…). Every command and every mutation is recorded in order; failures can be injected.

interface Node { kind: FileInfo['kind']; mode: number; uid: number; gid: number; content?: string; target?: string }
export interface Call { command: string; args: string[]; input?: string; interactive?: boolean }

export const REV = 'a'.repeat(40);
export const UNIT_TEXT = (name: string) => `# fake unit ${name}\n[Service]\nExecStart=/usr/bin/node /opt/x.js\n`;
const RELEASE_UNITS = ['node-control-api.service', 'node-control-agent.service', 'node-control-pm2-exporter@.service', 'node-control-pm2-exporter@.timer', 'node-control-pm2-broker@.service'];

export class FakeHost implements Host {
  files = new Map<string, Node>();
  users = new Map<string, UserInfo>();
  groups = new Map<string, GroupInfo>();
  units = new Map<string, { enabled: boolean; active: boolean }>();
  calls: Call[] = [];
  /** Ordered list of system changes ("mkdir /x", "write /y", "useradd z", "systemctl start u"); installer state excluded. */
  changes: string[] = [];
  /** Writes of the installer's own pending state (/var/lib/node-control-install), with the system change count at that moment. */
  stateOps: { op: string; at: number; content: string }[] = [];
  /** Commands that fail: predicate on "command args…" → exit code 1 with this stderr. */
  failures: { match: (line: string) => boolean; stderr: string; once?: boolean }[] = [];
  migrations = { applied: 0, pending: 9, unknown: 0, reachable: true };
  admins = 0;
  http = new Map<string, number | null>();
  tcp = true;
  /** Journal records: unit, the invocation (process run) that wrote them, the line (JSON as the Agent logs it). */
  journal: { unit: string; invocation: string; line: string }[] = [];
  /** Current InvocationID per unit (a new one on every start/restart). */
  invocations = new Map<string, string>();
  /** Called on every journal read: may log a line for the Agent's current invocation (null = nothing new yet). */
  agentLogs: ((invocation: string, read: number) => string | null) | null = null;
  journalFails = false;
  /** The journal read does not finish (the real scan would kill it at the deadline). */
  journalHangs = false;
  private journalReads = 0;
  private nextInvocation = 1;
  /** Writes that fail (path predicate); once = only the first matching write. */
  writeFailures: { match: (path: string) => boolean; once: boolean }[] = [];
  euidValue = 0;
  /** `node --version` by the real path of the binary (default v22.23.4). */
  nodeVersions = new Map<string, string>();
  clock = new Date('2026-10-20T10:00:00.000Z');
  private nextUid = 990;

  constructor(options: { os?: string } = {}) {
    const dir = (p: string, mode = 0o755) => { this.files.set(p, { kind: 'dir', mode, uid: 0, gid: 0 }); };
    for (const p of ['/', '/etc', '/opt', '/var', '/var/lib', '/run', '/run/systemd', '/run/systemd/system', '/usr', '/usr/bin', '/usr/sbin', '/etc/systemd', '/etc/systemd/system', '/home', '/root', '/transfer']) dir(p);
    this.file('/etc/os-release', options.os ?? 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n');
    this.file('/usr/bin/node', 'bin', 0o755);
    for (const c of ['useradd', 'groupadd', 'usermod', 'runuser']) this.file(`/usr/sbin/${c}`, 'bin', 0o755);
    for (const c of ['systemctl', 'systemd-analyze', 'tar', 'npm', 'ss', 'journalctl']) this.file(`/usr/bin/${c}`, 'bin', 0o755);
    this.groups.set('root', { name: 'root', gid: 0, members: [] });
    this.users.set('root', { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' });
  }

  // --- test setup helpers -------------------------------------------------------------------------------------------
  file(path: string, content: string, mode = 0o644, uid = 0, gid = 0): void { this.files.set(path, { kind: 'file', mode, uid, gid, content }); }
  dir(path: string, mode = 0o755, uid = 0, gid = 0): void { this.files.set(path, { kind: 'dir', mode, uid, gid }); }
  addUser(name: string, uid: number, options: { shell?: string; home?: string; primary?: string } = {}): UserInfo {
    const group = options.primary ?? name;
    if (!this.groups.has(group)) this.groups.set(group, { name: group, gid: uid, members: [] });
    const gid = this.groups.get(group)?.gid ?? uid;
    const user = { name, uid, gid, home: options.home ?? `/home/${name}`, shell: options.shell ?? '/bin/bash' };
    this.users.set(name, user);
    return user;
  }
  /** Artifact + .sha256 in /transfer, as build-release.js writes them. */
  artifact(kind: 'api' | 'agent', content = `artifact-${kind}`, checksum?: string): string {
    const name = `node-control-${kind}-${REV}.tar.gz`;
    this.file(`/transfer/${name}`, content);
    this.file(`/transfer/${name}.sha256`, `${checksum ?? createHash('sha256').update(content).digest('hex')}  ${name}\n`);
    this.file('/transfer/server-release.js', 'tool');
    return `/transfer/${name}`;
  }
  fail(match: string | RegExp, stderr = 'simulated failure', once = false): void {
    this.failures.push({ match: (line) => (typeof match === 'string' ? line.includes(match) : match.test(line)), stderr, once });
  }
  text(path: string): string { return this.files.get(path)?.content ?? ''; }

  // --- Host ---------------------------------------------------------------------------------------------------------
  stat(path: string): FileInfo | null {
    const n = this.files.get(path);
    return n ? { kind: n.kind, mode: n.mode, uid: n.uid, gid: n.gid } : null;
  }
  readFile(path: string): string {
    const n = this.files.get(path);
    if (n?.kind !== 'file' || n.content === undefined) throw new Error(`ENOENT: ${path}`);
    return n.content;
  }
  list(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && p !== path).map((p) => p.slice(prefix.length));
  }
  readlink(path: string): string | null { const n = this.files.get(path); return n?.kind === 'symlink' ? n.target ?? null : null; }
  /** Paths are canonical in the fake unless a test maps an alias (a symlinked prefix) to its real prefix. */
  aliases = new Map<string, string>();
  realpath(path: string): string | null {
    let p = normalize(path).replace(/\/$/, '') || '/';
    for (const [alias, real] of this.aliases) if (p === alias || p.startsWith(`${alias}/`)) p = real + p.slice(alias.length);
    for (let hops = 0; this.files.get(p)?.kind === 'symlink' && hops < 8; hops++) {
      const target = this.files.get(p)?.target ?? '';
      p = target.startsWith('/') ? target : normalize(`${dirname(p)}/${target}`);
    }
    return this.files.has(p) ? p : null;
  }
  sha256File(path: string): string { return createHash('sha256').update(this.readFile(path)).digest('hex'); }
  failWrite(match: string | RegExp, once = true): void {
    this.writeFailures.push({ match: (p) => (typeof match === 'string' ? p === match : match.test(p)), once });
  }
  /** A historical journal line of a previous Agent run (not the current invocation). */
  historical(line: string): void { this.journal.push({ unit: 'node-control-agent.service', invocation: 'old-run', line }); }
  writeFileAtomic(path: string, content: string, owner: Owner): void {
    const failure = this.writeFailures.find((f) => f.match(path));
    if (failure) {
      if (failure.once) this.writeFailures.splice(this.writeFailures.indexOf(failure), 1);
      throw new Error(`EIO: write ${path}`);
    }
    const existing = this.files.get(path);
    if (existing && existing.kind !== 'file') throw new Error(`${path} exists and is not a regular file`);
    if (this.files.get(dirname(path))?.kind !== 'dir') throw new Error(`ENOENT: ${dirname(path)}`);
    this.files.set(path, { kind: 'file', content, ...owner });
    if (path.startsWith('/var/lib/node-control-install/')) this.stateOps.push({ op: `write ${path}`, at: this.changes.length, content });
    else this.changes.push(`write ${path}`);
  }
  mkdir(path: string, owner: Owner): void {
    if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
    if (this.files.get(dirname(path))?.kind !== 'dir') throw new Error(`ENOENT: ${dirname(path)}`);
    this.files.set(path, { kind: 'dir', ...owner });
    if (path === '/var/lib/node-control-install') this.stateOps.push({ op: `mkdir ${path}`, at: this.changes.length, content: '' });
    else this.changes.push(`mkdir ${path}`);
  }
  symlink(target: string, path: string): void {
    const existing = this.files.get(path);
    if (existing && existing.kind !== 'symlink') throw new Error(`${path} exists and is not a symlink`);
    if (this.files.get(dirname(path))?.kind !== 'dir') throw new Error(`ENOENT: ${dirname(path)}`);
    this.files.set(path, { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target });
    this.changes.push(`symlink ${path} -> ${target}`);
  }
  /** Running processes (title + real UID), as /proc would show them. */
  procs: ProcessInfo[] = [];
  user(name: string): UserInfo | null { return this.users.get(name) ?? null; }
  userById(uid: number): UserInfo | null { return [...this.users.values()].find((u) => u.uid === uid) ?? null; }
  processes(): ProcessInfo[] { return this.procs.map((p) => ({ ...p })); }
  group(name: string): GroupInfo | null { return this.groups.get(name) ?? null; }
  groupsOf(name: string): string[] {
    const u = this.users.get(name);
    if (!u) return [];
    const primary = [...this.groups.values()].find((g) => g.gid === u.gid)?.name;
    return [...(primary ? [primary] : []), ...[...this.groups.values()].filter((g) => g.members.includes(name)).map((g) => g.name)];
  }
  euid(): number { return this.euidValue; }
  now(): Date { return this.clock; }
  randomBytes(n: number): Buffer { return Buffer.alloc(n, 0x5a); }
  httpStatus(url: string): Promise<number | null> {
    for (const [prefix, status] of this.http) if (url.startsWith(prefix)) return Promise.resolve(status);
    return Promise.resolve(200);
  }
  tcpReachable(): Promise<boolean> { return Promise.resolve(this.tcp); }
  sleep(): Promise<void> { return Promise.resolve(); }

  run(command: string, args: readonly string[], options: RunOptions = {}): RunResult {
    const call: Call = { command, args: [...args], ...(options.input !== undefined ? { input: options.input } : {}), ...(options.interactive ? { interactive: true } : {}) };
    this.calls.push(call);
    const line = [command, ...args].join(' ');
    const failure = this.failures.find((f) => f.match(line));
    if (failure) {
      if (failure.once) this.failures.splice(this.failures.indexOf(failure), 1);
      return { code: 1, stdout: '', stderr: failure.stderr };
    }
    return this.simulate(command, [...args], options);
  }

  private unit(name: string) {
    const u = this.units.get(name) ?? { enabled: false, active: false };
    this.units.set(name, u);
    return u;
  }

  private simulate(command: string, args: string[], options: RunOptions): RunResult {
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    switch (command) {
      case 'useradd': {
        const name = args.at(-1) ?? '';
        if (this.users.has(name)) return { code: 9, stdout: '', stderr: 'useradd: user exists' };
        const uid = this.nextUid--;
        this.groups.set(name, { name, gid: uid, members: [] });
        this.users.set(name, { name, uid, gid: uid, home: '/nonexistent', shell: '/usr/sbin/nologin' });
        this.changes.push(`useradd ${name}`);
        return ok();
      }
      case 'groupadd': {
        const name = args.at(-1) ?? '';
        this.groups.set(name, { name, gid: this.nextUid--, members: [] });
        this.changes.push(`groupadd ${name}`);
        return ok();
      }
      case 'usermod': {
        const [, group, user] = args;
        this.groups.get(group ?? '')?.members.push(user ?? '');
        this.changes.push(`usermod -aG ${group ?? ''} ${user ?? ''}`);
        return ok();
      }
      case 'id': return ok(`${[...this.groups.values()].find((g) => g.gid === this.users.get(args[1] ?? '')?.gid)?.name ?? ''}\n`);
      case 'ss': return ok('');
      case 'tar': { // tar -xzOf <artifact> deploy/systemd/<unit> → the unit as the release would contain it
        if (args[0] !== '-xzOf' || !this.files.has(args[1] ?? '')) return { code: 2, stdout: '', stderr: 'tar: cannot open' };
        const unit = basename(args[2] ?? '');
        return RELEASE_UNITS.includes(unit) ? ok(UNIT_TEXT(unit)) : { code: 2, stdout: '', stderr: 'tar: not found in archive' };
      }
      case 'systemd-analyze': return ok();
      case 'journalctl': return this.journalctl(args);
      case 'systemctl': {
        const [verb, ...rest] = args;
        if (verb === 'is-active') return ok(`${this.unit(rest[0] ?? '').active ? 'active' : 'inactive'}\n`);
        if (verb === 'is-enabled') return ok(`${this.unit(rest[0] ?? '').enabled ? 'enabled' : 'disabled'}\n`);
        if (verb === 'show') {
          const unit = rest.at(-1) ?? '';
          return ok(`${this.unit(unit).active ? this.invocations.get(unit) ?? '' : ''}\n`);
        }
        this.changes.push(`systemctl ${args.join(' ')}`);
        if (verb === 'daemon-reload') return ok();
        if (verb === 'enable' && rest[0] === '--now') { const u = this.unit(rest[1] ?? ''); u.enabled = true; u.active = true; return ok(); }
        if (verb === 'enable') { this.unit(rest[0] ?? '').enabled = true; return ok(); }
        if (verb === 'start' || verb === 'restart') {
          const name = rest[0] ?? '';
          if (!name.includes('exporter@') || name.endsWith('.timer')) this.unit(name).active = true;
          this.invocations.set(name, `run-${String(this.nextInvocation++)}`);
          return ok();
        }
        return ok();
      }
      case '/usr/bin/node':
      case RUNTIME.node: {
        const real = this.realpath(command);
        if (!real || this.files.get(real)?.kind !== 'file') return { code: 127, stdout: '', stderr: `${command}: not found` };
        return this.node(args, this.nodeVersions.get(real) ?? 'v22.23.4');
      }
      case 'runuser': return this.runuser(args, options);
      default: return { code: 127, stdout: '', stderr: `${command}: not simulated` };
    }
  }

  /** Rows a journalctl invocation would print: -u <unit> → every run of the unit (like the real journal); _SYSTEMD_INVOCATION_ID=<id> → that run only. */
  private journalRows(args: readonly string[]): string[] {
    const unit = 'node-control-agent.service';
    const current = this.invocations.get(unit);
    const line = current && this.agentLogs ? this.agentLogs(current, this.journalReads++) : null;
    if (current && line) this.journal.push({ unit, invocation: current, line });
    const byInvocation = args.find((a) => a.startsWith('_SYSTEMD_INVOCATION_ID='))?.split('=')[1];
    return this.journal.filter((r) => (byInvocation === undefined ? r.unit === unit : r.invocation === byInvocation)).flatMap((r) => r.line.split('\n'));
  }

  private journalctl(args: string[]): RunResult {
    if (this.journalFails) return { code: 1, stdout: '', stderr: 'Failed to open journal' };
    return { code: 0, stdout: this.journalRows(args).map((l) => `${l}\n`).join(''), stderr: '' };
  }

  /** Same semantics as realHost.scan: line by line, byte limit, overlong lines skipped, deadline, exit code. */
  scan(command: string, args: readonly string[], o: ScanOptions): Promise<ScanResult> {
    this.calls.push({ command, args: [...args] });
    if (command !== 'journalctl') return Promise.resolve({ status: 'exit', code: 127 });
    if (this.journalFails) return Promise.resolve({ status: 'exit', code: 1 });
    if (this.journalHangs) return Promise.resolve({ status: 'timeout' });
    let bytes = 0;
    for (const l of this.journalRows(args)) {
      bytes += Buffer.byteLength(l) + 1;
      if (bytes > o.maxBytes) return Promise.resolve({ status: 'limit' });
      if (l.length <= o.maxLineChars) o.onLine(l);
    }
    return Promise.resolve({ status: 'exit', code: 0 });
  }

  private node(args: string[], version: string): RunResult {
    if (args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    const [, sub, ...rest] = args;
    const opt = (name: string) => rest[rest.indexOf(`--${name}`) + 1] ?? '';
    const base = opt('base');
    if (sub === 'prepare') {
      if (!this.files.has(base)) this.dir(base);
      if (!this.files.has(`${base}/releases`)) this.dir(`${base}/releases`);
      const rel = `${base}/releases/${opt('revision')}`;
      for (const d of [rel, `${rel}/deploy`, `${rel}/deploy/systemd`]) this.dir(d);
      for (const u of RELEASE_UNITS) this.file(`${rel}/deploy/systemd/${u}`, UNIT_TEXT(u));
      this.changes.push(`prepare ${rel}`);
      return { code: 0, stdout: `[release] prepared: ${rel}\n`, stderr: '' };
    }
    if (sub === 'activate') {
      this.files.set(`${base}/current`, { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target: `releases/${opt('revision')}` });
      this.changes.push(`activate ${opt('revision')}`);
      return { code: 0, stdout: '[release] activated\n', stderr: '' };
    }
    if (sub === 'config') {
      const config = opt('config');
      const owner = this.users.get(opt('owner'));
      if (!owner) return { code: 1, stdout: '', stderr: 'unknown user' };
      const legacy = parseEnv(this.readFile(opt('legacy-env')));
      if (!this.files.has(dirname(config))) this.dir(dirname(config), 0o750, 0, owner.gid);
      const keys = ['DB_NAME', 'DB_USER', 'DB_HOST', 'DB_PORT', 'DB_PASS'];
      this.file(config, `# managed\nNODE_ENV=production\nAPI_HOST=127.0.0.1\nAPI_PORT=3100\nLOG_LEVEL=info\n${keys.map((k) => `${k}=${legacy[k] ?? ''}`).join('\n')}\n`, 0o600, owner.uid, owner.gid);
      this.changes.push(`config ${config}`);
      return { code: 0, stdout: `[release] config created: ${config}\n`, stderr: '' };
    }
    return { code: 2, stdout: '', stderr: 'unknown subcommand' };
  }

  private runuser(args: string[], options: RunOptions): RunResult {
    const script = args.find((a) => a.endsWith('.js')) ?? '';
    if (basename(script) === 'migrate.js') {
      if (!this.migrations.reachable) return { code: 1, stdout: '', stderr: '[migrate] status failed (category=database code=ECONNREFUSED)' };
      if (args.at(-1) === 'up') {
        this.migrations.applied += this.migrations.pending;
        this.migrations.pending = 0;
        this.changes.push('migrate up');
        return { code: 0, stdout: '[migrate] applied\n', stderr: '' };
      }
      const m = this.migrations;
      return { code: 0, stdout: `[migrate] target u@127.0.0.1:5432/db: applied=${String(m.applied)} pending=${String(m.pending)} unknown=${String(m.unknown)}\n`, stderr: '' };
    }
    if (basename(script) === 'bootstrap-admin.js') {
      if (!options.interactive && options.input === undefined) return { code: 2, stdout: '', stderr: 'no input' };
      if (this.admins > 0) return { code: 3, stdout: '', stderr: '' };
      this.admins += 1;
      this.changes.push('bootstrap admin');
      return { code: 0, stdout: 'created\n', stderr: '' };
    }
    return { code: 127, stdout: '', stderr: 'not simulated' };
  }
}

/** Collects installer output; `all` is stdout + stderr for "no secret printed" assertions. */
export function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: { line: (t: string) => { lines.push(t); }, error: (t: string) => { errors.push(t); } },
    lines, errors,
    get all() { return [...lines, ...errors].join('\n'); },
  };
}
