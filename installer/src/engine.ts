import type { Host } from './host.js';

// A run is: preflight (read-only; any error → stop before the first change) → steps in a fixed order → verification.
// Every step first inspects the machine: "done" (nothing to do — this is what makes a repeated run safe), "pending"
// (what it will change) or "conflict" (something that is not ours or not as expected: never overwritten). `plan`
// only inspects; `apply` performs pending steps one by one and stops at the first failure, saying what was already
// changed and how to continue. There is no transaction across steps: a re-run picks up from the failed step.

export type Mode = 'plan' | 'apply';
export type StepState =
  | { state: 'done'; detail?: string }
  | { state: 'pending'; detail: string }
  | { state: 'conflict'; detail: string; fix: string };

export interface Context {
  host: Host;
  mode: Mode;
  /** Effects of steps that changed (apply) or would change (plan) something, e.g. "restart-api". */
  readonly effects: Set<string>;
  readonly out: Reporter;
}

export interface Step {
  id: string;
  title: string;
  /** Read-only inspection. May throw (e.g. a probe failed): treated like a failure of the step. */
  check(ctx: Context): StepState | Promise<StepState>;
  apply(ctx: Context): void | Promise<void>;
  /** Effects recorded when this step changes something. */
  effects?: readonly string[];
  /** What the operator does if apply fails (the step itself is safe to retry unless said otherwise). */
  recovery: string;
}

export interface Reporter { line(text: string): void; error(text: string): void }
export const consoleReporter: Reporter = { line: (t) => { process.stdout.write(`${t}\n`); }, error: (t) => { process.stderr.write(`${t}\n`); } };

export interface Preflight { errors: string[]; warnings: string[]; notes: string[] }

/** Error text without anything that could be a value: first line, bounded. */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] ?? '').slice(0, 300);
}

export interface RunResult { ok: boolean; changed: string[]; failedStep: string | null }

export async function runSteps(ctx: Context, steps: readonly Step[]): Promise<RunResult> {
  const { out } = ctx;
  const changed: string[] = [];
  const plan = ctx.mode === 'plan';
  out.line(plan ? '\nПлан (нічого не змінюється):' : '\nВиконання:');
  for (const [index, step] of steps.entries()) {
    const n = `${String(index + 1)}/${String(steps.length)}`;
    let state: StepState;
    try {
      state = await step.check(ctx);
    } catch (error) {
      out.error(`  ✗ [${n}] ${step.title}: перевірка не вдалася — ${safeMessage(error)}`);
      out.error(`    Що робити: ${step.recovery}`);
      return { ok: false, changed, failedStep: step.id };
    }
    if (state.state === 'done') {
      out.line(`  ✓ [${n}] ${step.title}: вже виконано${state.detail ? ` (${state.detail})` : ''}`);
      continue;
    }
    if (state.state === 'conflict') {
      out.error(`  ✗ [${n}] ${step.title}: конфлікт — ${state.detail}`);
      out.error(`    Що робити: ${state.fix}`);
      if (!plan) reportStop(out, changed);
      return { ok: false, changed, failedStep: step.id };
    }
    for (const e of step.effects ?? []) ctx.effects.add(e);
    if (plan) {
      out.line(`  • [${n}] ${step.title}: буде виконано — ${state.detail}`);
      continue;
    }
    out.line(`  → [${n}] ${step.title}: ${state.detail}`);
    try {
      await step.apply(ctx);
      const after = await step.check(ctx);
      if (after.state !== 'done') throw new Error(`після виконання стан не підтверджено (${after.state === 'conflict' ? after.detail : after.detail})`);
    } catch (error) {
      out.error(`  ✗ [${n}] ${step.title}: не вдалося — ${safeMessage(error)}`);
      out.error(`    Що робити: ${step.recovery}`);
      reportStop(out, changed);
      return { ok: false, changed, failedStep: step.id };
    }
    changed.push(step.title);
    out.line(`  ✓ [${n}] ${step.title}: виконано`);
  }
  return { ok: true, changed, failedStep: null };
}

function reportStop(out: Reporter, changed: readonly string[]): void {
  out.error(changed.length === 0 ? '\nЗупинено. У цьому запуску нічого не змінено.' : `\nЗупинено. У цьому запуску змінено: ${changed.join('; ')}.`);
  out.error('Встановлення НЕ завершене. Після усунення причини запустіть ту саму команду apply ще раз — виконані кроки буде пропущено.');
}

export function reportPreflight(out: Reporter, p: Preflight): boolean {
  out.line('Перевірки перед змінами:');
  for (const n of p.notes) out.line(`  ✓ ${n}`);
  for (const w of p.warnings) out.line(`  ! ${w}`);
  for (const e of p.errors) out.error(`  ✗ ${e}`);
  if (p.errors.length > 0) out.error('\nЗупинено до будь-яких змін: виправте помилки вище й повторіть.');
  return p.errors.length === 0;
}

// --- shared step helpers -------------------------------------------------------------------------------------------

/** systemctl query (is-active / is-enabled) → its single-word answer. Read-only. */
export function systemctlState(host: Host, verb: 'is-active' | 'is-enabled', unit: string): string {
  return host.run('systemctl', [verb, unit]).stdout.trim();
}

export function mustRun(host: Host, command: string, args: readonly string[], what: string, options: { input?: string; interactive?: boolean } = {}): string {
  const r = host.run(command, args, options);
  if (r.code !== 0) {
    const reason = (r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 300);
    throw new Error(`${what}: код ${String(r.code)}${reason ? ` — ${reason}` : ''}`);
  }
  return r.stdout;
}
