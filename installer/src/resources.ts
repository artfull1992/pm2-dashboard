import { dirname } from 'node:path';
import { confirmEffect, type Context, mustRun, type Step, type StepState, systemctlState } from './engine.js';
import type { Host } from './host.js';

// Reusable steps for host resources. Each one only ever creates what is missing; anything that exists but differs
// from the deployment contract is a conflict that the operator resolves (nothing foreign is changed or removed).

const SYSTEM_UID_MAX = 999;
const NOLOGIN = new Set(['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']);
const octal = (mode: number) => mode.toString(8).padStart(4, '0');

const rootIdentity = (name: string) => `обліковий запис ${name} має UID 0 або основну групу root — служба працювала б із правами root`;
const ROOT_FIX = 'інсталятор чужі облікові записи не змінює: з\'ясуйте, хто й навіщо створив цей запис; встановлення можливе лише з окремим системним користувачем без прав root';

/** Before any change: an existing service account must not be root in disguise (UID 0 or primary group root). */
export function serviceAccountPreflight(host: Host, name: string, p: { errors: string[] }): void {
  const user = host.user(name);
  if (user && (user.uid === 0 || user.gid === 0)) p.errors.push(`${rootIdentity(name)}. ${ROOT_FIX}`);
}

/** System user with its own group, no home, no shell (useradd --system --user-group). */
export function systemUser(name: string): Step {
  return {
    id: `user:${name}`,
    title: `системний користувач ${name}`,
    check({ host }) {
      const user = host.user(name);
      if (!user) {
        return host.group(name)
          ? { state: 'conflict', detail: `група ${name} існує, а користувача немає`, fix: `з'ясуйте походження групи ${name}; інсталятор її не змінює` }
          : { state: 'pending', detail: 'useradd --system --user-group, без home і shell' };
      }
      if (user.uid === 0 || user.gid === 0) return { state: 'conflict', detail: rootIdentity(name), fix: ROOT_FIX };
      if (user.uid > SYSTEM_UID_MAX || !NOLOGIN.has(user.shell)) {
        return { state: 'conflict', detail: `${name} існує, але це не системний обліковий запис без shell`, fix: `використайте окремий сервер або видаліть/перейменуйте чужого користувача ${name} самостійно` };
      }
      return { state: 'done' };
    },
    apply({ host }) {
      mustRun(host, 'useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', name], `useradd ${name}`);
    },
    recovery: `перевірте журнал (journalctl -t useradd) і повторіть; частково створеного користувача можна побачити командою id ${name}`,
  };
}

export function systemGroup(name: string): Step {
  return {
    id: `group:${name}`,
    title: `системна група ${name}`,
    check: ({ host }) => (host.group(name) ? { state: 'done' } : { state: 'pending', detail: 'groupadd --system' }),
    apply({ host }) { mustRun(host, 'groupadd', ['--system', name], `groupadd ${name}`); },
    recovery: `перевірте getent group ${name} і повторіть`,
  };
}

export function membership(user: string, group: string, effects: readonly string[]): Step {
  return {
    id: `member:${user}:${group}`,
    title: `${user} у групі ${group}`,
    check({ host }) {
      if (host.groupsOf(user).includes(group)) return { state: 'done' };
      return { state: 'pending', detail: 'usermod -aG (діє після перезапуску служби)' };
    },
    apply({ host }) { mustRun(host, 'usermod', ['-aG', group, user], `usermod -aG ${group} ${user}`); },
    effects,
    recovery: `перевірте id -nG ${user} і повторіть`,
  };
}

export interface OwnerSpec { mode: number; user: string; group: string }

function ownerIds(host: Host, spec: OwnerSpec): { uid: number; gid: number } | null {
  const uid = spec.user === 'root' ? 0 : host.user(spec.user)?.uid;
  const gid = spec.group === 'root' ? 0 : host.group(spec.group)?.gid;
  return uid === undefined || gid === undefined ? null : { uid, gid };
}

function ownerMatches(host: Host, path: string, spec: OwnerSpec): StepState | null {
  const info = host.stat(path);
  if (!info) return null;
  const ids = ownerIds(host, spec);
  if (!ids || info.uid !== ids.uid || info.gid !== ids.gid || info.mode !== spec.mode) {
    return { state: 'conflict', detail: `${path} існує з іншими власником/правами (очікується ${spec.user}:${spec.group} ${octal(spec.mode)})`, fix: `перевірте stat ${path}; якщо це рештки попередньої спроби — виправте власника/права вручну, якщо чуже — встановлення сюди неможливе` };
  }
  return { state: 'done' };
}

/** A directory with exact owner and mode. An existing one is accepted only if it already matches. */
export function directory(path: string, spec: OwnerSpec, options: { acceptExisting?: (host: Host) => StepState | null } = {}): Step {
  return {
    id: `dir:${path}`,
    title: `каталог ${path}`,
    check({ host }) {
      const info = host.stat(path);
      if (!info) {
        if (!host.stat(dirname(path))) return { state: 'pending', detail: `буде створено (${spec.user}:${spec.group} ${octal(spec.mode)}) після батьківського каталогу` };
        return { state: 'pending', detail: `${spec.user}:${spec.group} ${octal(spec.mode)}` };
      }
      if (info.kind !== 'dir') return { state: 'conflict', detail: `${path} існує і це не каталог`, fix: `приберіть або перейменуйте ${path} самостійно` };
      return options.acceptExisting?.(host) ?? ownerMatches(host, path, spec) ?? { state: 'done' };
    },
    apply({ host }) {
      const ids = ownerIds(host, spec);
      if (!ids) throw new Error(`немає користувача/групи ${spec.user}:${spec.group}`);
      host.mkdir(path, { mode: spec.mode, ...ids });
    },
    recovery: `перевірте stat ${dirname(path)}; повторний запуск продовжить`,
  };
}

/** A file created once with the given content. Existing: identical → done; different → conflict (never overwritten). */
export function exactFile(path: string, content: (host: Host) => string | null, spec: OwnerSpec, what: string, effects: readonly string[] = []): Step {
  return {
    id: `file:${path}`,
    title: what,
    check({ host }) {
      const info = host.stat(path);
      const wanted = content(host);
      if (!info) return { state: 'pending', detail: `${path} (${spec.user}:${spec.group} ${octal(spec.mode)})` };
      if (info.kind !== 'file') return { state: 'conflict', detail: `${path} існує і це не звичайний файл`, fix: `приберіть ${path} самостійно` };
      if (wanted !== null && host.readFile(path) !== wanted) {
        return { state: 'conflict', detail: `${path} уже існує з іншим вмістом — інсталятор його не перезаписує`, fix: `порівняйте вміст із очікуваним (docs/INSTALLATION.md); якщо файл застарілий — збережіть копію й видаліть його, потім повторіть` };
      }
      return ownerMatches(host, path, spec) ?? { state: 'done' };
    },
    apply({ host }) {
      const wanted = content(host);
      const ids = ownerIds(host, spec);
      if (wanted === null || !ids) throw new Error('немає даних для створення файлу');
      host.writeFileAtomic(path, wanted, { mode: spec.mode, ...ids });
    },
    effects,
    recovery: `перевірте каталог ${dirname(path)} і повторіть`,
  };
}

export const DAEMON_RELOAD = 'daemon-reload';

/**
 * Installs a unit file from the active/prepared release (root:root 644), verified by systemd-analyze BEFORE it is
 * written, then daemon-reload. The reload is a durable effect: if it fails (or the run is interrupted) after the file
 * was written, the next run sees the identical file AND the pending reload, and reloads before anything starts.
 * An existing different unit is a conflict: upgrades of units follow DEPLOYMENT.
 */
export function unitFile(name: string, source: () => string, effects: readonly string[] = []): Step {
  const target = `/etc/systemd/system/${name}`;
  return {
    id: `unit:${name}`,
    title: `systemd unit ${name}`,
    check(ctx) {
      const { host } = ctx;
      const info = host.stat(target);
      const src = source();
      if (!info) return { state: 'pending', detail: host.stat(src) ? `з релізу (${src}) + daemon-reload` : 'з релізу після його підготовки + daemon-reload' };
      if (info.kind !== 'file') return { state: 'conflict', detail: `${target} не є звичайним файлом`, fix: `перевірте ${target} самостійно` };
      if (host.stat(src) && host.readFile(target) !== host.readFile(src)) {
        return { state: 'conflict', detail: `${target} відрізняється від unit у релізі (інша версія або ручні зміни)`, fix: `порівняйте: diff ${src} ${target}; оновлення units — за docs/DEPLOYMENT.md, інсталятор їх не перезаписує` };
      }
      if (ctx.effects.has(DAEMON_RELOAD)) return { state: 'pending', detail: 'systemctl daemon-reload (не завершено попереднім запуском)' };
      return host.stat(src) ? { state: 'done' } : { state: 'done', detail: 'unit уже встановлено; реліз для порівняння ще не підготовлено' };
    },
    apply(ctx) {
      const { host } = ctx;
      if (!host.stat(target)) {
        const src = source();
        mustRun(host, 'systemd-analyze', ['verify', src], `systemd-analyze verify ${name}`);
        host.writeFileAtomic(target, host.readFile(src), { mode: 0o644, uid: 0, gid: 0 });
      }
      mustRun(host, 'systemctl', ['daemon-reload'], 'systemctl daemon-reload');
      confirmEffect(ctx, DAEMON_RELOAD);
    },
    effects: [DAEMON_RELOAD, ...effects],
    recovery: `перевірте вивід systemd-analyze verify ${source()}; встановлений файл можна прибрати (rm ${target}; systemctl daemon-reload) і повторити`,
  };
}

/** enable + start; restart instead of start when an earlier step changed something this service reads. */
export function service(unit: string, options: { restartOn?: string; title?: string; enable?: boolean } = {}): Step {
  const enable = options.enable ?? true;
  const needsRestart = (ctx: Context) => options.restartOn !== undefined && ctx.effects.has(options.restartOn);
  return {
    id: `service:${unit}`,
    title: options.title ?? `служба ${unit}`,
    check(ctx) {
      const enabled = systemctlState(ctx.host, 'is-enabled', unit) === 'enabled';
      const active = systemctlState(ctx.host, 'is-active', unit) === 'active';
      if ((enabled || !enable) && active && !needsRestart(ctx)) return { state: 'done', detail: 'активна' };
      const todo = [enable && !enabled ? 'enable' : null, active ? (needsRestart(ctx) ? 'restart (змінено конфігурацію)' : null) : 'start'].filter((x) => x !== null);
      return { state: 'pending', detail: todo.join(' + ') };
    },
    apply(ctx) {
      const { host } = ctx;
      if (enable && systemctlState(host, 'is-enabled', unit) !== 'enabled') mustRun(host, 'systemctl', ['enable', unit], `systemctl enable ${unit}`);
      const active = systemctlState(host, 'is-active', unit) === 'active';
      mustRun(host, 'systemctl', [active ? 'restart' : 'start', unit], `systemctl ${active ? 'restart' : 'start'} ${unit}`);
      // Only now is the change applied by the running process: the pending restart is cleared durably.
      if (options.restartOn) confirmEffect(ctx, options.restartOn);
    },
    recovery: `systemctl status ${unit}; journalctl -u ${unit} -n 50 -o cat — причина в журналі; після виправлення повторіть`,
  };
}
