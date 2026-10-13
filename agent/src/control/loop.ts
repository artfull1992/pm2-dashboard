import { abortableSleep, type AgentLogger } from '../agent.js';
import type { AgentConfig } from '../config.js';
import { type FetchLike, machinePost, type MachinePostOutcome } from '../heartbeat.js';
import { BrokerError, brokerRequest } from './client.js';
import {
  type BrokerTarget, CONTROL_ACTIONS, type ControlAction, type ExecuteResult, isIsoUtc, isTargetKey, isUuid,
} from './protocol.js';

// Agent control loop (ADR-017): bounded polling of the API for at most one command, delivery to the local broker,
// result report. Independent of the heartbeat and inventory loops. The Agent never executes anything itself.

export interface ControlCommand { id: string; attempt: number; targetKey: string; action: ControlAction; deadlineAt: string }
export interface PollReply { controlEnabled: boolean; commands: ControlCommand[]; intervalSeconds: number }

export const CONTROL_INTERVAL_BOUNDS = Object.freeze({ min: 5, max: 300 });
/** Covers PM2 call (≤ 60 s) + verification (10 s) + identity checks. */
export const EXECUTE_TIMEOUT_MS = 90_000;

export function parsePollReply(text: string): PollReply | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { controlEnabled, commands, intervalSeconds } = body as Record<string, unknown>;
  if (typeof controlEnabled !== 'boolean' || !Array.isArray(commands) || commands.length > 1) return null;
  if (typeof intervalSeconds !== 'number' || !Number.isSafeInteger(intervalSeconds) || intervalSeconds < CONTROL_INTERVAL_BOUNDS.min || intervalSeconds > CONTROL_INTERVAL_BOUNDS.max) return null;
  const parsed: ControlCommand[] = [];
  for (const c of commands as unknown[]) {
    if (typeof c !== 'object' || c === null) return null;
    const { id, attempt, targetKey, action, deadlineAt } = c as Record<string, unknown>;
    if (!isUuid(id) || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) return null;
    if (!isTargetKey(targetKey) || !(CONTROL_ACTIONS as readonly unknown[]).includes(action) || !isIsoUtc(deadlineAt)) return null;
    if (Object.keys(c).length !== 5) return null;
    parsed.push({ id, attempt, targetKey, action: action as ControlAction, deadlineAt });
  }
  return { controlEnabled, commands: parsed, intervalSeconds };
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

type BrokerState = { broker: 'ok' | 'unavailable'; daemon: 'ok' | 'unavailable' | null; allowlist: 'ok' | 'invalid' | null; targets: BrokerTarget[] };

async function readTargets(socket: string, broker: typeof brokerRequest): Promise<BrokerState> {
  try {
    const r = await broker(socket, { v: 1, op: 'list' }, 10_000);
    if (r.op !== 'list') return { broker: 'unavailable', daemon: null, allowlist: null, targets: [] };
    return { broker: 'ok', daemon: r.daemon, allowlist: r.allowlist, targets: r.targets };
  } catch {
    return { broker: 'unavailable', daemon: null, allowlist: null, targets: [] };
  }
}

/**
 * Delivers one command to the broker. Returns the result to report, or null when nothing must be reported:
 * a request that may have reached the broker without an answer is left to redelivery (the broker journal returns
 * the stored result) or, after the deadline, to the API's `unknown` — never guessed here.
 */
export async function deliver(socket: string, cmd: ControlCommand, broker: typeof brokerRequest): Promise<ExecuteResult | null> {
  try {
    const r = await broker(socket, { v: 1, op: 'execute', commandId: cmd.id, targetKey: cmd.targetKey, action: cmd.action, deadlineAt: cmd.deadlineAt }, EXECUTE_TIMEOUT_MS);
    return r.op === 'execute' ? r : null;
  } catch (error) {
    // Only the FIRST delivery that provably never reached the broker is reported as not executed.
    if (error instanceof BrokerError && !error.sent && cmd.attempt === 1) {
      return { v: 1, op: 'execute', commandId: cmd.id, outcome: 'rejected', reason: 'broker_unavailable', before: null, after: null };
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
  while (!signal.aborted) {
    attempts += 1;
    const state = await readTargets(control.socket, broker);
    const poll: MachinePostOutcome<PollReply> = await machinePost(config, '/api/agent/control/poll', { version: 1, ...state }, signal, parsePollReply, deps.fetchImpl);
    if (poll.kind === 'aborted') break;
    let delay: number;
    if (poll.kind === 'ok') {
      failures = 0;
      delay = poll.value.intervalSeconds;
      for (const cmd of poll.value.commands) {
        const result = await deliver(control.socket, cmd, broker);
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
