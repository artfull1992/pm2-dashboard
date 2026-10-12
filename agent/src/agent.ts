import type { AgentConfig } from './config.js';
import { type BackoffState, type FetchLike, type HeartbeatOutcome, nextDelaySeconds, sendHeartbeat } from './heartbeat.js';
import { collectSnapshot, type Snapshot } from './snapshot.js';

// Heartbeat loop: strictly sequential (the next request is scheduled only after the previous one finished),
// cancellable at any point. Logs are metadata only: outcome kind and delay — never the token or response bodies.

export interface AgentLogger {
  info(event: Record<string, unknown>): void;
  warn(event: Record<string, unknown>): void;
}

export interface AgentDeps {
  fetchImpl?: FetchLike;
  snapshot?: () => Snapshot;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger: AgentLogger;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs until `signal` aborts. Returns the number of attempts made (for tests). */
export async function runAgent(config: AgentConfig, signal: AbortSignal, deps: AgentDeps): Promise<number> {
  const state: BackoffState = { failures: 0 };
  const sleep = deps.sleep ?? abortableSleep;
  let attempts = 0;
  let lastKind: HeartbeatOutcome['kind'] | null = null;

  while (!signal.aborted) {
    attempts += 1;
    const outcome = await sendHeartbeat(config, (deps.snapshot ?? collectSnapshot)(), signal, deps.fetchImpl);
    if (outcome.kind === 'aborted') break;
    const delay = nextDelaySeconds(outcome, state, config, deps.random);
    // Log on state changes and on every failure; steady success is logged once.
    if (outcome.kind !== lastKind || outcome.kind !== 'accepted') {
      const event = { msg: 'heartbeat', outcome: outcome.kind, nextInSeconds: delay, consecutiveFailures: state.failures };
      if (outcome.kind === 'accepted') deps.logger.info(event);
      else deps.logger.warn(event);
    }
    lastKind = outcome.kind;
    await sleep(delay * 1000, signal);
  }
  return attempts;
}
