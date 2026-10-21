// @ts-check
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Guided preparation from a git checkout (ADR-027): what ./install.sh does between "which component?" and the guided
// installer of a release. Runs as root (install.sh re-runs itself through sudo) on the compatible Node.js 22 chosen by
// install.sh, directly from the checkout. JavaScript checked by tsc (// @ts-check, strict), not TypeScript: it must run
// before anything is built, and distribution builds of Node.js 22 (Ubuntu's nodejs) have no TypeScript support.
// It never builds as root:
//   root under sudo        → the user who invoked sudo builds (runuser, empty environment);
//   root without sudo      → the dedicated system user nodecontrol-build (no shell, no sudo, no secrets) builds.
// The source is always a `git archive` of a committed revision that build-release.js --check accepted (clean
// checkout, contained in origin/main), streamed into the builder's workspace; the build is the existing
// scripts/deploy/build-release.js of that revision. The result is copied by root out of the builder's reach into the
// root-only release store, verified (BUNDLE.json, SHA-256 of every file and artifact) and only then renamed into
// place; the guided installer of that release does the rest (install.sh --release … --component …). Nothing is
// activated here.

/** @typedef {'server' | 'agent'} Component */
/** @typedef {{ name: string, uid: number, gid: number, home: string, shell: string }} UserInfo */
/** @typedef {{ code: number, stdout: string, stderr: string }} RunResult */
/**
 * @typedef {object} Paths
 * @property {string} store        verified releases, one per revision and component (root 700)
 * @property {string} logs         build logs (root 700, files 600)
 * @property {string} builderHome  home and workspace base of the dedicated builder (700)
 * @property {string} sudoWorkBase workspace base for the user who invoked sudo
 * @property {string} apiBase      installed Central API (another active revision = an upgrade)
 * @property {string} agentBase    installed Agent
 */
/**
 * Everything that touches processes, users, the network or the terminal (fakes in tests). Files: real fs, `paths`.
 * @typedef {object} Sys
 * @property {() => number} euid
 * @property {Readonly<Record<string, string | undefined>>} env
 * @property {(name: string) => UserInfo | null} user           passwd entry by name
 * @property {(path: string) => number | null} ownerOf          owner UID (lstat), null if missing
 * @property {(name: string) => string[]} groupsOf
 * @property {(argv: readonly string[], cwd: string) => RunResult} run   short command, output captured
 * @property {(argv: readonly string[], cwd: string, log: (text: string) => void, onLine: (line: string) => void) => Promise<number>} stream
 *   long command: every output line goes to `log`, `onLine` sees stdout+stderr lines; resolves with the exit code
 * @property {(a: readonly string[], b: readonly string[], cwd: string) => Promise<RunResult>} pipe   a.stdout → b.stdin
 * @property {(host: string, port: number, timeoutMs: number) => Promise<boolean>} tcp
 * @property {(url: string, timeoutMs: number) => Promise<boolean>} https
 * @property {(path: string) => number | null} freeBytes
 * @property {(question: string) => Promise<string | null>} ask  null = the operator ended the input (EOF, Ctrl+C/D)
 * @property {(text: string) => void} line
 * @property {(text: string) => void} error
 * @property {() => Date} now
 * @property {string} nodePath     the Node.js running this code (real path): the builder uses exactly this one
 * @property {string} nodeVersion
 * @property {() => boolean} interrupted   Ctrl+C reached this process (the children got it too)
 * @property {(argv: readonly string[]) => Promise<number>} handOver   ./install.sh --release … (the guided installer)
 */
/**
 * @typedef {object} Options
 * @property {string} checkout
 * @property {Component} component
 * @property {string} launcher           real path of install.sh
 * @property {boolean} runtimeInstalled  install.sh installed the runtime in this run (reported honestly on cancel)
 */
/** @typedef {{ name: string, home: string, workBase: string, create: boolean }} Builder */
/** @typedef {{ gitUser: string, builder: Builder }} Identity */

/** @type {Readonly<Paths>} */
export const PATHS = Object.freeze({
  store: '/var/lib/node-control-releases',
  logs: '/var/log/node-control-install',
  builderHome: '/var/lib/node-control-build',
  sudoWorkBase: '/var/tmp',
  apiBase: '/opt/node-control',
  agentBase: '/opt/node-control-agent',
});

export const BUILDER = 'nodecontrol-build';
const GIB = 1024 ** 3;
/** Free space a build needs in the workspace (dependencies + build output, measured with margin). @type {Readonly<Record<Component, number>>} */
export const NEEDED_BYTES = Object.freeze({ server: 2 * GIB, agent: GIB / 2 });
const NOLOGIN = new Set(['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']);
const ADMIN_GROUPS = new Set(['root', 'sudo', 'admin', 'wheel', 'adm']);
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, cancelled: 130 });

/** A reasoned refusal before any change. */
class Stop extends Error {}

/** @param {string} user @param {readonly string[]} argv */
const asUser = (user, argv) => (user === 'root' ? [...argv] : ['runuser', '-u', user, '--', ...argv]);
/** @param {string} sha */
const short = (sha) => sha.slice(0, 12);
/** @param {string} text */
const lastLine = (text) => (text.trim().split('\n').at(-1) ?? '').slice(0, 300);
/** Credentials in URLs (e.g. a proxy URL in an npm error) are never shown. @param {string} text */
export const redact = (text) => text.replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@');

/** @param {string} path */
function statOrNull(path) {
  try { return lstatSync(path); } catch { return null; }
}

/** The user who invoked sudo, when it is a real non-root account (SUDO_USER and SUDO_UID agree). @param {Sys} sys */
export function sudoUser(sys) {
  const name = sys.env.SUDO_USER;
  if (!name || !/^[a-z_][a-z0-9_-]*\$?$/.test(name)) return null;
  const user = sys.user(name);
  return user && user.uid !== 0 && String(user.uid) === sys.env.SUDO_UID ? user : null;
}

/** An existing builder account must be what this preparation would create; anything else is not ours to use.
 * @param {Sys} sys @param {Paths} paths @param {UserInfo} user @returns {string[]} */
export function builderProblems(sys, paths, user) {
  const problems = [];
  if (user.uid === 0 || user.gid === 0 || user.uid > 999) problems.push('не системний обліковий запис (UID 1–999, основна група не root)');
  if (!NOLOGIN.has(user.shell)) problems.push(`має shell ${user.shell}`);
  const admin = sys.groupsOf(user.name).filter((g) => ADMIN_GROUPS.has(g));
  if (admin.length > 0) problems.push(`входить до груп ${admin.join(', ')}`);
  if (user.home !== paths.builderHome) problems.push(`home ${user.home}, очікується ${paths.builderHome}`);
  else {
    const info = statOrNull(paths.builderHome);
    if (!info?.isDirectory() || info.uid !== user.uid || (info.mode & 0o077) !== 0) problems.push(`${paths.builderHome} має бути каталогом ${user.name} з правами 700`);
  }
  return problems;
}

/** Who reads the checkout (git) and who builds — never root for the build.
 * @param {Sys} sys @param {Paths} paths @param {string} checkout @returns {Identity} */
export function identify(sys, paths, checkout) {
  const owner = sys.ownerOf(checkout);
  const invoker = sudoUser(sys);
  let gitUser;
  if (owner === 0) gitUser = 'root';
  else if (invoker && owner === invoker.uid) gitUser = invoker.name;
  else throw new Stop(`checkout ${checkout} належить іншому користувачу (UID ${String(owner)}): запускайте ./install.sh від його власника через sudo або з checkout, що належить root`);
  if (invoker) return { gitUser, builder: { name: invoker.name, home: invoker.home, workBase: paths.sudoWorkBase, create: false } };
  const existing = sys.user(BUILDER);
  if (existing) {
    const problems = builderProblems(sys, paths, existing);
    if (problems.length > 0) throw new Stop(`обліковий запис ${BUILDER} уже існує, але ${problems.join('; ')} — інсталятор чужі облікові записи не використовує й не змінює`);
  }
  return { gitUser, builder: { name: BUILDER, home: paths.builderHome, workBase: paths.builderHome, create: existing === null } };
}

/** Minimal environment for every command run as another user: nothing of root's environment leaks into it.
 * @param {Sys} sys @param {string} home @param {Readonly<Record<string, string>>} [extra] @returns {string[]} */
export function cleanEnv(sys, home, extra = {}) {
  /** @type {Record<string, string>} */
  const vars = { HOME: home, PATH: `${dirname(sys.nodePath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', ...extra };
  for (const name of PROXY_VARS) { const v = sys.env[name]; if (v) vars[name] = v; }
  return ['env', '-i', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)];
}

/** build-release.js --check of the checkout, as the owner of the checkout: clean tree, commit in origin/main.
 * @param {Sys} sys @param {string} checkout @param {string} gitUser @param {string} home @returns {string} */
export function resolveRevision(sys, checkout, gitUser, home) {
  const tool = join(checkout, 'scripts', 'deploy', 'build-release.js');
  const r = sys.run(asUser(gitUser, [...cleanEnv(sys, home), sys.nodePath, tool, '--check']), checkout);
  const sha = /\[build-release\] revision=([0-9a-f]{40})/.exec(r.stdout)?.[1];
  if (r.code === 0 && sha) return sha;
  const why = r.stderr;
  if (/not clean/.test(why)) {
    const status = sys.run(asUser(gitUser, [...cleanEnv(sys, home), 'git', '-C', checkout, 'status', '--short']), checkout).stdout.trim().split('\n').slice(0, 15);
    throw new Stop(['у checkout є незакомічені або невідстежувані зміни — реліз збирається лише з закоміченої ревізії, а зміни інсталятор не чіпає (без commit, stash, reset чи pull):',
      ...status.map((l) => `    ${l}`), '  закомітьте й запуште їх, приберіть або зробіть окремий чистий clone, потім запустіть ./install.sh ще раз'].join('\n'));
  }
  if (/not contained in/.test(why)) {
    throw new Stop('поточний commit не міститься в origin/main: встановлюється лише код, що вже є у віддаленій гілці. Виконайте git fetch і перейдіть на commit з origin/main (git log origin/main) — інсталятор git pull не виконує');
  }
  throw new Stop(`не вдалося визначити ревізію (build-release.js --check): ${redact(lastLine(why)) || `код ${String(r.code)}`}`);
}

/** @param {string} path */
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Regular files under `dir` as relative paths; anything else (symlink, device…) is a problem. @param {string} dir @param {string} [rel] */
function walk(dir, rel = '') {
  /** @type {{ files: string[], problems: string[] }} */
  const out = { files: [], problems: [] };
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const info = lstatSync(join(dir, path));
    if (info.isDirectory()) { const sub = walk(dir, path); out.files.push(...sub.files); out.problems.push(...sub.problems); }
    else if (info.isFile()) out.files.push(path);
    else out.problems.push(`${path}: не звичайний файл`);
  }
  return out;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A release as the guided installer of `sha` will accept it: plain files only; BUNDLE.json of this revision listing
 * exactly the bundle files with matching SHA-256; the artifacts of the component with matching .sha256 files.
 * (The wizard of the release repeats its own complete verifyRelease before anything changes.)
 * @param {string} dir @param {string} sha @param {Component} component @returns {string[]} problems, [] = usable
 */
export function checkStored(dir, sha, component) {
  const tree = walk(dir);
  if (tree.problems.length > 0) return tree.problems;
  /** @type {unknown} */
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dir, 'server-bundle', 'BUNDLE.json'), 'utf8')); } catch { return ['server-bundle/BUNDLE.json відсутній або не JSON']; }
  if (!isObject(manifest) || manifest.revision !== sha || !isObject(manifest.files)) return [`server-bundle/BUNDLE.json не для ревізії ${short(sha)}`];
  const listed = manifest.files;
  const problems = [];
  const bundleFiles = tree.files.filter((f) => f.startsWith('server-bundle/') && f !== 'server-bundle/BUNDLE.json').map((f) => f.slice('server-bundle/'.length));
  for (const file of bundleFiles) {
    const want = listed[file];
    if (typeof want !== 'string') problems.push(`server-bundle/${file}: зайвий файл`);
    else if (sha256File(join(dir, 'server-bundle', file)) !== want) problems.push(`server-bundle/${file}: вміст змінено`);
  }
  for (const file of Object.keys(listed)) if (!bundleFiles.includes(file)) problems.push(`server-bundle/${file}: файл відсутній`);
  for (const kind of component === 'server' ? ['api', 'agent'] : ['agent']) {
    const name = `node-control-${kind}-${sha}.tar.gz`;
    if (!tree.files.includes(name) || !tree.files.includes(`${name}.sha256`)) { problems.push(`${name}: немає артефакту або .sha256`); continue; }
    if (readFileSync(join(dir, `${name}.sha256`), 'utf8') !== `${sha256File(join(dir, name))}  ${name}\n`) problems.push(`${name}: SHA-256 не збігається`);
  }
  const extra = tree.files.filter((f) => !f.startsWith('server-bundle/') && !/^node-control-(api|agent)-[0-9a-f]{40}\.tar\.gz(\.sha256)?$/.test(f));
  for (const f of extra) problems.push(`${f}: зайвий файл`);
  for (const f of tree.files) if (/^node-control-(api|agent)-/.test(f) && !f.includes(sha)) problems.push(`${f}: артефакт іншої ревізії`);
  return problems;
}

/** Root-owned (the current euid), not writable by others; created with missing parents when absent.
 * @param {string} path @param {number} mode */
function ensureRootDir(path, mode) {
  const info = statOrNull(path);
  if (!info) {
    mkdirSync(path, { recursive: true, mode });
    chmodSync(path, mode);
    return;
  }
  if (!info.isDirectory() || info.uid !== process.geteuid?.() || (info.mode & 0o022) !== 0) {
    throw new Stop(`${path} існує, але це не каталог root без запису для інших — інсталятор його не використовує`);
  }
}

/** @type {Readonly<Record<string, string>>} */
const STAGES = Object.freeze({
  'npm-ci': 'залежності з package-lock.json (npm ci)',
  'npm-ci-agent': 'typescript і @types/node з package-lock.json (npm ci)',
  'backend-build': 'збирання API',
  'frontend-build': 'збирання веб-інтерфейсу',
  'agent-build': 'збирання Agent',
  'installer-build': 'збирання інсталятора',
  package: 'артефакти й server-bundle',
});

/** Free space and network before an expensive build; PostgreSQL before building a Central Server.
 * @param {Sys} sys @param {Component} component @param {Builder} builder @returns {Promise<string[]>} */
async function prerequisites(sys, component, builder) {
  const errors = [];
  if (component === 'server' && !(await sys.tcp('127.0.0.1', 5432, 3000))) {
    errors.push('PostgreSQL не приймає з\'єднань на 127.0.0.1:5432 — БД готує оператор до встановлення (docs/INSTALLATION.md, «2.1 База даних»; інсталятор PostgreSQL не налаштовує)');
  }
  const base = statOrNull(builder.workBase) ? builder.workBase : dirname(builder.workBase);
  const free = sys.freeBytes(base);
  if (free !== null && free < NEEDED_BYTES[component]) {
    errors.push(`замало місця в ${base}: ${(free / GIB).toFixed(1)} ГіБ, для збирання потрібно щонайменше ${(NEEDED_BYTES[component] / GIB).toFixed(1)} ГіБ`);
  }
  if (PROXY_VARS.some((v) => sys.env[v])) sys.line('  ! задано HTTP(S)-проксі: доступ до registry.npmjs.org перевірить сам npm');
  else if (!(await sys.https('https://registry.npmjs.org/-/ping', 10_000))) {
    errors.push('немає HTTPS-доступу до registry.npmjs.org: збирання завантажує пакети npm за package-lock.json. Перевірте мережу/DNS або HTTPS_PROXY; без мережі — готовий реліз (docs/INSTALLATION.md, «Advanced: готовий реліз»)');
  }
  return errors;
}

/** @param {Sys} sys @param {Paths} paths @param {Options} o @param {string} sha @param {Identity} id @param {string} target @param {string[]} invalid */
function describe(sys, paths, o, sha, id, target, invalid) {
  const b = id.builder;
  const lines = [`\nПідготовка ${o.component === 'server' ? 'Central Server' : 'Agent'}: ревізія ${short(sha)} (закомічена, міститься в origin/main).`, 'Буде виконано:'];
  if (invalid.length > 0) lines.push(`  • наявний ${target} не пройшов перевірки (${invalid[0] ?? ''}) — його буде перейменовано на .invalid-… і зібрано заново`);
  if (b.create) lines.push(`  • системний користувач ${BUILDER} для збирання: без shell, без sudo, без доступу до секретів; home ${b.home} (700)`);
  lines.push(`  • збирання від користувача ${b.name} (не root), Node.js ${sys.nodeVersion} (${sys.nodePath}) — той самий для npm і всіх дочірніх процесів;`,
    `    тимчасовий робочий каталог у ${b.workBase} (видаляється після збирання); checkout не змінюється`);
  lines.push(o.component === 'server'
    ? '  • npm ci за package-lock.json (--ignore-scripts, --engine-strict; ~200 МБ з registry.npmjs.org), збирання API, веб-інтерфейсу, Agent та інсталятора'
    : '  • npm ci лише typescript і @types/node за package-lock.json (~25 МБ з registry.npmjs.org), збирання Agent та інсталятора — без веб-інтерфейсу й API');
  lines.push(`  • реліз копіюється від root у ${target} (каталог root 700) і перевіряється (BUNDLE.json, SHA-256 артефактів); неповний реліз не зберігається`,
    `  • повний журнал збирання — у ${paths.logs} (root, 600; без секретів)`,
    '  • далі — майстер встановлення: параметри → план (без змін) → «так» → встановлення → перевірка',
    'Системний Node.js, npm, PATH, PM2 і застосунки не змінюються.');
  return lines;
}

/** @param {Options} o @param {Sys} sys @param {Paths} [paths] @returns {Promise<number>} */
export async function prepare(o, sys, paths = { ...PATHS }) {
  const cancelled = () => {
    sys.line(o.runtimeInstalled
      ? '\nСкасовано. Крім щойно встановленого runtime (/opt/node-control-runtime) система не змінювалась.'
      : '\nСкасовано. Нічого не змінено.');
    return EXIT.cancelled;
  };
  if (sys.euid() !== 0) { sys.error('✗ підготовка виконується від root: запускайте ./install.sh (він сам перезапуститься через sudo)'); return EXIT.usage; }
  /** @type {Identity} */
  let id;
  /** @type {string} */
  let sha;
  try {
    id = identify(sys, paths, o.checkout);
    const gitHome = id.gitUser === 'root' ? '/root' : (sys.user(id.gitUser)?.home ?? '/');
    sys.line('\n— Перевірка —');
    sha = resolveRevision(sys, o.checkout, id.gitUser, gitHome);
    sys.line(`  ✓ ревізія ${short(sha)}: checkout чистий, commit міститься в origin/main`);
    const base = o.component === 'server' ? paths.apiBase : paths.agentBase;
    const link = statOrNull(join(base, 'current'))?.isSymbolicLink() ? readlinkSync(join(base, 'current')) : null;
    if (link !== null && basename(link) !== sha) {
      throw new Stop(`у ${base} уже активний інший реліз ${short(basename(link))}: це оновлення — штатна процедура docs/DEPLOYMENT.md; інсталятор релізи не перемикає`);
    }
  } catch (error) {
    if (error instanceof Stop) { sys.error(`✗ ${error.message}`); return EXIT.failed; }
    throw error;
  }

  const target = join(paths.store, `${sha}-${o.component}`);
  /** @type {string[]} */
  let invalid = [];
  if (statOrNull(target)) {
    invalid = checkStored(target, sha, o.component);
    if (invalid.length === 0) {
      sys.line(`  ✓ реліз ${short(sha)} уже підготовлено й перевірено: ${target} — повторне збирання не потрібне`);
      return sys.handOver([o.launcher, '--release', target, '--component', o.component]);
    }
  }
  const blockers = await prerequisites(sys, o.component, id.builder);
  if (blockers.length > 0) {
    for (const b of blockers) sys.error(`✗ ${b}`);
    sys.error('Нічого не збиралось і не змінювалось. Усуньте причину й запустіть ./install.sh ще раз.');
    return EXIT.failed;
  }
  for (const l of describe(sys, paths, o, sha, id, target, invalid)) sys.line(l);
  const answer = await sys.ask('\nПідготувати реліз? Введіть «так», щоб продовжити: ');
  if (answer === null || !['так', 'yes'].includes(answer.trim().toLowerCase())) return cancelled();

  return build(o, sys, paths, id, sha, target, invalid.length > 0);
}

/** @param {RunResult} r @param {string} what */
function must(r, what) {
  if (r.code !== 0) throw new Error(`${what}: ${lastLine(r.stderr) || `код ${String(r.code)}`}`);
  return r;
}

/** @param {Options} o @param {Sys} sys @param {Paths} paths @param {Identity} id @param {string} sha @param {string} target @param {boolean} replaceInvalid */
async function build(o, sys, paths, id, sha, target, replaceInvalid) {
  const b = id.builder;
  let stageTitle = 'підготовка каталогів';
  /** @type {string | null} */
  let ws = null;
  /** @type {string | null} */
  let staging = null;
  /** @type {number | null} */
  let logFd = null;
  let logPath = '';
  /** @param {string} text */
  const log = (text) => { if (logFd !== null) writeSync(logFd, text); };
  try {
    ensureRootDir(paths.store, 0o700);
    ensureRootDir(paths.logs, 0o700);
    const stamp = sys.now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    for (let n = 0; logFd === null; n++) { // never an existing file (exclusive create; a retry gets its own log)
      logPath = join(paths.logs, `build-${short(sha)}-${o.component}-${stamp}${n > 0 ? `-${String(n)}` : ''}.log`);
      try {
        logFd = openSync(logPath, 'wx', 0o600);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST' || n >= 99) throw error;
      }
    }
    sys.line(`\n— Підготовка (журнал: ${logPath}) —`);
    if (replaceInvalid) {
      const aside = `${target}.invalid-${stamp}`;
      renameSync(target, aside);
      sys.line(`  ✓ непридатний реліз перенесено: ${aside}`);
    }
    if (b.create) {
      stageTitle = `створення користувача ${BUILDER}`;
      must(sys.run(['useradd', '--system', '--user-group', '--home-dir', b.home, '--create-home', '--shell', '/usr/sbin/nologin', BUILDER], '/'), 'useradd');
      chmodSync(b.home, 0o700);
      const created = sys.user(BUILDER);
      const problems = created ? builderProblems(sys, paths, created) : ['не створено'];
      if (problems.length > 0) throw new Error(problems.join('; '));
      sys.line(`  ✓ користувач ${BUILDER} (без shell і sudo), ${b.home} 700`);
    }

    stageTitle = 'робочий каталог';
    const made = must(sys.run(asUser(b.name, ['mktemp', '-d', '-p', b.workBase, 'node-control-build.XXXXXXXX']), '/'), 'mktemp').stdout.trim();
    if (dirname(made) !== b.workBase || !/^node-control-build\.[A-Za-z0-9]{8}$/.test(basename(made))) throw new Error(`неочікуваний шлях: ${made}`);
    ws = made;
    must(sys.run(asUser(b.name, ['mkdir', join(ws, 'tmp')]), ws), 'mkdir');

    stageTitle = 'вихідний код ревізії (git archive)';
    const gitHome = id.gitUser === 'root' ? '/root' : (sys.user(id.gitUser)?.home ?? '/');
    must(await sys.pipe(asUser(id.gitUser, [...cleanEnv(sys, gitHome), 'git', '-C', o.checkout, 'archive', '--format=tar', '--prefix=src/', sha]),
      asUser(b.name, ['tar', '-xf', '-', '-C', ws]), ws), 'git archive | tar');
    sys.line(`  ✓ вихідний код ${short(sha)} передано збирачу ${b.name}`);

    const env = cleanEnv(sys, b.home, { TMPDIR: join(ws, 'tmp'), npm_config_cache: join(ws, 'npm-cache'), npm_config_update_notifier: 'false' });
    const argv = [...env, sys.nodePath, join(ws, 'src', 'scripts', 'deploy', 'build-release.js'), '--from-tree', join(ws, 'src'), '--revision', sha, '--out', join(ws, 'out'),
      ...(o.component === 'agent' ? ['--component', 'agent'] : [])];
    stageTitle = 'збирання';
    const started = Date.now();
    let current = '';
    const timer = setInterval(() => { sys.line(`    … триває: ${current || 'збирання'} (${String(Math.round((Date.now() - started) / 60_000))} хв)`); }, 60_000);
    let code;
    try {
      code = await sys.stream(asUser(b.name, argv), ws, log, (line) => {
        const m = /^\[build-release\] stage=([a-z-]+)$/.exec(line);
        if (m) { current = STAGES[m[1] ?? ''] ?? m[1] ?? ''; stageTitle = current; sys.line(`  … ${current}`); }
      });
    } finally {
      clearInterval(timer);
    }
    if (code !== 0) throw new Error(sys.interrupted() ? 'перервано (Ctrl+C)' : `build-release.js завершився з кодом ${String(code)}`);
    sys.line(`  ✓ зібрано за ${String(Math.round((Date.now() - started) / 1000))} с`);

    stageTitle = 'передача релізу root і перевірка';
    staging = join(paths.store, `.staging-${sha}-${o.component}-${String(process.pid)}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    const names = ['server-bundle', `node-control-agent-${sha}.tar.gz`, `node-control-agent-${sha}.tar.gz.sha256`,
      ...(o.component === 'server' ? [`node-control-api-${sha}.tar.gz`, `node-control-api-${sha}.tar.gz.sha256`] : [])];
    // The builder only produces a tar stream (it can read nothing it could not read anyway); root extracts it into a
    // directory the builder cannot reach. From here on the builder has no way to change this copy.
    must(await sys.pipe(asUser(b.name, ['tar', '-cf', '-', '-C', join(ws, 'out'), ...names]), ['tar', '-xf', '-', '-C', staging, '--no-same-owner', '--no-same-permissions'], ws), 'tar');
    const problems = checkStored(staging, sha, o.component);
    if (problems.length > 0) throw new Error(`зібраний реліз не пройшов перевірки: ${problems.slice(0, 3).join('; ')}`);
    renameSync(staging, target);
    staging = null;
    sys.line(`  ✓ реліз перевірено й збережено: ${target}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sys.error(sys.interrupted()
      ? `\n✗ Підготовку перервано (Ctrl+C) на етапі «${stageTitle}»`
      : `\n✗ Підготовка не вдалася на етапі «${stageTitle}»: ${redact(lastLine(message))}`);
    if (logPath && logFd !== null) {
      closeSync(logFd);
      logFd = null;
      const tail = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-20);
      if (tail.length > 0 && tail[0] !== '') sys.error(`Останні рядки журналу ${logPath}:\n${tail.map((l) => `  | ${redact(l).slice(0, 300)}`).join('\n')}`);
    }
    sys.error('Реліз не створено й нічого не активовано; системний Node.js, PM2 і застосунки не змінювались. Усуньте причину й запустіть ./install.sh ще раз — збирання почнеться заново.');
    return sys.interrupted() ? EXIT.cancelled : EXIT.failed;
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    if (ws) sys.run(asUser(b.name, ['rm', '-rf', '--', ws]), '/');
    if (logFd !== null) closeSync(logFd);
  }
  return sys.handOver([o.launcher, '--release', target, '--component', o.component]);
}
