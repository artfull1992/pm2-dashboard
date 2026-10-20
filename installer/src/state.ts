import type { Preflight } from './engine.js';
import type { Host } from './host.js';

// Durable record of service actions that a change made necessary but that have not been confirmed yet
// (daemon-reload, restart of a service). It survives a failed step, Ctrl+C or a crash, so the next apply finishes
// them; a completed, unchanged re-run finds it empty and restarts nothing.
//
// Protocol: (1) before a step changes anything, its effects are written here (intent first — a crash between the
// intent and the change costs at most one unnecessary reload/restart, never a missed one); (2) the change; (3) the
// reload/restart; (4) only after it succeeded the effect is removed. A crash between (3) and (4) repeats (3) once.
// Contents: effect names only — never values, paths of secrets or tokens. `plan` reads it, never writes it.

export const STATE_DIR = '/var/lib/node-control-install';

export interface PendingStore { readonly effects: ReadonlySet<string>; persist(effects: ReadonlySet<string>): void }

export function statePath(name: 'server' | 'agent'): string {
  return `${STATE_DIR}/${name}.json`;
}

const recovery = (file: string) =>
  `перевірте ${file} вручну (не видаляйте наосліп): якщо в ньому є незавершені дії — виконайте їх (systemctl daemon-reload; systemctl restart <служба>), потім збережіть копію файлу й видаліть його`;

/** Reads and validates the state (root-owned 700 dir, root-owned 600 regular file, known effects). Problems → preflight errors. */
export function loadPending(host: Host, name: 'server' | 'agent', known: readonly string[], p: Preflight): PendingStore {
  const file = statePath(name);
  const effects = new Set<string>();
  const dir = host.stat(STATE_DIR);
  if (dir) {
    if (dir.kind !== 'dir') p.errors.push(`${STATE_DIR} не є каталогом — інсталятор не пише в чужий шлях`);
    else if (dir.uid !== 0 || (dir.mode & 0o077) !== 0) p.errors.push(`${STATE_DIR} має належати root із правами 700 (stat ${STATE_DIR})`);
    const info = host.stat(file);
    if (info) {
      if (info.kind !== 'file') p.errors.push(`${file} не є звичайним файлом — ${recovery(file)}`);
      else if (info.uid !== 0 || (info.mode & 0o077) !== 0) p.errors.push(`${file} має належати root із правами 600 — ${recovery(file)}`);
      else {
        try {
          const data = JSON.parse(host.readFile(file)) as unknown;
          const pending = typeof data === 'object' && data !== null && 'version' in data && data.version === 1 && 'pending' in data ? data.pending : null;
          if (!Array.isArray(pending) || !pending.every((e): e is string => typeof e === 'string' && known.includes(e))) throw new Error('format');
          for (const e of pending) effects.add(e);
          if (effects.size > 0) p.notes.push(`незавершені дії попереднього запуску: ${[...effects].sort().join(', ')} — буде виконано в apply`);
        } catch {
          p.errors.push(`стан ${file} пошкоджений або нового формату — ${recovery(file)}`);
        }
      }
    }
  }
  return {
    effects,
    persist(next) {
      if (!host.stat(STATE_DIR)) host.mkdir(STATE_DIR, { mode: 0o700, uid: 0, gid: 0 });
      const pending = [...next].filter((e) => known.includes(e)).sort();
      host.writeFileAtomic(file, `${JSON.stringify({ version: 1, pending })}\n`, { mode: 0o600, uid: 0, gid: 0 });
    },
  };
}
