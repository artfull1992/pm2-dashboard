// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, statfsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { EXIT, prepare } from './prepare.js';

// Entry point of the guided preparation, started ONLY by ./install.sh (as root, on the checked Node.js runtime):
//   node installer/bootstrap/main.js --checkout <dir> --component server|agent --launcher <install.sh> [--runtime-installed]
// Commands are argv arrays (no shell); nothing of the operator's input reaches a command line.

/** @typedef {import('./prepare.js').Sys} Sys */
/** @typedef {import('./prepare.js').RunResult} RunResult */

/** @param {import('node:stream').Readable} stream @param {(line: string) => void} each */
function lines(stream, each) {
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', (/** @type {string} */ chunk) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    for (const p of parts) each(p);
  });
  stream.on('end', () => { if (partial !== '') each(partial); });
}

let interrupted = false;

/** @type {Sys} */
export const realSys = {
  euid: () => process.geteuid?.() ?? -1,
  env: process.env,
  user(name) {
    const r = spawnSync('getent', ['passwd', name], { encoding: 'utf8' });
    const f = r.status === 0 ? (r.stdout.split('\n')[0] ?? '').split(':') : [];
    return f.length >= 7 ? { name: f[0] ?? name, uid: Number(f[2]), gid: Number(f[3]), home: f[5] ?? '', shell: f[6] ?? '' } : null;
  },
  ownerOf(path) {
    try { return lstatSync(path).uid; } catch { return null; }
  },
  groupsOf(name) {
    const r = spawnSync('id', ['-nG', name], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim().split(/\s+/).filter((g) => g !== '') : [];
  },
  run(argv, cwd) {
    const r = spawnSync(argv[0] ?? '', argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.error ? r.error.message : r.stderr };
  },
  stream(argv, cwd, log, onLine) {
    return new Promise((resolve) => {
      const child = spawn(argv[0] ?? '', argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      /** @param {string} line */
      const each = (line) => { log(`${line}\n`); onLine(line); };
      lines(child.stdout, each);
      lines(child.stderr, each);
      child.on('error', (error) => { log(`${error.message}\n`); resolve(127); });
      child.on('close', (code) => { resolve(code ?? 1); });
    });
  },
  pipe(a, b, cwd) {
    return new Promise((resolve) => {
      const left = spawn(a[0] ?? '', a.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const right = spawn(b[0] ?? '', b.slice(1), { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      /** @param {Buffer | string} chunk */
      const keep = (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); };
      left.stderr.on('data', keep);
      right.stderr.on('data', keep);
      left.stdout.pipe(right.stdin);
      right.stdin.on('error', () => undefined); // the reader died: reported by its exit code
      /** @type {number[]} */
      const codes = [];
      /** @param {number} code */
      const finish = (code) => {
        codes.push(code);
        if (codes.length === 2) resolve({ code: codes.every((c) => c === 0) ? 0 : 1, stdout: '', stderr });
      };
      left.on('error', (e) => { keep(e.message); });
      right.on('error', (e) => { keep(e.message); });
      left.on('close', (code) => { finish(code ?? 1); });
      right.on('close', (code) => { finish(code ?? 1); });
    });
  },
  tcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port, timeout: timeoutMs });
      /** @param {boolean} ok */
      const finish = (ok) => { socket.destroy(); resolve(ok); };
      socket.once('connect', () => { finish(true); });
      socket.once('timeout', () => { finish(false); });
      socket.once('error', () => { finish(false); });
    });
  },
  async https(url, timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      return res.status < 500;
    } catch {
      return false;
    }
  },
  freeBytes(path) {
    try { const s = statfsSync(path); return s.bavail * s.bsize; } catch { return null; }
  },
  ask(question) {
    return new Promise((done) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      let answered = false;
      rl.on('SIGINT', () => { rl.close(); });
      rl.on('close', () => { if (!answered) { process.stdout.write('\n'); done(null); } });
      rl.question(question, (answer) => { answered = true; rl.close(); done(answer); });
    });
  },
  line: (t) => { process.stdout.write(`${t}\n`); },
  error: (t) => { process.stderr.write(`${t}\n`); },
  now: () => new Date(),
  nodePath: realpathSync(process.execPath),
  nodeVersion: process.version,
  interrupted: () => interrupted,
  handOver(argv) {
    return new Promise((resolve) => {
      const child = spawn('bash', [...argv], { stdio: 'inherit' });
      child.on('error', () => { resolve(EXIT.failed); });
      child.on('close', (code, signal) => { resolve(code ?? (signal ? EXIT.cancelled : EXIT.failed)); });
    });
  },
};

/** @param {readonly string[]} argv @param {Sys} [sys] @returns {Promise<number>} */
export async function main(argv, sys = realSys) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: { checkout: { type: 'string' }, component: { type: 'string' }, launcher: { type: 'string' }, 'runtime-installed': { type: 'boolean', default: false } },
    }));
  } catch (error) {
    sys.error(`✗ ${error instanceof Error ? error.message : String(error)} (installer/bootstrap/main.js запускає лише ./install.sh)`);
    return EXIT.usage;
  }
  const { checkout, component, launcher } = values;
  if (!checkout || !launcher || (component !== 'server' && component !== 'agent')) {
    sys.error('✗ потрібні --checkout, --launcher і --component server|agent (installer/bootstrap/main.js запускає лише ./install.sh)');
    return EXIT.usage;
  }
  return prepare({ checkout, component, launcher, runtimeInstalled: values['runtime-installed'] }, sys);
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  // Ctrl+C reaches the whole foreground process group: the build stops by itself; this process cleans up and reports.
  process.on('SIGINT', () => { interrupted = true; });
  process.exitCode = await main(process.argv.slice(2));
}
