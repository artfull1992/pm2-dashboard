import { type Context, type Mode, type Preflight, type Reporter, reportPreflight, runSteps, safeMessage, type Step } from './engine.js';
import type { Host } from './host.js';
import { InputError } from './validate.js';

// Shared CLI plumbing: exit codes, platform checks every installer needs, and the run sequence.
//   0 — done (apply) / plan without blockers;  1 — stopped: preflight error, conflict, failed step or failed check;
//   2 — invalid arguments (nothing inspected or changed).

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

/** Ubuntu with systemd, root, /usr/bin/node 22 and the given system commands. */
export function platformPreflight(host: Host, p: Preflight, commands: readonly string[]): void {
  if (host.euid() !== 0) p.errors.push('потрібен root (sudo -i або sudo node …)');
  const osRelease = host.stat('/etc/os-release') ? host.readFile('/etc/os-release') : '';
  const id = /^ID=("?)([a-z]+)\1$/m.exec(osRelease)?.[2];
  const version = /^VERSION_ID="?([0-9.]+)"?$/m.exec(osRelease)?.[1] ?? '?';
  if (id !== 'ubuntu') p.errors.push(`підтримується лише Ubuntu (виявлено: ${id ?? 'невідомо'})`);
  else p.notes.push(`ОС: Ubuntu ${version}`);
  if (host.stat('/run/systemd/system')?.kind !== 'dir') p.errors.push('systemd не є init-системою (немає /run/systemd/system)');
  const node = host.stat('/usr/bin/node') ? host.run('/usr/bin/node', ['--version']).stdout.trim() : '';
  if (!/^v22\./.test(node)) p.errors.push(`потрібен Node.js 22 у /usr/bin/node (виявлено: ${node || 'немає'})`);
  else p.notes.push(`Node.js ${node} (/usr/bin/node)`);
  const missing = commands.filter((c) => !['/usr/sbin', '/usr/bin', '/sbin', '/bin'].some((d) => host.stat(`${d}/${c}`)));
  if (missing.length > 0) p.errors.push(`не знайдено системних утиліт: ${missing.join(', ')}`);
}

export function usage(text: string, out: Reporter): number {
  out.line(text);
  return EXIT.ok;
}

export interface Plan { preflight: Preflight; steps: Step[]; verify?: (ctx: Context) => Promise<boolean>; next?: string[] }

/** preflight → steps → (apply) verification → next steps. Never prints secrets: only titles, states and key names. */
export async function execute(host: Host, mode: Mode, out: Reporter, build: () => Promise<Plan> | Plan): Promise<number> {
  let plan: Plan;
  try {
    plan = await build();
  } catch (error) {
    out.error(`✗ ${safeMessage(error)}`);
    return error instanceof InputError ? EXIT.usage : EXIT.failed;
  }
  if (!reportPreflight(out, plan.preflight)) return EXIT.failed;
  const ctx: Context = { host, mode, effects: new Set(), out };
  const result = await runSteps(ctx, plan.steps);
  if (!result.ok) return EXIT.failed;
  if (mode === 'plan') {
    out.line('\nПлан без блокувальних проблем. Нічого не змінено. Для виконання — та сама команда з apply.');
    return EXIT.ok;
  }
  out.line(result.changed.length === 0 ? '\nУсі кроки вже були виконані раніше — нічого не змінено.' : `\nЗмінено: ${String(result.changed.length)} крок(ів).`);
  if (plan.verify && !(await plan.verify(ctx))) {
    out.error('\nВстановлення НЕ підтверджене: див. перевірки вище. Зміни лишаються на місці; після виправлення повторіть apply.');
    return EXIT.failed;
  }
  for (const n of plan.next ?? []) out.line(n);
  return EXIT.ok;
}
