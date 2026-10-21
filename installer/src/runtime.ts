import { dirname, join } from 'node:path';
import type { Preflight, Step } from './engine.js';
import type { Host } from './host.js';

// The Node.js runtime of Node Control (ADR-027). Every unit, release tool, migration and bootstrap call uses ONE
// absolute path, RUNTIME.node, never `node` from PATH and never the system /usr/bin/node directly:
//   /opt/node-control-runtime/bin/node → ../versions/node-v<ver>-linux-<arch>/bin/node   (downloaded by install.sh)
//                                      → /usr/bin/node                                  (a compatible system Node.js)
// The directory belongs to root and is writable only by root; the installers create the link to a compatible system
// Node.js when it is missing, and never switch or remove an existing runtime. The minimum is the lowest Node.js 22 the
// locked dependencies accept (installer/bootstrap/node-runtime.env, NODE_MIN — a test keeps both values equal).

export const RUNTIME = Object.freeze({
  dir: '/opt/node-control-runtime',
  bin: '/opt/node-control-runtime/bin',
  node: '/opt/node-control-runtime/bin/node',
  system: '/usr/bin/node',
  min: '22.22.0',
});

/** Node.js 22 not older than RUNTIME.min (another major is never accepted: Node Control targets Node.js 22 LTS). */
export function nodeVersionOk(text: string, min = RUNTIME.min): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(text);
  const want = /^(\d+)\.(\d+)\.(\d+)$/.exec(min);
  if (!m || !want) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (major !== Number(want[1])) return false;
  return minor !== Number(want[2]) ? minor > Number(want[2]) : patch >= Number(want[3]);
}

/** Most symlinks followed while resolving one path (Linux allows 40): a loop is refused, never followed forever. */
export const MAX_SYMLINKS = 40;

/**
 * Trust of an executable BEFORE it is ever run as root (the same rule as install.sh, executable_trusted). The path is
 * resolved component by component exactly as the kernel would, and EVERY component met on the way is checked — the
 * directories of the original path, each intermediate and final symlink, every component of each symlink target:
 *   - a directory: owned by root, not writable by group/other — except a root-owned sticky directory (like /tmp);
 *   - a symlink: owned by root (it lies in a directory checked above, so nobody else can replace it);
 *   - the final target: a root-owned regular file, executable, not writable by group/other.
 * Only lstat/readlink — nothing is executed, realpath is never used (it would hide the components before a link).
 * Returns the resolved file.
 */
export function executableTrust(host: Host, path: string): { real: string | null; problems: string[] } {
  if (!path.startsWith('/')) return { real: null, problems: [`${path}: потрібен абсолютний шлях`] };
  const dirProblem = (dir: string): string | null => {
    const info = host.stat(dir);
    if (!info || info.kind !== 'dir') return `${dir} не є каталогом`;
    if (info.uid !== 0) return `каталог ${dir} належить UID ${String(info.uid)}, не root`;
    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) return `каталог ${dir} доступний на запис групі/іншим`;
    return null;
  };
  const rootProblem = dirProblem('/');
  if (rootProblem) return { real: null, problems: [rootProblem] };
  let current = '/';
  let rest = path.split('/').filter((c) => c !== '');
  let links = 0;
  while (rest.length > 0) {
    const [component, ...tail] = rest;
    rest = tail;
    if (component === '.' || component === undefined) continue;
    if (component === '..') { current = dirname(current); continue; } // its parents were checked on the way here
    const next = current === '/' ? `/${component}` : `${current}/${component}`;
    const info = host.stat(next);
    if (!info) return { real: null, problems: [`${next} не існує (посилання нікуди не веде)`] };
    if (info.kind === 'symlink') {
      if (info.uid !== 0) return { real: null, problems: [`посилання ${next} належить UID ${String(info.uid)}, не root`] };
      if (++links > MAX_SYMLINKS) return { real: null, problems: [`${path}: забагато посилань (цикл?)`] };
      const target = host.readlink(next) ?? '';
      if (target.startsWith('/')) current = '/';
      rest = [...target.split('/').filter((c) => c !== ''), ...rest];
      continue;
    }
    if (info.kind === 'dir') {
      const problem = dirProblem(next);
      if (problem) return { real: null, problems: [problem] };
      current = next;
      continue;
    }
    if (rest.length > 0) return { real: null, problems: [`${next} не є каталогом`] };
    const problems: string[] = [];
    if (info.kind !== 'file') problems.push(`${next} не є звичайним файлом`);
    else {
      if (info.uid !== 0) problems.push(`${next} належить UID ${String(info.uid)}, не root`);
      if ((info.mode & 0o022) !== 0) problems.push(`${next} доступний на запис групі/іншим`);
      if ((info.mode & 0o100) === 0) problems.push(`${next} не виконуваний`);
    }
    return { real: next, problems };
  }
  return { real: null, problems: [`${path} веде до каталогу, а не до файлу`] };
}

/** Every entry of a runtime tree owned by root; nothing but symlinks writable by group/other. */
function treeProblems(host: Host, dir: string): string[] {
  const out: string[] = [];
  for (const name of host.list(dir)) {
    const path = join(dir, name);
    const info = host.stat(path);
    if (!info) continue;
    if (info.uid !== 0) out.push(`${path} належить UID ${String(info.uid)}`);
    else if (info.kind !== 'symlink' && (info.mode & 0o022) !== 0) out.push(`${path} доступний на запис групі/іншим`);
    if (info.kind === 'dir') out.push(...treeProblems(host, path));
    if (out.length >= 3) break;
  }
  return out;
}

const requirement = () => `потрібен Node.js 22 не старший за ${RUNTIME.min}`;

/**
 * The npm next to a trusted Node.js: itself trusted (checked before it runs), and running on exactly that Node.js
 * (`npm version --json` with its directory first in PATH). Returns the problem, or null when npm is usable.
 */
export function npmProblem(host: Host, real: string, version: string): string | null {
  const npm = join(dirname(real), 'npm');
  if (!host.stat(npm)) return `немає npm поруч із ${real}`;
  const trust = executableTrust(host, npm);
  if (trust.problems.length > 0) return `npm поруч із ${real} не довірений: ${trust.problems.slice(0, 2).join('; ')}`;
  const r = host.run(npm, ['version', '--json'], { env: { PATH: `${dirname(real)}:/usr/bin:/bin` } });
  let node: unknown;
  try { node = r.code === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>).node : undefined; } catch { node = undefined; }
  if (typeof node !== 'string') return `npm поруч із ${real} не працює`;
  if (`v${node}` !== version) return `npm поруч із ${real} працює на Node.js v${node}, а не ${version}`;
  return null;
}

/**
 * Read-only: which Node.js the installation will use. Trust is checked BEFORE anything runs (executableTrust; for an
 * existing runtime also its whole tree): an untrusted binary is never executed, not even for --version. An existing
 * RUNTIME.node must then be compatible; without it a compatible /usr/bin/node is linked by the runtime step. npm
 * (needed for the production dependencies of the API) must be trusted and run on the same Node.js.
 */
export function runtimePreflight(host: Host, p: Preflight, options: { npm: boolean }): void {
  // A runtime path that exists — or is a (possibly broken) symlink at any level — is checked and never bypassed for /usr/bin/node.
  const existing = host.stat(RUNTIME.node) !== null || [RUNTIME.node, RUNTIME.bin, RUNTIME.dir].some((p) => host.stat(p)?.kind === 'symlink');
  const candidate = existing ? RUNTIME.node : RUNTIME.system;
  if (!existing && !host.stat(RUNTIME.system)) {
    p.errors.push(`немає сумісного Node.js: ${RUNTIME.node} відсутній, ${RUNTIME.system} — немає (${requirement()}). `
      + './install.sh встановить окремий runtime, не змінюючи системний (docs/INSTALLATION.md, «Runtime Node.js»)');
    return;
  }
  const trust = executableTrust(host, candidate);
  // The whole runtime directory, whatever the link points to: the services keep using its lexical path.
  const problems = [...trust.problems, ...(existing && host.stat(RUNTIME.dir)?.kind === 'dir' ? treeProblems(host, RUNTIME.dir) : [])];
  if (problems.length > 0 || !trust.real) {
    p.errors.push(`${candidate} не виконується: ${problems.slice(0, 3).join('; ')} — Node.js має належати root і бути доступним на запис лише root (разом із каталогами); інсталятор його не запускає й не змінює`);
    return;
  }
  const real = trust.real;
  const r = host.run(candidate, ['--version']);
  const version = r.code === 0 ? r.stdout.trim() : '';
  if (!nodeVersionOk(version)) {
    p.errors.push(existing
      ? `${RUNTIME.node} — Node.js ${version || 'не запускається'}: ${requirement()}. Наявний runtime інсталятор не замінює (docs/INSTALLATION.md, «Runtime Node.js»)`
      : `немає сумісного Node.js: ${RUNTIME.node} відсутній, ${RUNTIME.system} — ${version || 'не запускається'} (${requirement()}). ./install.sh встановить окремий runtime, не змінюючи системний (docs/INSTALLATION.md, «Runtime Node.js»)`);
    return;
  }
  p.notes.push(existing
    ? `Node.js ${version} (${RUNTIME.node} → ${real})`
    : `Node.js ${version} (${RUNTIME.system}): буде створено посилання ${RUNTIME.node} → ${RUNTIME.system}; системний Node.js не змінюється`);
  if (options.npm) {
    const problem = npmProblem(host, real, version);
    if (problem) {
      p.errors.push(`${problem} (потрібен для залежностей API). ${existing
        ? 'Наявний runtime інсталятор не замінює (docs/DEPLOYMENT.md, «Runtime Node.js»)'
        : 'sudo ./install.sh --release <реліз> --component server запропонує окремий runtime Node Control із npm; системний Node.js не змінюється'}`);
    }
  }
}

/** The link RUNTIME.node → /usr/bin/node when no runtime exists yet (a downloaded runtime already has its link). */
export function runtimeStep(): Step {
  return {
    id: 'runtime:node',
    title: `Node.js для служб (${RUNTIME.node})`,
    check({ host }) {
      if (host.stat(RUNTIME.node)) return { state: 'done', detail: `→ ${host.realpath(RUNTIME.node) ?? '?'}` };
      for (const dir of [RUNTIME.dir, RUNTIME.bin]) {
        const info = host.stat(dir);
        if (info && (info.kind !== 'dir' || info.uid !== 0 || (info.mode & 0o022) !== 0)) {
          return { state: 'conflict', detail: `${dir} існує, але це не каталог root без запису для інших`, fix: `з'ясуйте походження ${dir}; інсталятор його не змінює` };
        }
      }
      return { state: 'pending', detail: `посилання → ${RUNTIME.system} (каталоги root 755; системний Node.js не змінюється)` };
    },
    apply({ host }) {
      for (const dir of [RUNTIME.dir, RUNTIME.bin]) if (!host.stat(dir)) host.mkdir(dir, { mode: 0o755, uid: 0, gid: 0 });
      host.symlink(RUNTIME.system, RUNTIME.node);
    },
    recovery: `перевірте ls -l ${RUNTIME.bin}; повторний запуск створить посилання, якщо його немає`,
  };
}
