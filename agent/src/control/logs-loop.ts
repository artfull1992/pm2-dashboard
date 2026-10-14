import { abortableSleep, type AgentLogger } from '../agent.js';
import type { AgentConfig } from '../config.js';
import { type FetchLike, machinePost } from '../heartbeat.js';
import { BrokerError, brokerCall } from './client.js';
import {
  LOG_LIMITS, type LogsRequest, type LogsResponse, type LogTarget, type LogTargetsRequest, type LogTargetsResponse, parseLogsResponse,
} from './logs-protocol.js';

// Agent log loop (ADR-018): an outbound long-poll to the API for log-tail requests, served by the local broker.
// Independent of heartbeat, inventory and control. The Agent never touches PM2 or files itself; the text it relays
// is never logged.

export interface LogPollRequest { requestId: string; targetKey: string; lines: number; deadlineAt: string }
export const LOG_POLL_TIMEOUT_MS = 35_000;
export const MAX_REQUESTS_PER_POLL = 4;
/** Lower bound between two empty polls: a misbehaving API (no long-poll hold) can never cause a busy loop. */
export const MIN_EMPTY_POLL_INTERVAL_MS = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseLogPollReply(text: string): { requests: LogPollRequest[] } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { requests } = body as Record<string, unknown>;
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS_PER_POLL || Object.keys(body).length !== 1) return null;
  const out: LogPollRequest[] = [];
  for (const r of requests as unknown[]) {
    if (typeof r !== 'object' || r === null || Object.keys(r).length !== 4) return null;
    const { requestId, targetKey, lines, deadlineAt } = r as Record<string, unknown>;
    if (typeof requestId !== 'string' || !UUID_RE.test(requestId) || typeof targetKey !== 'string' || !TARGET_KEY_RE.test(targetKey)) return null;
    if (typeof lines !== 'number' || !Number.isSafeInteger(lines) || lines < 1 || lines > LOG_LIMITS.maxLines) return null;
    if (typeof deadlineAt !== 'string' || !ISO_RE.test(deadlineAt) || !Number.isFinite(Date.parse(deadlineAt))) return null;
    out.push({ requestId, targetKey, lines, deadlineAt });
  }
  return { requests: out };
}

export function parseLogResultReply(text: string): { status: 'recorded' } | null {
  try {
    return (JSON.parse(text) as { status?: unknown } | null)?.status === 'recorded' ? { status: 'recorded' } : null;
  } catch {
    return null;
  }
}

type BrokerState = 'ok' | 'unavailable' | 'unsupported';

export interface LogsLoopDeps {
  fetchImpl?: FetchLike;
  call?: typeof brokerCall;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  logger: AgentLogger;
}

/** An old broker drops the connection on an unknown operation: connected but no answer → unsupported. */
function stateOf(error: unknown): BrokerState {
  return error instanceof BrokerError && !error.sent ? 'unavailable' : 'unsupported';
}

export async function runLogs(config: AgentConfig, signal: AbortSignal, deps: LogsLoopDeps): Promise<number> {
  const control = config.control;
  if (!control) return 0;
  const call = deps.call ?? brokerCall;
  const sleep = deps.sleep ?? abortableSleep;
  const random = deps.random ?? Math.random;
  let failures = 0;
  let polls = 0;
  let last = '';
  while (!signal.aborted) {
    polls += 1;
    let broker: BrokerState = 'ok';
    let targets: LogTarget[] = [];
    let daemon: 'ok' | 'unavailable' | null = null;
    let allowlist: 'ok' | 'invalid' | null = null;
    const targetsReq: LogTargetsRequest = { v: 1, op: 'logTargets' };
    try {
      const r = await call(control.socket, targetsReq, 10_000, (v) => parseLogsResponse(v, targetsReq)) as LogTargetsResponse;
      ({ targets, daemon, allowlist } = r);
    } catch (error) {
      broker = stateOf(error);
    }
    const startedAt = Date.now();
    const poll = await machinePost(config, '/api/agent/logs/poll', { version: 1, broker, daemon, allowlist, targets }, signal, parseLogPollReply, deps.fetchImpl, LOG_POLL_TIMEOUT_MS);
    if (poll.kind === 'aborted') break;
    let delay = 0;
    if (poll.kind === 'ok') {
      failures = 0;
      if (poll.value.requests.length === 0) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_EMPTY_POLL_INTERVAL_MS) await sleep(MIN_EMPTY_POLL_INTERVAL_MS - elapsed, signal);
      }
      for (const r of poll.value.requests) {
        const result = await serve(r, broker);
        await machinePost(config, '/api/agent/logs/result', { version: 1, ...withoutEnvelope(result) }, signal, parseLogResultReply, deps.fetchImpl);
      }
    } else {
      failures += 1;
      const max = config.maxBackoffSeconds;
      delay = poll.kind === 'not_found' || poll.kind === 'unauthorized'
        ? max
        : Math.max(1, Math.round(Math.min(max, 5 * 2 ** Math.min(failures, 10)) * (0.5 + random() * 0.5)));
    }
    // Metadata only (never targets' names beyond counts, never log text).
    const summary = `${poll.kind}|${broker}|${String(targets.length)}`;
    if (summary !== last) {
      const event = { msg: 'logs poll', outcome: poll.kind, broker, targets: targets.length, nextInSeconds: delay, consecutiveFailures: failures };
      if (poll.kind === 'ok') deps.logger.info(event);
      else deps.logger.warn(event);
    }
    last = summary;
    if (delay > 0) await sleep(delay * 1000, signal);
  }
  return polls;

  async function serve(r: LogPollRequest, broker: BrokerState): Promise<LogsResponse> {
    const failed = (reason: 'broker_unavailable' | 'broker_unsupported' | 'timeout'): LogsResponse =>
      ({ v: 1, op: 'logs', requestId: r.requestId, outcome: 'failed', reason, readAt: new Date().toISOString(), stdout: null, stderr: null });
    if (broker !== 'ok' || !control) return failed(broker === 'unsupported' ? 'broker_unsupported' : 'broker_unavailable');
    const req: LogsRequest = { v: 1, op: 'logs', requestId: r.requestId, targetKey: r.targetKey, lines: r.lines, deadlineAt: r.deadlineAt };
    try {
      return await call(control.socket, req, LOG_LIMITS.readTimeoutMs + 3_000, (v) => parseLogsResponse(v, req)) as LogsResponse;
    } catch (error) {
      return failed(error instanceof BrokerError && error.kind === 'timeout' ? 'timeout' : stateOf(error) === 'unavailable' ? 'broker_unavailable' : 'broker_unsupported');
    }
  }
}

function withoutEnvelope(r: LogsResponse) {
  return { requestId: r.requestId, outcome: r.outcome, reason: r.reason, readAt: r.readAt, stdout: r.stdout, stderr: r.stderr };
}
