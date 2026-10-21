import type { AllowlistEntry } from './allowlist.js';
import { AllowlistError } from './allowlist.js';
import { autoTargetKey, fingerprintOf, identityOf, type Match, matchEntry, matchName, processNames, type RawProcessView, stateOf, viewOf } from './identity.js';
import type { Journal } from './journal.js';
import {
  type BrokerMode, type BrokerRequest, type BrokerTarget, CONTROL_ACTIONS, type ControlAction, type ExecuteResult, isProcessName, MAX_TARGETS_V2,
  type Outcome, type ProcessSnapshot, type Reason,
} from './protocol.js';
import { RpcError } from '../pm2/rpc.js';

// Broker command execution (ADR-017). Order of checks: journal (dedup) → deadline → target resolution (allowlist, or
// in auto mode the PM2 name behind the key) → identity → state → journal `started` → ONE PM2 call →
// post-verification → journal `completed`. Results carry only server-defined reasons and the process status; never
// PM2 error text, env, args or paths.
//
// Auto mode (ADR-028): every process of the registered PM2 owner is a target, keyed by its name; authorisation is the
// API's job (role + resource grant). The broker still refuses ambiguous names, cluster processes and a definition that
// changed since the API authorised the command (identity), and only speaks protocol version 2 — a version-1 request
// (old Agent, unaware of scoped authorisation) is refused as if no allowlist were valid (fail closed).

export type Pm2ActionMethod = 'startProcessId' | 'stopProcessId' | 'restartProcessId';

export interface ExecutorDeps {
  loadAllowlist: () => Promise<AllowlistEntry[]>;
  /** Raw getMonitorData of the EXISTING daemon; rejects with RpcError (daemon_not_running …) otherwise. */
  list: () => Promise<unknown[]>;
  /** One PM2 action call for a pm_id (bounded by the caller's timeout). */
  act: (method: Pm2ActionMethod, pmId: number) => Promise<void>;
  journal: Journal;
  /** Default 'allowlist'. */
  mode?: BrokerMode;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the expected state after the PM2 call (default 10 s). */
  verifyTimeoutMs?: number;
  /** Allowed log directories for the read-only log tail (ADR-018); none = no log can be read. */
  logDirs?: readonly string[];
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

export interface TargetList { mode: BrokerMode; daemon: 'ok' | 'unavailable'; allowlist: 'ok' | 'invalid'; targets: BrokerTarget[]; total: number }

const withIdentity = (t: Omit<BrokerTarget, 'identity'>, m: Match | null): BrokerTarget => ({ ...t, identity: m?.status === 'ok' ? identityOf(m.view) : null });

/**
 * Targets of the broker. Version 1 = the allowlist only (identity omitted); version 2 adds the mode, the identity and
 * the total count. In auto mode a version-1 caller gets nothing (allowlist 'invalid'): it cannot be told apart from an
 * old Agent talking to an API without scoped authorisation.
 */
export async function listTargets(deps: Pick<ExecutorDeps, 'loadAllowlist' | 'list' | 'mode'>, version: 1 | 2 = 1): Promise<TargetList> {
  const mode = deps.mode ?? 'allowlist';
  if (mode === 'auto') {
    if (version === 1) return { mode, daemon: 'ok', allowlist: 'invalid', targets: [], total: 0 };
    let raw: unknown[];
    try {
      raw = await deps.list();
    } catch {
      return { mode, daemon: 'unavailable', allowlist: 'ok', targets: [], total: 0 };
    }
    const all = processNames(raw, () => true);
    // Names the protocol cannot carry are counted in `total`, so the gap is visible rather than silent.
    const names = all.filter(isProcessName).slice(0, MAX_TARGETS_V2);
    const targets = names.map((name) => {
      const m = matchName(name, raw);
      return withIdentity({ targetKey: autoTargetKey(name), name, pmId: m.status === 'ok' ? m.view.pmId : null, actions: [...CONTROL_ACTIONS], matchStatus: m.status }, m);
    });
    return { mode, daemon: 'ok', allowlist: 'ok', targets, total: all.length };
  }
  let entries: AllowlistEntry[];
  try {
    entries = await deps.loadAllowlist();
  } catch {
    return { mode, daemon: 'ok', allowlist: 'invalid', targets: [], total: 0 };
  }
  let raw: unknown[] | null = null;
  try {
    raw = await deps.list();
  } catch {
    raw = null;
  }
  // Logs-only entries (no actions) are not control targets (ADR-018).
  const targets = entries.filter((e) => e.actions.length > 0).map((e): BrokerTarget => {
    const base = { targetKey: e.id, name: e.name, actions: e.actions };
    if (!raw) return version === 2 ? { ...base, pmId: null, matchStatus: 'daemon_unavailable', identity: null } : { ...base, pmId: null, matchStatus: 'daemon_unavailable' };
    const m = matchEntry(e, raw);
    const t = { ...base, pmId: m.status === 'ok' ? m.view.pmId : null, matchStatus: m.status };
    return version === 2 ? withIdentity(t, m) : t;
  });
  return { mode, daemon: raw ? 'ok' : 'unavailable', allowlist: 'ok', targets, total: targets.length };
}

type Resolved = { status: 'ok'; view: RawProcessView } | { status: 'rejected'; reason: Reason } | { status: 'daemon_unavailable' };

/** The process a command refers to, with every pre-action check of the mode; null result never acts. */
async function resolve(req: Extract<BrokerRequest, { op: 'execute' }>, deps: ExecutorDeps): Promise<Resolved> {
  const mode = deps.mode ?? 'allowlist';
  let entry: AllowlistEntry | null = null;
  if (mode === 'auto') {
    if (req.v !== 2) return { status: 'rejected', reason: 'allowlist_invalid' };
  } else {
    let entries: AllowlistEntry[];
    try {
      entries = await deps.loadAllowlist();
    } catch (error) {
      if (error instanceof AllowlistError) return { status: 'rejected', reason: 'allowlist_invalid' };
      throw error;
    }
    entry = entries.find((e) => e.id === req.targetKey) ?? null;
    if (!entry) return { status: 'rejected', reason: 'not_allowlisted' };
    if (!entry.actions.includes(req.action)) return { status: 'rejected', reason: 'action_not_allowed' };
  }
  let raw: unknown[];
  try {
    raw = await deps.list();
  } catch {
    return { status: 'daemon_unavailable' };
  }
  let match: Match;
  if (entry) {
    match = matchEntry(entry, raw);
  } else {
    const name = processNames(raw, isProcessName).find((n) => autoTargetKey(n) === req.targetKey);
    match = name === undefined ? { status: 'not_found' } : matchName(name, raw);
  }
  if (match.status !== 'ok') return { status: 'rejected', reason: match.status };
  // Version 2: the definition must still be the one the API authorised (auto mode: always required).
  if (req.v === 2 && (req.identity === null ? mode === 'auto' : req.identity !== identityOf(match.view))) return { status: 'rejected', reason: 'identity_changed' };
  return { status: 'ok', view: match.view };
}

export async function executeCommand(req: Extract<BrokerRequest, { op: 'execute' }>, deps: ExecutorDeps): Promise<ExecuteResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = { v: req.v, op: 'execute' as const, commandId: req.commandId };
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

  // 3–4. Target (allowlist entry, or the PM2 name behind the key in auto mode) and identity, on fresh daemon state.
  const resolved = await resolve(req, deps);
  if (resolved.status === 'daemon_unavailable') return complete(result('failed', 'daemon_unavailable'));
  if (resolved.status === 'rejected') return complete(result('rejected', resolved.reason));
  const view = resolved.view;
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
