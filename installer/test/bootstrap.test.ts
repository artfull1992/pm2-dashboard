import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../bootstrap/main.js';
import { BUILDER, type Component, EXIT, type Paths, prepare, redact, type RunResult, type Sys, type UserInfo } from '../bootstrap/prepare.js';

// The guided preparation (installer/bootstrap) with a scripted system: users, commands and the terminal are fakes,
// files are real (temporary directories), so the release store, the log, the staging copy and the verification of the
// prepared release (the wizard's own verifyRelease) are exercised for real. Nothing outside the temp dirs is touched.

const SHA = 'b'.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A release as build-release.js writes it: server-bundle (+ BUNDLE.json) and the artifacts of `component`. */
function writeRelease(out: string, component: Component, sha = SHA): void {
  const bundle = join(out, 'server-bundle');
  const files: Record<string, string> = { 'server-release.js': '// tool', 'lib/manifest.js': '// lib', 'install/wizard.js': '// wizard', 'install/package.json': '{"type":"module"}' };
  for (const [f, content] of Object.entries(files)) { mkdirSync(dirname(join(bundle, f)), { recursive: true }); writeFileSync(join(bundle, f), content); }
  writeFileSync(join(bundle, 'BUNDLE.json'), JSON.stringify({ revision: sha, files: Object.fromEntries(Object.entries(files).map(([f, c]) => [f, sha256(c)])) }));
  for (const kind of component === 'server' ? ['api', 'agent'] : ['agent']) {
    const name = `node-control-${kind}-${sha}.tar.gz`;
    writeFileSync(join(out, name), `artifact ${kind}`);
    writeFileSync(join(out, `${name}.sha256`), `${sha256(`artifact ${kind}`)}  ${name}\n`);
  }
}

interface Options {
  euid?: number;
  env?: Record<string, string>;
  users?: UserInfo[];
  groups?: Record<string, string[]>;
  checkoutOwner?: number;
  check?: RunResult;
  answers?: (string | null)[];
  build?: (out: string, argv: readonly string[]) => number;
  tcp?: boolean;
  https?: boolean;
  free?: number;
  interrupted?: boolean;
}

function setup(o: Options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nc-boot-')));
  dirs.push(root);
  const paths: Paths = {
    store: join(root, 'store'), logs: join(root, 'logs'), builderHome: join(root, 'build-home'), sudoWorkBase: join(root, 'var-tmp'),
    apiBase: join(root, 'opt-node-control'), agentBase: join(root, 'opt-node-control-agent'),
  };
  mkdirSync(paths.sudoWorkBase);
  const checkout = join(root, 'my checkout');
  mkdirSync(checkout);
  const me = statSync(root).uid;
  const users = new Map<string, UserInfo>((o.users ?? []).map((u) => [u.name, u]));
  const commands: string[][] = [];
  const output: string[] = [];
  const handOver: string[][] = [];
  const answers = [...(o.answers ?? ['так'])];
  let workspace: string | null = null;
  const strip = (argv: readonly string[]) => (argv[0] === 'runuser' ? argv.slice(4) : [...argv]);
  const sys: Sys = {
    euid: () => o.euid ?? 0,
    env: o.env ?? {},
    user: (name) => users.get(name) ?? null,
    ownerOf: (path) => (path === checkout ? (o.checkoutOwner ?? 0) : null),
    groupsOf: (name) => o.groups?.[name] ?? [name],
    run(argv, cwd) {
      commands.push([...argv]);
      const a = strip(argv);
      const tail = a.slice(a.indexOf('env') >= 0 ? a.findIndex((x, i) => i > a.indexOf('env') && !x.includes('=') && x !== '-i') : 0);
      if (tail[1]?.endsWith('build-release.js') && tail[2] === '--check') return o.check ?? ok(`[build-release] revision=${SHA}\n`);
      if (tail[0] === 'git' && tail.includes('status')) return ok(' M backend/src/app.ts\n?? notes.txt\n');
      switch (a[0]) {
        case 'useradd': {
          mkdirSync(paths.builderHome, { recursive: true });
          users.set(BUILDER, { name: BUILDER, uid: me, gid: 990, home: paths.builderHome, shell: '/usr/sbin/nologin' });
          return ok();
        }
        case 'mktemp': {
          const base = a[a.indexOf('-p') + 1] ?? '';
          workspace = join(base, 'node-control-build.Abc12345');
          mkdirSync(workspace, { mode: 0o700 });
          return ok(`${workspace}\n`);
        }
        case 'mkdir': mkdirSync(a[1] ?? ''); return ok();
        case 'rm': rmSync(a.at(-1) ?? '', { recursive: true, force: true }); return ok();
        default: return { code: 127, stdout: '', stderr: `${a[0] ?? ''}: not simulated (cwd ${cwd})` };
      }
    },
    stream(argv, _cwd, log, onLine) {
      commands.push([...argv]);
      const out = argv[argv.indexOf('--out') + 1] ?? '';
      for (const stage of ['npm-ci', 'frontend-build', 'package']) { log(`[build-release] stage=${stage}\n`); onLine(`[build-release] stage=${stage}`); }
      log('npm http fetch GET 200 https://registry.npmjs.org/x (proxy http://user:s3cret@proxy.example.com:3128)\n');
      return Promise.resolve(o.build ? o.build(out, argv) : (writeRelease(out, argv.includes('agent') ? 'agent' : 'server'), 0));
    },
    pipe(a, b) {
      commands.push([...a], [...b]);
      if (a.includes('archive')) { mkdirSync(join(workspace ?? '', 'src'), { recursive: true }); return Promise.resolve(ok()); }
      // builder: tar -cf - -C <out> names… → root: tar -xf - -C <staging>: copied as is (symlinks too, like tar)
      const from = a[a.indexOf('-C') + 1] ?? '';
      const to = b[b.indexOf('-C') + 1] ?? '';
      for (const name of a.slice(a.indexOf('-C') + 2)) {
        if (!existsSync(join(from, name))) return Promise.resolve({ code: 2, stdout: '', stderr: `tar: ${name}: Cannot stat` });
        cpSync(join(from, name), join(to, name), { recursive: true, verbatimSymlinks: true });
      }
      return Promise.resolve(ok());
    },
    tcp: () => Promise.resolve(o.tcp ?? true),
    https: () => Promise.resolve(o.https ?? true),
    freeBytes: () => o.free ?? 50 * 1024 ** 3,
    ask(q) { output.push(q); return Promise.resolve(answers.length > 0 ? answers.shift() ?? null : null); },
    line(t) { output.push(t); },
    error(t) { output.push(t); },
    now: () => new Date('2026-10-21T12:00:00.000Z'),
    nodePath: '/opt/node-control-runtime/versions/node-v22.23.4-linux-x64/bin/node',
    nodeVersion: 'v22.23.4',
    interrupted: () => o.interrupted ?? false,
    handOver(argv) { handOver.push([...argv]); return Promise.resolve(0); },
  };
  const opts = (component: Component = 'server', runtimeInstalled = false) => ({ checkout, component, launcher: join(checkout, 'install.sh'), runtimeInstalled });
  return { root, paths, checkout, sys, commands, output, handOver, opts, me, users, text: () => output.join('\n'), workspace: () => workspace };
}

const ALICE: UserInfo = { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice', shell: '/bin/bash' };
const sudoEnv = { SUDO_USER: 'alice', SUDO_UID: '1000', SECRET_TOKEN: 'ncag_do-not-leak', PATH: '/root/evil:/usr/bin' };
const builds = (s: ReturnType<typeof setup>) => s.commands.filter((c) => c.some((a) => a.endsWith('build-release.js')) && c.includes('--from-tree'));

describe('guided preparation: who builds (never root)', () => {
  it('root under sudo: the invoking user builds in /var/tmp with an empty environment; git runs as the checkout owner', async () => {
    const s = setup({ env: sudoEnv, users: [ALICE], checkoutOwner: 1000 });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(0);
    const [b] = builds(s);
    expect(b?.slice(0, 6)).toEqual(['runuser', '-u', 'alice', '--', 'env', '-i']);
    expect(b).toContain('HOME=/home/alice');
    expect(b).toContain('PATH=/opt/node-control-runtime/versions/node-v22.23.4-linux-x64/bin:/usr/bin:/bin'); // the checked Node.js first
    expect(b).toContain('/opt/node-control-runtime/versions/node-v22.23.4-linux-x64/bin/node');
    expect(b?.join(' ')).not.toMatch(/SECRET_TOKEN|ncag_|\/root\/evil/); // nothing of root's environment
    expect(s.commands.find((c) => c.includes('archive'))?.slice(0, 4)).toEqual(['runuser', '-u', 'alice', '--']);
    expect(s.commands.some((c) => c[0] === 'useradd')).toBe(false);
    expect(s.workspace()).toContain(s.paths.sudoWorkBase);
  });

  it('root without sudo: a dedicated nodecontrol-build account (no shell) is created after the confirmation and builds; git runs as root', async () => {
    const s = setup({ checkoutOwner: 0 });
    expect(await prepare(s.opts('agent'), s.sys, s.paths)).toBe(0);
    const useradd = s.commands.find((c) => c[0] === 'useradd');
    expect(useradd).toEqual(['useradd', '--system', '--user-group', '--home-dir', s.paths.builderHome, '--create-home', '--shell', '/usr/sbin/nologin', BUILDER]);
    expect((statSync(s.paths.builderHome).mode & 0o777).toString(8)).toBe('700');
    expect(builds(s)[0]?.slice(0, 4)).toEqual(['runuser', '-u', BUILDER, '--']);
    expect(builds(s)[0]).toContain('--component');
    const archive = s.commands.find((c) => c.includes('archive'));
    expect(archive?.[0]).toBe('env'); // root (owner of the checkout) reads git; the builder never sees the checkout
    expect(s.text()).toMatch(/системний користувач nodecontrol-build для збирання: без shell, без sudo/);
  });

  it('every command that runs build code or npm runs as a non-root user', async () => {
    for (const s of [setup({ env: sudoEnv, users: [ALICE], checkoutOwner: 1000 }), setup({ checkoutOwner: 0 })]) {
      expect(await prepare(s.opts(), s.sys, s.paths)).toBe(0);
      const code = s.commands.filter((c) => c.some((a) => /build-release\.js$|^npm$|^tar$/.test(a)) && !c.includes('--check') && !c.includes('-xf'));
      expect(code.length).toBeGreaterThan(1);
      for (const c of code) expect(c[0], c.join(' ')).toBe('runuser');
    }
  });

  it.each([
    ['a login shell', { shell: '/bin/bash' }, /має shell/],
    ['membership in sudo', {}, /входить до груп sudo/],
    ['UID 0', { uid: 0 }, /не системний/],
  ])('an existing nodecontrol-build with %s is not used and not changed', async (_n, patch, why) => {
    const s = setup({ checkoutOwner: 0, groups: { [BUILDER]: [BUILDER, 'sudo'] } });
    mkdirSync(s.paths.builderHome, { mode: 0o700 });
    s.users.set(BUILDER, { name: BUILDER, uid: s.me, gid: 990, home: s.paths.builderHome, shell: '/usr/sbin/nologin', ...patch });
    if (!('shell' in patch) && !('uid' in patch)) s.users.set(BUILDER, { ...s.users.get(BUILDER) as UserInfo });
    else s.sys.groupsOf = () => [BUILDER];
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(why);
    expect(s.commands.filter((c) => ['useradd', 'mktemp'].includes(c[0] ?? ''))).toEqual([]);
  });

  it('a checkout owned by a third user is refused (git would run on code nobody trusted)', async () => {
    const s = setup({ env: sudoEnv, users: [ALICE], checkoutOwner: 1234 });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(/належить іншому користувачу \(UID 1234\)/);
  });

  it('SUDO_USER that does not match SUDO_UID is not trusted as the builder', async () => {
    const s = setup({ env: { SUDO_USER: 'alice', SUDO_UID: '1001' }, users: [ALICE], checkoutOwner: 0 });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(0);
    expect(builds(s)[0]?.[2]).toBe(BUILDER);
  });

  it('not root → usage error (install.sh always runs it as root)', async () => {
    const s = setup({ euid: 1000 });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.usage);
    expect(s.commands).toEqual([]);
  });
});

describe('guided preparation: the revision', () => {
  it('dirty checkout → refused with the changed files; nothing is committed, stashed, reset or pulled', async () => {
    const s = setup({ checkoutOwner: 0, check: { code: 1, stdout: '', stderr: '[build-release] ERROR: working tree is not clean; commit or stash first' } });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(/незакомічені або невідстежувані зміни.*без commit, stash, reset чи pull/);
    expect(s.text()).toContain('M backend/src/app.ts');
    const git = s.commands.filter((c) => c.includes('git')).map((c) => c.slice(c.indexOf('git') + 1).filter((a) => !a.startsWith('/') && a !== '-C'));
    expect(git).toEqual([['status', '--short']]);
    expect(existsSync(s.paths.store)).toBe(false);
  });

  it('a commit that is not in origin/main → refused (git pull is never run)', async () => {
    const s = setup({ checkoutOwner: 0, check: { code: 1, stdout: '', stderr: `[build-release] ERROR: ${SHA} is not contained in origin/main; push it first` } });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(/не міститься в origin\/main.*git pull не виконує/);
  });

  it('another revision already active for this component → stop before building (an upgrade)', async () => {
    const s = setup({ checkoutOwner: 0 });
    mkdirSync(s.paths.apiBase);
    symlinkSync(`releases/${'c'.repeat(40)}`, join(s.paths.apiBase, 'current'));
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(/уже активний інший реліз cccccccccccc: це оновлення/);
    expect(builds(s)).toEqual([]);
  });
});

describe('guided preparation: plan, confirmation, prerequisites', () => {
  it('the plan is shown before anything changes; cancel (EOF, Ctrl+D, Ctrl+C or another answer) changes nothing', async () => {
    for (const answer of [null, 'ні', 'y']) {
      const s = setup({ checkoutOwner: 0, answers: [answer] });
      expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.cancelled);
      expect(s.text()).toMatch(/Буде виконано:[\s\S]*збирання від користувача nodecontrol-build \(не root\)[\s\S]*Скасовано\. Нічого не змінено\./);
      expect(s.commands.filter((c) => ['useradd', 'mktemp'].includes(c[0] ?? '') || c[0] === 'runuser')).toEqual([]);
      expect(existsSync(s.paths.store) || existsSync(s.paths.logs)).toBe(false);
    }
  });

  it('cancel after install.sh installed the runtime in this run says so', async () => {
    const s = setup({ checkoutOwner: 0, answers: [null] });
    expect(await prepare(s.opts('server', true), s.sys, s.paths)).toBe(EXIT.cancelled);
    expect(s.text()).toMatch(/Крім щойно встановленого runtime \(\/opt\/node-control-runtime\) система не змінювалась/);
  });

  it.each([
    ['server without PostgreSQL on 127.0.0.1:5432', 'server', { tcp: false }, /PostgreSQL не приймає з'єднань на 127\.0\.0\.1:5432.*2\.1 База даних/],
    ['not enough disk space', 'agent', { free: 100 * 1024 ** 2 }, /замало місця .*0\.1 ГіБ, для збирання потрібно щонайменше 0\.5 ГіБ/],
    ['no HTTPS to the npm registry', 'agent', { https: false }, /немає HTTPS-доступу до registry\.npmjs\.org/],
  ] as const)('%s → reported before the expensive build, nothing changed', async (_n, component, o, why) => {
    const s = setup({ checkoutOwner: 0, ...o });
    expect(await prepare(s.opts(component), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(why);
    expect(s.output.some((l) => l.includes('Підготувати реліз?'))).toBe(false);
    expect(existsSync(s.paths.store)).toBe(false);
  });

  it('an Agent needs no PostgreSQL; with a proxy configured the registry check is left to npm', async () => {
    const s = setup({ checkoutOwner: 0, tcp: false, https: false, env: { HTTPS_PROXY: 'http://proxy.example.com:3128' } });
    expect(await prepare(s.opts('agent'), s.sys, s.paths)).toBe(0);
    expect(builds(s)[0]).toContain('HTTPS_PROXY=http://proxy.example.com:3128');
  });
});

describe('guided preparation: the release', () => {
  it('server: built, copied by root into the store (700), verified, then the guided installer of THAT release with the chosen component', async () => {
    const s = setup({ checkoutOwner: 0 });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(0);
    const target = join(s.paths.store, `${SHA}-server`);
    expect(readdirSync(target).sort()).toEqual([`node-control-agent-${SHA}.tar.gz`, `node-control-agent-${SHA}.tar.gz.sha256`, `node-control-api-${SHA}.tar.gz`, `node-control-api-${SHA}.tar.gz.sha256`, 'server-bundle']);
    expect((statSync(s.paths.store).mode & 0o777).toString(8)).toBe('700');
    expect(s.handOver).toEqual([[join(s.checkout, 'install.sh'), '--release', target, '--component', 'server']]);
    expect(readdirSync(s.paths.store)).toEqual([`${SHA}-server`]); // no staging left behind
    expect(existsSync(s.workspace() ?? '')).toBe(false); // workspace removed (by the builder)
    expect(s.commands.find((c) => c.includes('rm'))?.slice(0, 4)).toEqual(['runuser', '-u', BUILDER, '--']);
    const [log] = readdirSync(s.paths.logs);
    expect(log).toBe('build-bbbbbbbbbbbb-server-20261021T120000Z.log');
    expect((statSync(join(s.paths.logs, log ?? '')).mode & 0o777).toString(8)).toBe('600');
    expect(s.text()).toMatch(/… залежності з package-lock\.json \(npm ci\)[\s\S]*… збирання веб-інтерфейсу[\s\S]*✓ реліз перевірено й збережено/);
  });

  it('agent: the targeted build (--component agent) without the API artifact', async () => {
    const s = setup({ checkoutOwner: 0 });
    expect(await prepare(s.opts('agent'), s.sys, s.paths)).toBe(0);
    expect(builds(s)[0]?.slice(-2)).toEqual(['--component', 'agent']);
    expect(readdirSync(join(s.paths.store, `${SHA}-agent`)).sort()).toEqual([`node-control-agent-${SHA}.tar.gz`, `node-control-agent-${SHA}.tar.gz.sha256`, 'server-bundle']);
    expect(s.text()).toMatch(/npm ci лише typescript і @types\/node[\s\S]*без веб-інтерфейсу й API/);
  });

  it('a prepared, verified release of this revision is reused: no confirmation, no build', async () => {
    const s = setup({ checkoutOwner: 0, answers: [] });
    writeRelease(join(s.paths.store, `${SHA}-agent`), 'agent');
    expect(await prepare(s.opts('agent'), s.sys, s.paths)).toBe(0);
    expect(builds(s)).toEqual([]);
    expect(s.text()).toMatch(/уже підготовлено й перевірено.*повторне збирання не потрібне/);
    expect(s.handOver[0]?.slice(1)).toEqual(['--release', join(s.paths.store, `${SHA}-agent`), '--component', 'agent']);
  });

  it('a stored release that fails verification is set aside (never used) and rebuilt after the confirmation', async () => {
    const s = setup({ checkoutOwner: 0 });
    const target = join(s.paths.store, `${SHA}-agent`);
    writeRelease(target, 'agent');
    writeFileSync(join(target, 'server-bundle', 'install', 'wizard.js'), '// changed');
    expect(await prepare(s.opts('agent'), s.sys, s.paths)).toBe(0);
    expect(s.text()).toMatch(/не пройшов перевірки .*вміст змінено.*перейменовано на \.invalid/);
    expect(readdirSync(s.paths.store).sort()).toEqual([`${SHA}-agent`, `${SHA}-agent.invalid-20261021T120000Z`]);
    expect(readFileSync(join(target, 'server-bundle', 'install', 'wizard.js'), 'utf8')).toBe('// wizard');
  });

  it.each([
    ['the build fails', (out: string) => { mkdirSync(out, { recursive: true }); return 1; }, /етапі «артефакти й server-bundle»: build-release\.js завершився з кодом 1/],
    ['the output contains a symlink', (out: string) => { writeRelease(out, 'server'); symlinkSync('/etc/shadow', join(out, 'server-bundle', 'x')); return 0; }, /не звичайний файл/],
    ['the output does not match BUNDLE.json', (out: string) => { writeRelease(out, 'server'); writeFileSync(join(out, 'server-bundle', 'server-release.js'), 'evil'); return 0; }, /вміст змінено/],
    ['an artifact is missing', (out: string) => { writeRelease(out, 'agent'); return 0; }, /tar: node-control-api-.*Cannot stat/],
    ['the release is of another revision', (out: string) => { writeRelease(out, 'server', 'd'.repeat(40)); return 0; }, /Cannot stat|артефакт іншої ревізії|ревізія/],
  ])('%s → no release is stored or handed over; the log tail is shown without credentials; a retry starts clean', async (_n, build, why) => {
    const s = setup({ checkoutOwner: 0, build });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(why);
    expect(s.text()).toMatch(/Реліз не створено й нічого не активовано/);
    expect(s.text()).toContain('proxy http://***@proxy.example.com:3128');
    expect(s.text()).not.toContain('s3cret');
    expect(s.handOver).toEqual([]);
    expect(readdirSync(s.paths.store)).toEqual([]); // neither the release nor a staging copy
    expect(existsSync(s.workspace() ?? '')).toBe(false);
    const retry = setup({ checkoutOwner: 0 });
    retry.paths.store = s.paths.store;
    retry.paths.logs = s.paths.logs;
    expect(await prepare(retry.opts(), retry.sys, retry.paths), retry.text()).toBe(0);
  });

  it('Ctrl+C during the build → 130, nothing stored', async () => {
    const s = setup({ checkoutOwner: 0, interrupted: true, build: () => 130 });
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.cancelled);
    expect(s.text()).toMatch(/Підготовку перервано \(Ctrl\+C\) на етапі «артефакти й server-bundle»/);
    expect(readdirSync(s.paths.store)).toEqual([]);
  });

  it('the store must be a root-only directory: a group/other-writable one is not used', async () => {
    const s = setup({ checkoutOwner: 0 });
    mkdirSync(s.paths.store);
    chmodSync(s.paths.store, 0o777);
    expect(await prepare(s.opts(), s.sys, s.paths)).toBe(EXIT.failed);
    expect(s.text()).toMatch(/не каталог root без запису для інших/);
  });
});

describe('bootstrap entry point and helpers', () => {
  it('main: only ./install.sh starts it — missing or wrong arguments → 2, nothing done', async () => {
    const s = setup();
    expect(await main([], s.sys)).toBe(2);
    expect(await main(['--checkout', s.checkout, '--launcher', 'x', '--component', 'db'], s.sys)).toBe(2);
    expect(await main(['--bogus'], s.sys)).toBe(2);
    expect(s.commands).toEqual([]);
  });

  it('redact hides credentials in URLs only', () => {
    expect(redact('GET https://u:p@registry.example.com/x and http://proxy.example.com:3128')).toBe('GET https://***@registry.example.com/x and http://proxy.example.com:3128');
  });
});
