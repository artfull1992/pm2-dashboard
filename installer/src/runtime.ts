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

function versionOf(host: Host, node: string): string {
  if (!host.stat(node)) return '';
  const r = host.run(node, ['--version']);
  return r.code === 0 ? r.stdout.trim() : '';
}

const requirement = () => `потрібен Node.js 22 не старший за ${RUNTIME.min}`;

/**
 * Read-only: which Node.js the installation will use. An existing RUNTIME.node must be compatible and root-only
 * writable; without it a compatible /usr/bin/node is linked by the runtime step. npm must lie next to the real binary
 * (the API release installs its production dependencies with it).
 */
export function runtimePreflight(host: Host, p: Preflight, options: { npm: boolean }): void {
  let real: string | null;
  if (host.stat(RUNTIME.node)) {
    real = host.realpath(RUNTIME.node);
    const version = versionOf(host, RUNTIME.node);
    const info = real ? host.stat(real) : null;
    const dir = host.stat(RUNTIME.dir);
    if (!real || !info || info.uid !== 0 || (info.mode & 0o022) !== 0 || !dir || dir.uid !== 0 || (dir.mode & 0o022) !== 0) {
      p.errors.push(`${RUNTIME.node} має належати root і бути доступним на запис лише root (stat ${RUNTIME.dir}; ${real ?? 'посилання нікуди не веде'}) — інсталятор runtime не змінює`);
      return;
    }
    if (!nodeVersionOk(version)) {
      p.errors.push(`${RUNTIME.node} — Node.js ${version || 'не запускається'}: ${requirement()}. Наявний runtime інсталятор не замінює (docs/INSTALLATION.md, «Runtime Node.js»)`);
      return;
    }
    p.notes.push(`Node.js ${version} (${RUNTIME.node} → ${real})`);
  } else {
    const version = versionOf(host, RUNTIME.system);
    if (!nodeVersionOk(version)) {
      p.errors.push(`немає сумісного Node.js: ${RUNTIME.node} відсутній, ${RUNTIME.system} — ${version || 'немає'} (${requirement()}). `
        + './install.sh завантажить окремий runtime, не змінюючи системний (docs/INSTALLATION.md, «Runtime Node.js»)');
      return;
    }
    real = host.realpath(RUNTIME.system) ?? RUNTIME.system;
    p.notes.push(`Node.js ${version} (${RUNTIME.system}): буде створено посилання ${RUNTIME.node} → ${RUNTIME.system}; системний Node.js не змінюється`);
  }
  if (options.npm && !host.stat(join(dirname(real), 'npm'))) {
    p.errors.push(`немає npm поруч із ${real} (потрібен для залежностей API): для системного Node.js — apt install npm; або видаліть посилання ${RUNTIME.node} лише якщо воно ваше й запустіть ./install.sh`);
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
