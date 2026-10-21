import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// install.sh as a REAL process with temporary fixtures (a checkout dir with a space, prepared releases next to it, a
// fake wizard.js that prints its arguments). Nothing outside the temporary directory is touched; no root needed.
// The final exec needs /usr/bin/node 22 (Linux hosts); elsewhere the run stops at that check, after all others passed.

const LAUNCHER = join(import.meta.dirname, '..', '..', 'install.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { spawnSync('chmod', ['-R', 'u+w', d]); rmSync(d, { recursive: true, force: true }); } });
const node22 = existsSync('/usr/bin/node') && spawnSync('/usr/bin/node', ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim() === '22';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-launch-')));
  chmodSync(root, 0o755);
  dirs.push(root);
  const checkout = join(root, 'my checkout');
  mkdirSync(checkout, { mode: 0o755 });
  copyFileSync(LAUNCHER, join(checkout, 'install.sh'));
  chmodSync(join(checkout, 'install.sh'), 0o755);
  const releases = join(root, 'node-control-releases');
  const addRelease = (name: string, base = releases) => {
    const dir = join(base, name);
    mkdirSync(join(dir, 'server-bundle', 'install'), { recursive: true, mode: 0o755 });
    // The fake wizard leaves a marker: a refusal must happen before ANY code of the release runs.
    writeFileSync(join(dir, 'server-bundle', 'install', 'wizard.js'), `require('fs').writeFileSync(${JSON.stringify(join(root, 'EXECUTED'))}, '1'); console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`, { mode: 0o644 });
    return dir;
  };
  return { root, checkout, releases, addRelease, launcher: join(checkout, 'install.sh'), executed: () => existsSync(join(root, 'EXECUTED')) };
}
const run = (cmd: string, args: string[] = [], cwd = '/') => spawnSync('bash', [cmd, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });

describe('install.sh launcher', () => {
  it('--help: no root, no release, any cwd; exit 0', () => {
    const f = fixture();
    const r = run(f.launcher, ['--help'], f.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/sudo \.\/install\.sh --release <каталог>/);
    expect(r.stdout).toContain(f.releases);
  });

  it('unknown option → 2; --release without a value → 2', () => {
    const f = fixture();
    expect(run(f.launcher, ['--yes']).status).toBe(2);
    expect(run(f.launcher, ['--release']).status).toBe(2);
  });

  it('no prepared release → 1 with the exact preparation commands', () => {
    const f = fixture();
    const r = run(f.launcher);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Підготовленого релізу не знайдено/);
    expect(r.stderr).toMatch(/node scripts\/deploy\/build-release\.js --out/);
  });

  it('several releases → 2, the operator chooses (quoted commands, paths with spaces); never "the newest"', () => {
    const f = fixture();
    f.addRelease('rel one');
    f.addRelease('rel two');
    const r = run(f.launcher);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/оберіть явно/);
    expect(r.stderr).toContain('--release ');
    expect(r.stderr).toContain('rel\\ one');
    expect(r.stderr).toContain('rel\\ two');
  });

  it.each([
    ['a group-writable file', (dir: string) => { chmodSync(join(dir, 'server-bundle', 'install', 'wizard.js'), 0o664); }],
    ['a world-writable directory', (dir: string) => { chmodSync(join(dir, 'server-bundle'), 0o777); }],
    ['a symlink', (dir: string) => { symlinkSync('/etc/passwd', join(dir, 'server-bundle', 'install', 'x.js')); }],
  ])('release with %s → refused before running anything', (_n, arrange) => {
    const f = fixture();
    const dir = f.addRelease('r1');
    arrange(dir);
    const r = run(f.launcher);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/не захищений від змін/);
    expect(r.stdout).not.toMatch(/"argv"/);
    expect(f.executed()).toBe(false);
  });

  it('an ancestor writable by others is refused unless it is a ROOT-owned sticky directory; nothing of the release runs', () => {
    const f = fixture();
    const open = join(f.root, 'shared');
    mkdirSync(open);
    const dir = f.addRelease('r1', open);
    for (const mode of [0o777, 0o1777]) { // 1777 but owned by this user, not root: not treated as safe (review 2026-10-21)
      chmodSync(open, mode);
      const r = run(f.launcher, ['--release', dir]);
      expect(r.status, mode.toString(8)).toBe(1);
      expect(r.stderr).toMatch(/доступний на запис іншим/);
    }
    expect(f.executed()).toBe(false);
  });

  it('a release under the root-owned sticky /tmp (own subdirectory) passes the path checks', () => {
    const f = fixture();
    const base = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'nc-launch-tmp-')));
    dirs.push(base);
    chmodSync(base, 0o755);
    const dir = f.addRelease('r1', base);
    const r = run(f.launcher, ['--release', dir]);
    expect(r.stderr).not.toMatch(/доступний на запис іншим|належить іншому користувачу|не захищений/);
    expect(r.status).toBe(node22 ? 0 : 1);
  });

  it('invoked through a symlink: the real checkout decides the default release directory', () => {
    const f = fixture();
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    symlinkSync(f.launcher, join(bin, 'nc-install'));
    const r = run(join(bin, 'nc-install'), ['--help'], '/');
    expect(r.stdout).toContain(f.releases);
    expect(r.stdout).not.toContain(join(f.root, 'node-control-releases', 'bin'));
  });

  it('one release (default dir or --release with spaces / --release=): checks pass; with Node 22 the wizard of THAT release runs with --release <real path>, cwd kept', () => {
    const f = fixture();
    const dir = f.addRelease('rel 1');
    for (const args of [[], ['--release', dir], [`--release=${dir}`]]) {
      const r = run(f.launcher, args, f.root);
      if (node22) {
        expect(r.status, r.stderr).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ argv: ['--release', dir], cwd: f.root });
      } else {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/Потрібен Node\.js 22 у \/usr\/bin\/node/); // every check before it passed
      }
    }
  });
});
