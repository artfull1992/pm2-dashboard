import { abortableSleep, type AgentLogger } from '../agent.js';
import type { AgentConfig } from '../config.js';
import { type FetchLike, machinePost, type MachinePostOutcome } from '../heartbeat.js';
import { BrokerError, brokerRequest } from './client.js';
import {
  type BrokerMode, type BrokerTarget, CONTROL_ACTIONS, type ControlAction, type ExecuteResult, isIdentity, isIsoUtc, isTargetKey, isUuid, MAX_TARGETS,
} from './protocol.js';

// Agent control loop (ADR-017): bounded polling of the API for at most one command, delivery to the local broker,
// result report. Independent of the heartbeat and inventory loops. The Agent never executes anything itself.
//
// Version negotiation (ADR-028), always towards fail closed:
// - broker: version 2 is asked first; an old broker drops the unknown request → version 1 (allowlist) is used.
// - API: a version-2 broker is reported with version 2. An old API rejects it (400): an ALLOWLIST broker then falls back
//   to version 1 (the root-owned allowlist still bounds what can be done); an AUTO broker never does — an API without
//   scoped authorisation would let every operator act on every process — and no command is taken until the API is
//   updated. A version-2 reply from the API must declare accessModel 'scoped' for an auto broker to act.

export interface ControlCommand {
  id: string; attempt: number; targetKey: string; action: ControlAction; deadlineAt: string;
  /** Version 2: the definition identity the API authorised (null: none known). */
  identity?: string | null;
}
export interface PollReply { controlEnabled: boolean; commands: ControlCommand[]; intervalSeconds: number; accessModel?: 'scoped' }

export const CONTROL_INTERVAL_BOUNDS = Object.freeze({ min: 5, max: 300 });
/** Covers PM2 call (≤ 60 s) + verification (10 s) + identity checks. */
export const EXECUTE_TIMEOUT_MS = 90_000;

export function parsePollReply(text: string): PollReply | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { controlEnabled, commands, intervalSeconds, accessModel } = body as Record<string, unknown>;
  if (typeof controlEnabled !== 'boolean' || !Array.isArray(commands) || commands.length > 1) return null;
  if (accessModel !== undefined && accessModel !== 'scoped') return null;
  if (typeof intervalSeconds !== 'number' || !Number.isSafeInteger(intervalSeconds) || intervalSeconds < CONTROL_INTERVAL_BOUNDS.min || intervalSeconds > CONTROL_INTERVAL_BOUNDS.max) return null;
  const parsed: ControlCommand[] = [];
  for (const c of commands as unknown[]) {
    if (typeof c !== 'object' || c === null) return null;
    const { id, attempt, targetKey, action, deadlineAt, identity } = c as Record<string, unknown>;
    if (!isUuid(id) || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) return null;
    if (!isTargetKey(targetKey) || !(CONTROL_ACTIONS as readonly unknown[]).includes(action) || !isIsoUtc(deadlineAt)) return null;
    const withIdentity = Object.hasOwn(c, 'identity');
    if (Object.keys(c).length !== (withIdentity ? 6 : 5)) return null;
    if (withIdentity && !(identity === null || isIdentity(identity))) return null;
    parsed.push({ id, attempt, targetKey, action: action as ControlAction, deadlineAt, ...(withIdentity ? { identity: identity as string | null } : {}) });
  }
  return { controlEnabled, commands: parsed, intervalSeconds, ...(accessModel === 'scoped' ? { accessModel } : {}) };
}

export function parseResultReply(text: string): { status: 'recorded' | 'duplicate' } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  const status = (body as { status?: unknown } | null)?.status;
  return status === 'recorded' || status === 'duplicate' ? { status } : null;
}

export interface ControlLoopDeps {
  fetchImpl?: FetchLike;
  broker?: typeof brokerRequest;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger: AgentLogger;
}

export type BrokerState = {
  broker: 'ok' | 'unavailable'; daemon: 'ok' | 'unavailable' | null; allowlist: 'ok' | 'invalid' | null; targets: BrokerTarget[];
  /** Protocol the broker speaks (null: unreachable); mode/total only from a version-2 broker. */
  version: 1 | 2 | null; mode: BrokerMode | null; total: number | null;
};

const UNAVAILABLE: BrokerState = { broker: 'unavailable', daemon: null, allowlist: null, targets: [], version: null, mode: null, total: null };

export async function readTargets(socket: string, broker: typeof brokerRequest): Promise<BrokerState> {
  try {
    const r = await broker(socket, { v: 2, op: 'list' }, 10_000);
    if (r.op !== 'list') return UNAVAILABLE;
    return { broker: 'ok', daemon: r.daemon, allowlist: r.allowlist, targets: r.targets, version: 2, mode: r.mode ?? 'allowlist', total: r.total ?? r.targets.length };
  } catch (error) {
    // Not reachable at all: nothing more to try. Reached but no valid v2 answer: an older (version-1) broker.
    if (error instanceof BrokerError && !error.sent) return UNAVAILABLE;
  }
  try {
    const r = await broker(socket, { v: 1, op: 'list' }, 10_000);
    if (r.op !== 'list') return UNAVAILABLE;
    return { broker: 'ok', daemon: r.daemon, allowlist: r.allowlist, targets: r.targets, version: 1, mode: 'allowlist', total: r.targets.length };
  } catch {
    return UNAVAILABLE;
  }
}

/** API report: version 2 with mode/identity/total, or the version-1 subset (identity stripped, ≤ 50 targets). */
export function controlReport(state: BrokerState, version: 1 | 2): Record<string, unknown> {
  const common = { broker: state.broker, daemon: state.daemon, allowlist: state.allowlist };
  if (version === 2) {
    return { version: 2, mode: state.mode, ...common, targets: state.targets.map((t) => ({ ...t, identity: t.identity ?? null })), total: state.total ?? state.targets.length };
  }
  return { version: 1, ...common, targets: state.targets.slice(0, MAX_TARGETS).map(({ targetKey, name, pmId, actions, matchStatus }) => ({ targetKey, name, pmId, actions, matchStatus })) };
}

/**
 * Delivers one command to the broker. Returns the result to report, or null when nothing must be reported:
 * a request that may have reached the broker without an answer is left to redelivery (the broker journal returns
 * the stored result) or, after the deadline, to the API's `unknown` — never guessed here.
 */
export async function deliver(socket: string, cmd: ControlCommand, broker: typeof brokerRequest, version: 1 | 2 = 1): Promise<ExecuteResult | null> {
  const base = { commandId: cmd.id, targetKey: cmd.targetKey, action: cmd.action, deadlineAt: cmd.deadlineAt };
  try {
    const r = await broker(socket, version === 2 ? { v: 2, op: 'execute', ...base, identity: cmd.identity ?? null } : { v: 1, op: 'execute', ...base }, EXECUTE_TIMEOUT_MS);
    return r.op === 'execute' ? r : null;
  } catch (error) {
    // Only the FIRST delivery that provably never reached the broker is reported as not executed.
    if (error instanceof BrokerError && !error.sent && cmd.attempt === 1) {
      return { v: version, op: 'execute', commandId: cmd.id, outcome: 'rejected', reason: 'broker_unavailable', before: null, after: null };
    }
    return null;
  }
}

export async function runControl(config: AgentConfig, signal: AbortSignal, deps: ControlLoopDeps): Promise<number> {
  const control = config.control;
  if (!control) return 0;
  const broker = deps.broker ?? brokerRequest;
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? Math.random;
  let failures = 0;
  let attempts = 0;
  let last = '';
  /** Polls left on version 1 after an API rejected version 2 (an allowlist broker only); then version 2 is retried. */
  let v1Polls = 0;
  let lastMode: BrokerMode | null = null;
  while (!signal.aborted) {
    attempts += 1;
    const state = await readTargets(control.socket, broker);
    if (state.mode) lastMode = state.mode;
    // An unreachable broker that was auto before is still treated as auto (no fallback while it restarts).
    const auto = lastMode === 'auto';
    if (state.version === 2 && state.total !== null && state.total > state.targets.length) {
      deps.logger.warn({ msg: 'control targets cut', reported: state.targets.length, total: state.total });
    }
    let version: 1 | 2 = state.version === 1 || (v1Polls > 0 && !auto) ? 1 : 2;
    let poll: MachinePostOutcome<PollReply> = await machinePost(config, '/api/agent/control/poll', controlReport(state, version), signal, parsePollReply, deps.fetchImpl);
    if (poll.kind === 'rejected' && version === 2) {
      if (auto) {
        deps.logger.warn({ msg: 'control refused: the API does not support scoped access (auto broker needs it)', action: 'update the API' });
      } else {
        v1Polls = 30;
        version = 1;
        poll = await machinePost(config, '/api/agent/control/poll', controlReport(state, 1), signal, parsePollReply, deps.fetchImpl);
      }
    } else if (version === 1 && v1Polls > 0) {
      v1Polls -= 1;
    }
    if (poll.kind === 'aborted') break;
    let delay: number;
    if (poll.kind === 'ok') {
      failures = 0;
      delay = poll.value.intervalSeconds;
      // An auto broker acts only for an API that authorises every command per user and service.
      const commands = auto && (version !== 2 || poll.value.accessModel !== 'scoped') ? [] : poll.value.commands;
      if (commands.length < poll.value.commands.length) deps.logger.warn({ msg: 'control command ignored: API without scoped access', commands: poll.value.commands.length });
      for (const cmd of commands) {
        const result = await deliver(control.socket, cmd, broker, state.version === 2 ? 2 : 1);
        deps.logger.info({ msg: 'control command', commandId: cmd.id, attempt: cmd.attempt, action: cmd.action, outcome: result?.outcome ?? 'not_reported', reason: result?.reason ?? null });
        if (result) await report(cmd, result);
      }
    } else {
      failures += 1;
      const max = config.maxBackoffSeconds;
      delay = poll.kind === 'not_found' || poll.kind === 'unauthorized'
        ? max
        : Math.max(1, Math.round(Math.min(max, 10 * 2 ** Math.min(failures, 10)) * (0.5 + random() * 0.5)));
    }
    const summary = `${poll.kind}|${state.broker}|${String(state.targets.length)}`;
    if (summary !== last || poll.kind !== 'ok') {
      const event = { msg: 'control poll', outcome: poll.kind, broker: state.broker, targets: state.targets.length, nextInSeconds: delay, consecutiveFailures: failures };
      if (poll.kind === 'ok') deps.logger.info(event);
      else deps.logger.warn(event);
    }
    last = summary;
    await sleep(delay * 1000, signal);
  }
  return attempts;

  async function report(cmd: ControlCommand, result: ExecuteResult): Promise<void> {
    const payload = { version: 1, commandId: cmd.id, attempt: cmd.attempt, outcome: result.outcome, reason: result.reason, before: result.before, after: result.after };
    // Only the acknowledgement is retried; the action itself is never repeated (the broker journal holds the result).
    for (let i = 0; i < 3 && !signal.aborted; i++) {
      const r = await machinePost(config, '/api/agent/control/result', payload, signal, parseResultReply, deps.fetchImpl);
      if (r.kind === 'ok' || r.kind === 'rejected' || r.kind === 'not_found' || r.kind === 'unauthorized' || r.kind === 'aborted') {
        if (r.kind !== 'ok' && r.kind !== 'aborted') deps.logger.warn({ msg: 'control result not accepted', commandId: cmd.id, outcome: r.kind });
        return;
      }
      await sleep(2000 * 2 ** i, signal);
    }
    deps.logger.warn({ msg: 'control result pending redelivery', commandId: cmd.id });
  }
}
