import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, chownSync, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, type Stats, symlinkSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';

// Everything the installers do to the machine goes through this interface: the real implementation below, an
// in-memory fake in the tests. Commands are always argv arrays (no shell); nothing here prints values.

export interface FileInfo { kind: 'file' | 'dir' | 'symlink' | 'socket' | 'other'; mode: number; uid: number; gid: number }
export interface Owner { mode: number; uid: number; gid: number }
export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions {
  /** Data written to the child's stdin (e.g. a password for --password-stdin). Never logged. */
  input?: string;
  /** The child talks to the operator's terminal directly (hidden prompts of existing CLIs). */
  interactive?: boolean;
  cwd?: string;
  /** Extra environment for the child (merged over the installer's own). */
  env?: Readonly<Record<string, string>>;
}
/** Bounded streaming read of a command's stdout: lines are handed over one by one, nothing else is kept. */
export interface ScanOptions {
  /** Deadline for the whole command; on expiry the child is killed (SIGKILL). */
  timeoutMs: number;
  /** stdout larger than this → the child is killed, result "limit". */
  maxBytes: number;
  /** Longer lines are skipped (never accumulated beyond this). */
  maxLineChars: number;
  onLine(line: string): void;
}
export type ScanResult = { status: 'exit'; code: number } | { status: 'timeout' } | { status: 'limit' } | { status: 'error' };

export interface UserInfo { name: string; uid: number; gid: number; home: string; shell: string }
export interface GroupInfo { name: string; gid: number; members: string[] }
/** A running process as seen in /proc: real UID and its title (cmdline). Never its environment. */
export interface ProcessInfo { pid: number; uid: number; title: string }

export interface Host {
  /** lstat: a symlink is reported as such, never followed. null = missing. */
  stat(path: string): FileInfo | null;
  readFile(path: string): string;
  /** Directory entries (names), [] if missing. */
  list(path: string): string[];
  /** Symlink target as stored, null if not a symlink. */
  readlink(path: string): string | null;
  /** Canonical absolute path (symlinks resolved), null if it does not exist. */
  realpath(path: string): string | null;
  sha256File(path: string): string;
  /** Temporary file in the same directory (exclusive, final mode from the start) → owner → rename. Refuses symlinks/dirs. */
  writeFileAtomic(path: string, content: string, owner: Owner): void;
  /** One directory level; the parent must exist; fails if the path exists. */
  mkdir(path: string, owner: Owner): void;
  /** New symlink path → target (temporary link + rename, owned by the caller); refuses an existing non-symlink path. */
  symlink(target: string, path: string): void;
  run(command: string, args: readonly string[], options?: RunOptions): RunResult;
  /** Streams stdout line by line within ScanOptions limits (stderr is discarded — never captured or printed). */
  scan(command: string, args: readonly string[], options: ScanOptions): Promise<ScanResult>;
  user(name: string): UserInfo | null;
  userById(uid: number): UserInfo | null;
  group(name: string): GroupInfo | null;
  /** Read-only list of processes (title + real UID) from /proc; [] where /proc is absent. */
  processes(): ProcessInfo[];
  /** Supplementary + primary group names of a user ([] if the user is missing). */
  groupsOf(name: string): string[];
  euid(): number;
  now(): Date;
  randomBytes(n: number): Buffer;
  /** HTTP status of a GET (redirects are not followed), or null on a network/TLS error/timeout. */
  httpStatus(url: string, timeoutMs: number): Promise<number | null>;
  /** A TCP connection can be opened (nothing is sent). */
  tcpReachable(hostname: string, port: number, timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

const kindOf = (s: Stats): FileInfo['kind'] =>
  s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : s.isSocket() ? 'socket' : 'other';

function getent(db: 'passwd' | 'group', name: string): string[] | null {
  const r = spawnSync('getent', [db, name], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const line = r.stdout.split('\n')[0] ?? '';
  return line === '' ? null : line.split(':');
}

export const realHost: Host = {
  stat(path) {
    try {
      const s = lstatSync(path);
      return { kind: kindOf(s), mode: s.mode & 0o7777, uid: s.uid, gid: s.gid };
    } catch {
      return null;
    }
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  list(path) {
    try { return readdirSync(path); } catch { return []; }
  },
  readlink(path) {
    try { return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null; } catch { return null; }
  },
  realpath(path) {
    try { return realpathSync(path); } catch { return null; }
  },
  sha256File: (path) => createHash('sha256').update(readFileSync(path)).digest('hex'),
  writeFileAtomic(path, content, owner) {
    const existing = realHost.stat(path);
    if (existing && existing.kind !== 'file') throw new Error(`${path} exists and is not a regular file`);
    const tmp = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
    const fd = openSync(tmp, 'wx', owner.mode & 0o600);
    try {
      fchmodSync(fd, owner.mode); // open() applies the umask; the exact mode is set before any content is written
      writeSync(fd, content);
      fsyncSync(fd);
      closeSync(fd);
      chownSync(tmp, owner.uid, owner.gid);
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  },
  mkdir(path, owner) {
    mkdirSync(path, { mode: owner.mode });
    chownSync(path, owner.uid, owner.gid);
    chmodSync(path, owner.mode); // mkdir applies the umask; exact bits (incl. setgid) are set explicitly
  },
  symlink(target, path) {
    const existing = realHost.stat(path);
    if (existing && existing.kind !== 'symlink') throw new Error(`${path} exists and is not a symlink`);
    const tmp = join(dirname(path), `.${basename(path)}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`);
    symlinkSync(target, tmp);
    try {
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  },
  run(command, args, options = {}) {
    if (options.interactive) {
      // The child talks to the operator's terminal (hidden prompts); nothing is captured.
      const r = spawnSync(command, args, { cwd: options.cwd ?? '/', stdio: 'inherit' });
      return { code: r.status ?? 1, stdout: '', stderr: '' };
    }
    const r = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd ?? '/', input: options.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: { ...process.env, ...options.env } } : {}) });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  },
  scan(command, args, o) {
    return new Promise<ScanResult>((resolve) => {
      const child = spawn(command, args, { cwd: '/', stdio: ['ignore', 'pipe', 'ignore'] });
      let bytes = 0;
      let partial = '';
      let skipping = false;
      let settled = false;
      const finish = (result: ScanResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const stop = (result: ScanResult) => {
        child.stdout.destroy();
        child.kill('SIGKILL');
        finish(result);
      };
      const timer = setTimeout(() => { stop({ status: 'timeout' }); }, o.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > o.maxBytes) { stop({ status: 'limit' }); return; }
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf('\n', start);
          if (nl < 0) {
            if (!skipping) {
              partial += chunk.slice(start);
              if (partial.length > o.maxLineChars) { partial = ''; skipping = true; }
            }
            return;
          }
          if (!skipping) {
            const text = partial + chunk.slice(start, nl);
            if (text.length <= o.maxLineChars) o.onLine(text);
          }
          partial = '';
          skipping = false;
          start = nl + 1;
        }
      });
      child.on('error', () => { finish({ status: 'error' }); });
      child.on('close', (code) => {
        if (!settled && !skipping && partial !== '') o.onLine(partial);
        finish({ status: 'exit', code: code ?? 1 });
      });
    });
  },
  user(name) {
    const f = getent('passwd', name);
    return f ? { name: f[0] ?? name, uid: Number(f[2]), gid: Number(f[3]), home: f[5] ?? '', shell: f[6] ?? '' } : null;
  },
  userById(uid) {
    return Number.isInteger(uid) && uid >= 0 ? realHost.user(String(uid)) : null;
  },
  processes() {
    let pids: string[];
    try { pids = readdirSync('/proc').filter((e) => /^\d+$/.test(e)); } catch { return []; }
    const out: ProcessInfo[] = [];
    for (const pid of pids) {
      try {
        // Only the title (bounded) and the real UID; /proc/<pid>/environ is never read.
        const title = readFileSync(`/proc/${pid}/cmdline`).subarray(0, 4096).toString('utf8').split('\0').filter((p) => p !== '').join(' ');
        const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
        if (uid !== undefined && title !== '') out.push({ pid: Number(pid), uid: Number(uid), title });
      } catch {
        // the process ended meanwhile or is not readable: skipped
      }
    }
    return out;
  },
  group(name) {
    const f = getent('group', name);
    return f ? { name: f[0] ?? name, gid: Number(f[2]), members: (f[3] ?? '').split(',').filter((m) => m !== '') } : null;
  },
  groupsOf(name) {
    const r = spawnSync('id', ['-nG', name], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim().split(/\s+/).filter((g) => g !== '') : [];
  },
  euid: () => process.geteuid?.() ?? -1,
  now: () => new Date(),
  randomBytes: (n) => randomBytes(n),
  async httpStatus(url, timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      return res.status;
    } catch {
      return null;
    }
  },
  tcpReachable(hostname, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = createConnection({ host: hostname, port, timeout: timeoutMs });
      const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
      socket.once('connect', () => { finish(true); });
      socket.once('timeout', () => { finish(false); });
      socket.once('error', () => { finish(false); });
    });
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
