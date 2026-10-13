import type { AllowlistEntry } from './allowlist.js';
import { AllowlistError } from './allowlist.js';
import { fingerprintOf, matchEntry, type RawProcessView, stateOf, viewOf } from './identity.js';
import type { Journal } from './journal.js';
import type { BrokerRequest, BrokerTarget, ControlAction, ExecuteResult, Outcome, ProcessSnapshot, Reason } from './protocol.js';
import { RpcError } from '../pm2/rpc.js';

// Broker command execution (ADR-017). Order of checks: journal (dedup) → deadline → allowlist → identity → state
// → journal `started` → ONE PM2 call → post-verification → journal `completed`. Results carry only server-defined
// reasons and the process status; never PM2 error text, env, args or paths.

export type Pm2ActionMethod = 'startProcessId' | 'stopProcessId' | 'restartProcessId';

export interface ExecutorDeps {
  loadAllowlist: () => Promise<AllowlistEntry[]>;
  /** Raw getMonitorData of the EXISTING daemon; rejects with RpcError (daemon_not_running …) otherwise. */
  list: () => Promise<unknown[]>;
  /** One PM2 action call for a pm_id (bounded by the caller's timeout). */
  act: (method: Pm2ActionMethod, pmId: number) => Promise<void>;
  journal: Journal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the expected state after the PM2 call (default 10 s). */
  verifyTimeoutMs?: number;
}

/** Commands must not claim a deadline further away than this (protects against a bogus far-future deadline). */
export const MAX_DEADLINE_AHEAD_MS = 15 * 60_000;

const METHOD: Record<ControlAction, Pm2ActionMethod> = { start: 'startProcessId', stop: 'stopProcessId', restart: 'restartProcessId' };
/** States from which an action is accepted (start only for an existing, not running process). */
const ALLOWED_FROM: Record<ControlAction, readonly string[]> = {
  start: ['stopped', 'errored'],
  stop: ['online', 'launching', 'errored'],
  restart: ['online', 'errored', 'stopped'],
};

const snapshot = (view: RawProcessView | null): ProcessSnapshot | null => (view ? { status: stateOf(view).status } : null);

export async function listTargets(deps: Pick<ExecutorDeps, 'loadAllowlist' | 'list'>): Promise<{ daemon: 'ok' | 'unavailable'; allowlist: 'ok' | 'invalid'; targets: BrokerTarget[] }> {
  let entries: AllowlistEntry[];
  try {
    entries = await deps.loadAllowlist();
  } catch {
    return { daemon: 'ok', allowlist: 'invalid', targets: [] };
  }
  let raw: unknown[] | null = null;
  try {
    raw = await deps.list();
  } catch {
    raw = null;
  }
  const targets = entries.map((e): BrokerTarget => {
    if (!raw) return { targetKey: e.id, name: e.name, pmId: null, actions: e.actions, matchStatus: 'daemon_unavailable' };
    const m = matchEntry(e, raw);
    return { targetKey: e.id, name: e.name, pmId: m.status === 'ok' ? m.view.pmId : null, actions: e.actions, matchStatus: m.status };
  });
  return { daemon: raw ? 'ok' : 'unavailable', allowlist: 'ok', targets };
}

export async function executeCommand(req: Extract<BrokerRequest, { op: 'execute' }>, deps: ExecutorDeps): Promise<ExecuteResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = { v: 1 as const, op: 'execute' as const, commandId: req.commandId };
  const result = (outcome: Outcome, reason: Reason | null, before: ProcessSnapshot | null = null, after: ProcessSnapshot | null = null): ExecuteResult =>
    ({ ...base, outcome, reason, before, after });
  const complete = async (r: ExecuteResult) => {
    await deps.journal.put({ commandId: req.commandId, targetKey: req.targetKey, action: req.action, state: 'completed', at: new Date(now()).toISOString(), result: r });
    return r;
  };

  // 1. Deduplication: a known command is never executed again.
  const known = await deps.journal.get(req.commandId);
  if (known) {
    if (known.targetKey !== req.targetKey || known.action !== req.action) return result('rejected', 'command_conflict');
    if (known.state === 'completed' && known.result) return known.result;
    // Started but never completed: the broker stopped during the action. The effect is unknown — do not retry.
    return complete(result('unknown', 'interrupted'));
  }

  // 2. Deadline (never act late; a far-future deadline is not believable).
  const deadline = Date.parse(req.deadlineAt);
  if (now() > deadline) return complete(result('expired', 'deadline_passed'));
  if (deadline - now() > MAX_DEADLINE_AHEAD_MS) return complete(result('rejected', 'invalid_deadline'));

  // 3. Local allowlist (root-owned; any problem → refuse).
  let entries: AllowlistEntry[];
  try {
    entries = await deps.loadAllowlist();
  } catch (error) {
    if (error instanceof AllowlistError) return complete(result('rejected', 'allowlist_invalid'));
    throw error;
  }
  const entry = entries.find((e) => e.id === req.targetKey);
  if (!entry) return complete(result('rejected', 'not_allowlisted'));
  if (!entry.actions.includes(req.action)) return complete(result('rejected', 'action_not_allowed'));

  // 4. Identity right before the action (fresh daemon state).
  let raw: unknown[];
  try {
    raw = await deps.list();
  } catch {
    return complete(result('failed', 'daemon_unavailable'));
  }
  const match = matchEntry(entry, raw);
  if (match.status !== 'ok') return complete(result('rejected', match.status));
  const view = match.view;
  const before = stateOf(view);
  if (!ALLOWED_FROM[req.action].includes(before.status)) return complete(result('rejected', 'invalid_state', snapshot(view)));
  if (now() > deadline) return complete(result('expired', 'deadline_passed', snapshot(view)));

  // 5. Persist "started" BEFORE touching PM2, then exactly one PM2 call.
  await deps.journal.put({ commandId: req.commandId, targetKey: req.targetKey, action: req.action, state: 'started', at: new Date(now()).toISOString(), result: null });
  try {
    await deps.act(METHOD[req.action], view.pmId);
  } catch (error) {
    const reason = error instanceof RpcError ? error.reason : 'protocol_error';
    // Connection refused/missing socket: the request never reached PM2.
    if (reason === 'daemon_not_running') return complete(result('failed', 'daemon_unavailable', snapshot(view)));
    // PM2 answered with an error: it refused the action (state is reported as observed afterwards).
    if (reason === 'pm2_error') return complete(result('failed', 'pm2_error', snapshot(view), await observe()));
    // Timeout / broken connection after sending: PM2 may still be acting.
    return complete(result('unknown', 'timeout', snapshot(view), await observe()));
  }

  // 6. Post-verification: same pm_id, same definition, expected state.
  const fingerprint = fingerprintOf(view);
  const deadlineVerify = now() + (deps.verifyTimeoutMs ?? 10_000);
  for (;;) {
    let current: RawProcessView | null;
    try {
      current = (await deps.list()).map(viewOf).find((v) => v?.pmId === view.pmId) ?? null;
    } catch {
      return complete(result('unknown', 'daemon_unavailable', snapshot(view)));
    }
    if (!current || current.name !== view.name || fingerprintOf(current) !== fingerprint) {
      return complete(result('unknown', 'identity_changed', snapshot(view), null));
    }
    const after = stateOf(current);
    const reached = req.action === 'stop'
      ? after.status === 'stopped'
      : after.status === 'online' && (req.action !== 'restart' || before.status !== 'online'
        || (after.restarts !== null && before.restarts !== null && after.restarts > before.restarts)
        || (after.startedAt !== null && after.startedAt !== before.startedAt));
    if (reached) return complete(result('succeeded', null, snapshot(view), { status: after.status }));
    if (now() >= deadlineVerify) return complete(result('failed', 'verification_failed', snapshot(view), { status: after.status }));
    await sleep(250);
  }

  async function observe(): Promise<ProcessSnapshot | null> {
    try {
      const current = (await deps.list()).map(viewOf).find((v) => v?.pmId === view.pmId) ?? null;
      return current && fingerprintOf(current) === fingerprintOf(view) ? { status: stateOf(current).status } : null;
    } catch {
      return null;
    }
  }
}
