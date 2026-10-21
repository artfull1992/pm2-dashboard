import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// install.sh as a REAL bash process with temporary fixtures; nothing outside the temporary directories is touched and
// no root is needed. The main part needs root on Ubuntu (verified on disposable VMs, PROJECT_STATUS); here: the parts
// before root, the re-run through sudo (a fake sudo on PATH records its argv), and — by sourcing the script — its
// trust, version and runtime-selection functions.

const REPO = join(import.meta.dirname, '..', '..');
const LAUNCHER = join(REPO, 'install.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { spawnSync('chmod', ['-R', 'u+w', d]); rmSync(d, { recursive: true, force: true }); } });

function tempDir(prefix: string, base = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(join(base, prefix)));
  chmodSync(dir, 0o755);
  dirs.push(dir);
  return dir;
}

/** A checkout as `git clone` leaves it: no node_modules, no dist, no artifacts (path with a space). */
function cleanCheckout() {
  const root = tempDir('nc-launch-');
  const checkout = join(root, 'my checkout');
  mkdirSync(join(checkout, 'installer', 'bootstrap'), { recursive: true });
  copyFileSync(LAUNCHER, join(checkout, 'install.sh'));
  chmodSync(join(checkout, 'install.sh'), 0o755);
  copyFileSync(join(REPO, 'installer', 'bootstrap', 'node-runtime.env'), join(checkout, 'installer', 'bootstrap', 'node-runtime.env'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Fake sudo: records how install.sh re-runs itself, never escalates anything.
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(root, 'SUDO_ARGV'))}\nexit 0\n`, { mode: 0o755 });
  return { root, checkout, launcher: join(checkout, 'install.sh'), bin, sudoArgv: () => (existsSync(join(root, 'SUDO_ARGV')) ? readFileSync(join(root, 'SUDO_ARGV'), 'utf8').trim().split('\n') : null) };
}

const env = (bin?: string) => ({ PATH: `${bin ? `${bin}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`, LANG: 'C.UTF-8' });
const run = (cmd: string, args: string[] = [], cwd = '/', bin?: string) => spawnSync('bash', [cmd, ...args], { cwd, encoding: 'utf8', env: env(bin), input: '' });

/** In a pseudo terminal (python3 pty, no new dependency): stdin/stdout are a TTY like for an operator. */
function inPty(argv: string[], cwd: string, bin: string) {
  const driver = [
    'import os,pty,sys',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '  os.chdir(sys.argv[1]); os.execvp(sys.argv[2], sys.argv[2:])',
    'out = b""',
    'while True:',
    '  try: d = os.read(fd, 4096)',
    '  except OSError: break',
    '  if not d: break',
    '  out += d',
    '_, st = os.waitpid(pid, 0)',
    'sys.stdout.write(out.decode("utf8", "replace"))',
    'sys.exit(os.waitstatus_to_exitcode(st))',
  ].join('\n');
  return spawnSync('python3', ['-c', driver, cwd, ...argv], { encoding: 'utf8', env: env(bin), timeout: 20_000 });
}

/** Sources install.sh (functions only) and runs `body` in that shell. */
function sourced(body: string, cwd = '/') {
  return spawnSync('bash', ['-c', `set -euo pipefail; source ${JSON.stringify(LAUNCHER)}; ${body}`], { cwd, encoding: 'utf8', env: env() });
}

describe('install.sh: before root', () => {
  it('--help: exit 0 without root, from any cwd and through a symlink; the main route needs no npm/build commands', () => {
    const f = cleanCheckout();
    const link = join(f.root, 'nc-install');
    symlinkSync(f.launcher, link);
    for (const r of [run(f.launcher, ['--help'], f.root), run(link, ['-h'], '/')]) {
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^ {2}\.\/install\.sh {2,}/m);
      expect(r.stdout).toMatch(/Окремі npm\/build-команди не потрібні/);
      expect(r.stdout).toMatch(/--release <каталог>/);
      expect(r.stdout).toContain('Node.js 22.23.4');
      expect(r.stdout).not.toMatch(/npm ci/);
    }
    expect(f.sudoArgv()).toBeNull();
  });

  it.each([[['--yes']], [['--release']], [['--component']], [['--component', 'db']], [['--component=web']], [['--node-archive']]])('bad options %j → 2, nothing run', (args) => {
    const f = cleanCheckout();
    expect(run(f.launcher, args, f.root, f.bin).status).toBe(2);
    expect(f.sudoArgv()).toBeNull();
  });

  it('without a terminal → 2 with the advanced CLI hint; no sudo, no download, no build', () => {
    const f = cleanCheckout();
    const r = run(f.launcher, [], f.root, f.bin);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/працює лише в терміналі \(нічого не змінено\)/);
    expect(r.stderr).toMatch(/server\.js \| agent\.js plan\|apply/);
    expect(f.sudoArgv()).toBeNull();
  });

  it('a damaged runtime spec (node-runtime.env) → 1 before anything else', () => {
    const f = cleanCheckout();
    writeFileSync(join(f.checkout, 'installer', 'bootstrap', 'node-runtime.env'), 'NODE_MIN=22.22.0\nNODE_VERSION=latest\n');
    const r = inPty(['bash', f.launcher], f.root, f.bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/node-runtime\.env відсутній або пошкоджений/);
    expect(f.sudoArgv()).toBeNull();
  });

  // Regression (user report 2026-10-21): after `git clone` the old launcher stopped with "no prepared release" and
  // printed manual npm ci / build-release.js commands. Now a clean checkout goes straight into the guided route.
  it('REGRESSION: clean clone (no node_modules, dist or artifacts), ordinary user → re-runs itself through sudo with the same argv; never asks for npm/build', () => {
    if (spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim() === '0') return; // as root there is no sudo step
    const f = cleanCheckout();
    for (const args of [[], ['--component', 'agent'], ['--release', '/x y']]) {
      rmSync(join(f.root, 'SUDO_ARGV'), { force: true });
      const r = inPty(['bash', f.launcher, ...args], f.root, f.bin);
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toMatch(/Перезапуск через sudo; збирання релізу виконуватиметься від вашого користувача/);
      expect(r.stdout).not.toMatch(/npm ci|build-release\.js --out|Підготовленого релізу не знайдено/);
      expect(f.sudoArgv()).toEqual(['--', f.launcher, ...args]);
    }
  });
});

describe('install.sh functions (sourced): versions and the pinned runtime', () => {
  it.each([
    ['22.22.0', true], ['22.23.4', true], ['22.40.0', true], ['22.21.9', false], ['21.7.3', false], ['24.14.0', false], ['', false], ['22.x.1', false],
  ])('version_ok %s → %s (NODE_MIN from node-runtime.env)', (v, expected) => {
    const r = sourced(`read_spec "$spec"; version_ok ${JSON.stringify(v)} && echo YES || echo NO`);
    expect(r.stdout.trim()).toBe(expected ? 'YES' : 'NO');
  });

  it('read_spec rejects a spec without all four validated values (no "latest", no short hashes)', () => {
    const dir = tempDir('nc-spec-');
    const good = readFileSync(join(REPO, 'installer', 'bootstrap', 'node-runtime.env'), 'utf8');
    for (const [name, text] of [['good', good], ['latest', good.replace(/NODE_VERSION=.*/, 'NODE_VERSION=latest')], ['short', good.replace(/(SHA256_LINUX_X64=)[0-9a-f]+/, '$1abc')], ['23', good.replace(/NODE_MIN=.*/, 'NODE_MIN=23.0.0')]] as const) {
      writeFileSync(join(dir, name), text);
      expect(sourced(`read_spec ${JSON.stringify(join(dir, name))} && echo OK || echo BAD`).stdout.trim(), name).toBe(name === 'good' ? 'OK' : 'BAD');
    }
  });

  function fakeNode(dir: string, version: string): string {
    const path = join(dir, `node-${version || 'broken'}`);
    writeFileSync(path, version ? `#!/bin/sh\necho ${version}\n` : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return path;
  }
  const select = (system: string, runtimeDir: string, extra = '') => sourced(
    `read_spec "$spec"; trust_init; RUNTIME_DIR=${JSON.stringify(runtimeDir)}; RUNTIME_NODE="$RUNTIME_DIR/bin/node"; SYSTEM_NODE=${JSON.stringify(system)}; node_archive=""; ${extra} select_runtime; echo "NODE=$node"; echo "WHY=$why"`,
  );

  it.each([
    ['21.7.3', /^NODE=$/m, /Системний Node\.js 21\.7\.3 .* не підходить: потрібен 22 не старший за 22\.22\.0/],
    ['22.21.0', /^NODE=$/m, /Системний Node\.js 22\.21\.0/],
    ['24.14.0', /^NODE=$/m, /Системний Node\.js 24\.14\.0/],
    ['', /^NODE=$/m, /не встановлено|не підходить/],
    ['22.23.4', /^NODE=.*node-22\.23\.4$/m, /сумісний — окремий runtime не завантажується/],
  ])('no runtime yet, system Node.js %j → %s', (version, nodeLine, message) => {
    const dir = tempDir('nc-rt-');
    const r = select(fakeNode(dir, version), join(dir, 'runtime'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(nodeLine);
    expect(r.stdout).toMatch(message);
  });

  it('--node-archive asks for the runtime even when the system Node.js is compatible', () => {
    const dir = tempDir('nc-rt-');
    const r = select(fakeNode(dir, '22.23.4'), join(dir, 'runtime'), 'node_archive=/x.tar.gz;');
    expect(r.stdout).toMatch(/^NODE=$/m);
    expect(r.stdout).toMatch(/передано --node-archive/);
  });

  it('an existing runtime that is not root-owned is never used (and never replaced)', () => {
    const dir = tempDir('nc-rt-');
    mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true });
    symlinkSync(fakeNode(dir, '22.23.4'), join(dir, 'runtime', 'bin', 'node'));
    const r = select(fakeNode(dir, '22.23.4'), join(dir, 'runtime'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/має належати root без запису для інших/);
    expect(existsSync(join(dir, 'runtime', 'bin', 'node'))).toBe(true);
  });
});

describe('install.sh functions (sourced): what root may execute', () => {
  const protectedCheck = (path: string) => sourced(`trust_init; assert_protected ${JSON.stringify(path)}; echo PASSED`);
  /** A tree as a release or the bootstrap part of a checkout: one file, one subdirectory. */
  function tree(base: string) {
    const dir = join(base, 'rel');
    mkdirSync(join(dir, 'sub'), { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, 'sub', 'main.js'), '// code', { mode: 0o644 });
    return dir;
  }

  it('a clean tree under an own directory passes; under the root-owned sticky /tmp as well', () => {
    expect(protectedCheck(tree(tempDir('nc-trust-'))).stdout).toContain('PASSED');
    expect(protectedCheck(tree(tempDir('nc-trust-', realpathSync('/tmp')))).stdout).toContain('PASSED');
  });

  it.each([
    ['a world-writable file', (d: string) => { chmodSync(join(d, 'sub', 'main.js'), 0o646); }],
    ['a world-writable directory', (d: string) => { chmodSync(join(d, 'sub'), 0o777); }],
    ['a symlink', (d: string) => { symlinkSync('/etc/passwd', join(d, 'sub', 'x.js')); }],
  ])('%s → refused', (_n, arrange) => {
    const dir = tree(tempDir('nc-trust-'));
    arrange(dir);
    const r = protectedCheck(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Не захищено від змін іншими користувачами/);
  });

  it('group write: allowed only through the private group of a trusted user (Ubuntu umask 002), refused for a shared group', () => {
    const dir = tree(tempDir('nc-trust-'));
    chmodSync(join(dir, 'sub', 'main.js'), 0o664);
    const gid = execFileSync('stat', process.platform === 'darwin' ? ['-f', '%g', join(dir, 'sub', 'main.js')] : ['-c', '%g', join(dir, 'sub', 'main.js')], { encoding: 'utf8' }).trim();
    const hasGetent = spawnSync('sh', ['-c', 'command -v getent'], { encoding: 'utf8' }).status === 0;
    const members = hasGetent ? execFileSync('getent', ['group', gid], { encoding: 'utf8' }).trim().split(':')[3] ?? '' : 'unknown';
    const primaryOf = hasGetent ? execFileSync('sh', ['-c', `getent passwd | awk -F: -v g=${gid} '$4 == g' | wc -l`], { encoding: 'utf8' }).trim() : '0';
    const isPrivate = hasGetent && members === '' && primaryOf === '1' && gid === execFileSync('id', ['-g'], { encoding: 'utf8' }).trim() && gid !== '0';
    const r = protectedCheck(dir);
    expect(r.status, `gid ${gid} private=${String(isPrivate)}`).toBe(isPrivate ? 0 : 1);
  });

  it('ancestors: a world-writable directory or a sticky one NOT owned by root is refused; nothing runs', () => {
    const base = tempDir('nc-trust-');
    const open = join(base, 'shared');
    mkdirSync(open);
    const dir = tree(open);
    for (const mode of [0o777, 0o1777]) {
      chmodSync(open, mode);
      const r = protectedCheck(dir);
      expect(r.status, mode.toString(8)).toBe(1);
      expect(r.stderr).toMatch(/доступний на запис іншим/);
    }
  });

  it('the main part checks the release / checkout parts before handing over (order in the script)', () => {
    const text = readFileSync(LAUNCHER, 'utf8');
    const main = text.slice(text.indexOf('# Sourced (tests): functions only.'));
    expect(main.indexOf('assert_protected "$release"')).toBeLessThan(main.indexOf('exec "$node" --use-system-ca "$release/server-bundle/install/wizard.js"'));
    expect(main.indexOf('for part in installer/bootstrap scripts/deploy .git; do assert_protected')).toBeLessThan(main.indexOf('exec "$node" --use-system-ca "$checkout/installer/bootstrap/main.js"'));
    expect(main.indexOf('exec sudo -- "$self" ${args[@]+"${args[@]}"}')).toBeLessThan(main.indexOf('select_runtime'));
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, '')).join('\n');
    expect(code).not.toMatch(/\beval\b|curl[^\n]*\|\s*(sudo\s+)?(ba)?sh\b|source\s+"\$spec"|\.\s+"\$spec"/);
  });
});
