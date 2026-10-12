import type { AgentConfig } from './config.js';
import type { Snapshot } from './snapshot.js';

// One heartbeat request + the scheduling policy (ADR-015). TLS verification is Node's default and cannot be
// disabled here; redirects are an error (credentials never follow a redirect); only the configured origin is used.

export type HeartbeatOutcome =
  | { kind: 'accepted'; intervalSeconds: number | null }
  | { kind: 'unauthorized' } // 401/403: credential missing/revoked or server inactive
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'rejected' } // 400/413: payload not accepted
  | { kind: 'unavailable' } // 5xx
  | { kind: 'network' } // DNS/TCP/TLS/redirect errors
  | { kind: 'timeout' }
  | { kind: 'aborted' };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function parseRetryAfter(header: string | null): number | null {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return null;
  return Number(header.trim());
}

export async function sendHeartbeat(config: AgentConfig, snapshot: Snapshot, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<HeartbeatOutcome> {
  const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/agent/heartbeat', config.apiUrl).href, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    if (signal.aborted) return { kind: 'aborted' };
    if (timeout.aborted) return { kind: 'timeout' };
    return { kind: 'network' };
  }
  // The body is small and bounded by the server; drain it so the connection can be reused.
  const text = await response.text().catch(() => '');
  if (response.status === 200) {
    let interval: number | null = null;
    try {
      const body = JSON.parse(text) as { intervalSeconds?: unknown };
      if (typeof body.intervalSeconds === 'number' && Number.isInteger(body.intervalSeconds)) interval = body.intervalSeconds;
    } catch { /* tolerate: keep the configured interval */ }
    return { kind: 'accepted', intervalSeconds: interval };
  }
  if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
  if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')) };
  if (response.status === 400 || response.status === 413) return { kind: 'rejected' };
  return { kind: 'unavailable' };
}

export interface BackoffState {
  failures: number;
}

/** Seconds until the next attempt. Exponential backoff with full jitter, always within [1, maxBackoff]. */
export function nextDelaySeconds(outcome: HeartbeatOutcome, state: BackoffState, config: AgentConfig, random: () => number = Math.random): number {
  const max = config.maxBackoffSeconds;
  switch (outcome.kind) {
    case 'accepted': {
      state.failures = 0;
      // Server may suggest an interval; stay within our own bounds.
      const suggested = outcome.intervalSeconds ?? config.intervalSeconds;
      return Math.min(Math.max(suggested, 5), 300);
    }
    case 'unauthorized':
      // A revoked/missing credential will not fix itself quickly: wait long, never hammer the server.
      state.failures += 1;
      return max;
    case 'rate_limited': {
      state.failures += 1;
      const base = outcome.retryAfterSeconds ?? config.intervalSeconds;
      return Math.min(Math.max(base, config.intervalSeconds), max);
    }
    case 'aborted':
      return 0;
    default: {
      state.failures += 1;
      const ceiling = Math.min(max, config.intervalSeconds * 2 ** Math.min(state.failures, 10));
      return Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
    }
  }
}
