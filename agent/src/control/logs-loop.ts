import { abortableSleep, type AgentLogger } from '../agent.js';
import type { AgentConfig } from '../config.js';
import { type FetchLike, machinePost } from '../heartbeat.js';
import { BrokerError, brokerCall } from './client.js';
import { MAX_RESPONSE_BYTES_V2 } from './protocol.js';
import {
  type BrokerMode, LOG_LIMITS, MAX_LOG_TARGETS_V1, type LogsRequest, type LogsResponse, type LogTarget, type LogTargetsRequest, type LogTargetsResponse, parseLogsResponse,
} from './logs-protocol.js';

// Agent log loop (ADR-018): an outbound long-poll to the API for log-tail requests, served by the local broker.
// Independent of heartbeat, inventory and control. The Agent never touches PM2 or files itself; the text it relays
// is never logged. Version negotiation as in loop.ts (ADR-028): an AUTO broker is never reported to an API that does
// not answer version 2 with accessModel 'scoped' — an older API would let any logs:read user read every process.

/** `name`/`identity` (API protocol v2): what the target must still be when the broker reads it. */
export interface LogPollRequest { requestId: string; targetKey: string; lines: number; deadlineAt: string; expected?: { name: string; identity: string | null } }
export const LOG_POLL_TIMEOUT_MS = 35_000;
export const MAX_REQUESTS_PER_POLL = 4;
/** Lower bound between two empty polls: a misbehaving API (no long-poll hold) can never cause a busy loop. */
export const MIN_EMPTY_POLL_INTERVAL_MS = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex -- names must not carry control characters
const NAME_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function parseLogPollReply(text: string): { requests: LogPollRequest[]; accessModel?: 'scoped' } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { requests, accessModel } = body as Record<string, unknown>;
  if (accessModel !== undefined && accessModel !== 'scoped') return null;
  if (!Array.isArray(requests) || requests.length > MAX_REQUESTS_PER_POLL || Object.keys(body).length !== (accessModel === undefined ? 1 : 2)) return null;
  const out: LogPollRequest[] = [];
  for (const r of requests as unknown[]) {
    if (typeof r !== 'object' || r === null) return null;
    const withExpected = Object.hasOwn(r, 'name') || Object.hasOwn(r, 'identity');
    if (Object.keys(r).length !== (withExpected ? 6 : 4)) return null;
    const { requestId, targetKey, lines, deadlineAt, name, identity } = r as Record<string, unknown>;
    if (typeof requestId !== 'string' || !UUID_RE.test(requestId) || typeof targetKey !== 'string' || !TARGET_KEY_RE.test(targetKey)) return null;
    if (typeof lines !== 'number' || !Number.isSafeInteger(lines) || lines < 1 || lines > LOG_LIMITS.maxLines) return null;
    if (typeof deadlineAt !== 'string' || !ISO_RE.test(deadlineAt) || !Number.isFinite(Date.parse(deadlineAt))) return null;
    if (withExpected) {
      if (typeof name !== 'string' || name.length < 1 || name.length > 128 || NAME_CONTROL_RE.test(name)) return null;
      if (!(identity === null || (typeof identity === 'string' && /^[0-9a-f]{16}$/.test(identity)))) return null;
      out.push({ requestId, targetKey, lines, deadlineAt, expected: { name, identity } });
    } else out.push({ requestId, targetKey, lines, deadlineAt });
  }
  return { requests: out, ...(accessModel === 'scoped' ? { accessModel } : {}) };
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
  let v1Polls = 0;
  let lastMode: BrokerMode | null = null;
  while (!signal.aborted) {
    polls += 1;
    let broker: BrokerState = 'ok';
    let targets: LogTarget[] = [];
    let daemon: 'ok' | 'unavailable' | null = null;
    let allowlist: 'ok' | 'invalid' | null = null;
    let brokerVersion: 1 | 2 = 2;
    let mode: BrokerMode | null = null;
    let total = 0;
    const ask = async (v: 1 | 2) => {
      const req: LogTargetsRequest = { v, op: 'logTargets' };
      const max = v === 2 ? MAX_RESPONSE_BYTES_V2 : undefined;
      return await call(control.socket, req, 10_000, (x) => parseLogsResponse(x, req), max) as LogTargetsResponse;
    };
    try {
      let r: LogTargetsResponse;
      try {
        r = await ask(2);
      } catch (error) {
        if (error instanceof BrokerError && !error.sent) throw error;
        brokerVersion = 1; // an older broker drops the unknown request
        r = await ask(1);
      }
      ({ targets, daemon, allowlist } = r);
      mode = r.mode ?? 'allowlist';
      total = r.total ?? targets.length;
    } catch (error) {
      broker = stateOf(error);
    }
    if (mode) lastMode = mode;
    const auto = lastMode === 'auto';
    if (total > targets.length) deps.logger.warn({ msg: 'log targets cut', reported: targets.length, total });
    let version: 1 | 2 = brokerVersion === 1 || (v1Polls > 0 && !auto) ? 1 : 2;
    const report = (v: 1 | 2) => (v === 2
      ? { version: 2, mode, broker, daemon, allowlist, targets, total }
      : { version: 1, broker, daemon, allowlist, targets: targets.slice(0, MAX_LOG_TARGETS_V1).map(({ targetKey, name, pmId, matchStatus }) => ({ targetKey, name, pmId, matchStatus })) });
    const startedAt = Date.now();
    let poll = await machinePost(config, '/api/agent/logs/poll', report(version), signal, parseLogPollReply, deps.fetchImpl, LOG_POLL_TIMEOUT_MS);
    if (poll.kind === 'rejected' && version === 2) {
      if (auto) {
        deps.logger.warn({ msg: 'logs refused: the API does not support scoped access (auto broker needs it)', action: 'update the API' });
      } else {
        v1Polls = 30;
        version = 1;
        poll = await machinePost(config, '/api/agent/logs/poll', report(1), signal, parseLogPollReply, deps.fetchImpl, LOG_POLL_TIMEOUT_MS);
      }
    } else if (version === 1 && v1Polls > 0) {
      v1Polls -= 1;
    }
    if (poll.kind === 'aborted') break;
    let delay = 0;
    if (poll.kind === 'ok') {
      failures = 0;
      // An auto broker serves only an API that authorises every read per user and service.
      const requests = auto && (version !== 2 || poll.value.accessModel !== 'scoped') ? [] : poll.value.requests;
      if (requests.length === 0) {
        const elapsed = Date.now() - startedAt;
        if (elapsed < MIN_EMPTY_POLL_INTERVAL_MS) await sleep(MIN_EMPTY_POLL_INTERVAL_MS - elapsed, signal);
      }
      for (const r of requests) {
        const result = await serve(r, broker, brokerVersion);
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

  async function serve(r: LogPollRequest, broker: BrokerState, v: 1 | 2): Promise<LogsResponse> {
    const failed = (reason: 'broker_unavailable' | 'broker_unsupported' | 'timeout'): LogsResponse =>
      ({ v, op: 'logs', requestId: r.requestId, outcome: 'failed', reason, readAt: new Date().toISOString(), stdout: null, stderr: null });
    if (broker !== 'ok' || !control) return failed(broker === 'unsupported' ? 'broker_unsupported' : 'broker_unavailable');
    const base = { op: 'logs' as const, requestId: r.requestId, targetKey: r.targetKey, lines: r.lines, deadlineAt: r.deadlineAt };
    // A version-2 broker gets what the target must still be; without it (an older API, allowlist fallback) the
    // request stays version 1, which an auto broker refuses (fail closed).
    const req: LogsRequest = v === 2 && r.expected ? { v: 2, ...base, name: r.expected.name, identity: r.expected.identity } : { v: 1, ...base };
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
