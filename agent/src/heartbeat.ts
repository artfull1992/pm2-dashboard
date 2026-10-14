import type { AgentConfig } from './config.js';
import type { Snapshot } from './snapshot.js';

// One heartbeat request + the scheduling policy (ADR-015). TLS verification is Node's default and cannot be
// disabled here; redirects are an error (credentials never follow a redirect); only the configured origin is used.

export type HeartbeatOutcome =
  | { kind: 'accepted'; intervalSeconds: number } // only after a fully read, contract-valid 200 response
  | { kind: 'unauthorized' } // 401/403: credential missing/revoked or server inactive
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'rejected' } // 400/413: payload not accepted
  | { kind: 'unavailable' } // 5xx and other unexpected statuses
  | { kind: 'invalid_response' } // 200 with an empty/oversized/non-JSON/contract-violating body
  | { kind: 'network' } // DNS/TCP/TLS/redirect errors, or the connection failed while reading the body
  | { kind: 'timeout' } // request + body read exceeded NC_AGENT_TIMEOUT_SECONDS
  | { kind: 'aborted' };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Upper bound for a response body the agent reads (the success reply is ~100 bytes). */
export const MAX_RESPONSE_BYTES = 4096;
/** Server-suggested interval must be within the same bounds as NC_AGENT_INTERVAL_SECONDS. */
export const INTERVAL_BOUNDS = Object.freeze({ min: 5, max: 300 });
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseRetryAfter(header: string | null): number | null {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return null;
  return Number(header.trim());
}

class BodyTooLarge extends Error {}

/**
 * Reads the whole body, at most `limit` bytes, until `signal` aborts (caller cancel or timeout). The size is
 * counted on the stream itself — Content-Length is only used to fail early. Throws on abort, stream error and
 * excess size (BodyTooLarge).
 */
async function readBoundedBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) throw new BodyTooLarge();
  if (!response.body) return new Uint8Array(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) { done = true; break; }
      size += next.value.byteLength;
      if (size > limit) throw new BodyTooLarge();
      chunks.push(next.value);
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (!done) reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Backend contract of a 200 reply: { status: 'accepted', receivedAt: ISO-8601 UTC, intervalSeconds: integer 5..300 }. */
export function parseAcceptedBody(text: string): { intervalSeconds: number } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { status, receivedAt, intervalSeconds } = body as Record<string, unknown>;
  if (status !== 'accepted') return null;
  if (typeof receivedAt !== 'string' || !ISO_UTC_RE.test(receivedAt)) return null;
  const time = Date.parse(receivedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== receivedAt) return null; // e.g. 2026-02-31
  if (typeof intervalSeconds !== 'number' || !Number.isSafeInteger(intervalSeconds)) return null;
  if (intervalSeconds < INTERVAL_BOUNDS.min || intervalSeconds > INTERVAL_BOUNDS.max) return null;
  return { intervalSeconds };
}

/** Outcome of one authenticated machine POST; `ok` only after a fully read body accepted by `parseOk`. */
export type MachinePostOutcome<T> =
  | { kind: 'ok'; value: T }
  | Exclude<HeartbeatOutcome, { kind: 'accepted' }>
  | { kind: 'not_found' }; // 404: the API does not know this route (older API version)

/**
 * One authenticated POST to a machine route of the configured origin (heartbeat, inventory). One deadline covers
 * connect, headers and body; the success body is read with a byte bound and validated by `parseOk`; error bodies
 * are discarded unread. Nothing about the request or response is logged here.
 */
export async function machinePost<T>(
  config: AgentConfig, path: `/api/agent/${string}`, payload: unknown, signal: AbortSignal,
  parseOk: (text: string) => T | null, fetchImpl: FetchLike = fetch, timeoutMs: number = config.timeoutSeconds * 1000,
): Promise<MachinePostOutcome<T>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const failure = (): MachinePostOutcome<T> => {
    if (signal.aborted) return { kind: 'aborted' };
    if (timeout.aborted) return { kind: 'timeout' };
    return { kind: 'network' };
  };
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, config.apiUrl).href, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: combined,
    });
  } catch {
    return failure();
  }

  if (response.status !== 200) {
    // Error statuses need no body: discard it without reading (the content is never logged anyway).
    response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return { kind: 'unauthorized' };
    if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')) };
    if (response.status === 400 || response.status === 413) return { kind: 'rejected' };
    if (response.status === 404) return { kind: 'not_found' };
    return { kind: 'unavailable' };
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, MAX_RESPONSE_BYTES, combined);
  } catch (error) {
    return error instanceof BodyTooLarge ? { kind: 'invalid_response' } : failure();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'invalid_response' };
  }
  const value = parseOk(text);
  return value === null ? { kind: 'invalid_response' } : { kind: 'ok', value };
}

export async function sendHeartbeat(config: AgentConfig, snapshot: Snapshot, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<HeartbeatOutcome> {
  const outcome = await machinePost(config, '/api/agent/heartbeat', snapshot, signal, parseAcceptedBody, fetchImpl);
  if (outcome.kind === 'ok') return { kind: 'accepted', intervalSeconds: outcome.value.intervalSeconds };
  // The heartbeat route exists in every API version: a 404 there is an unexpected server answer.
  if (outcome.kind === 'not_found') return { kind: 'unavailable' };
  return outcome;
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
      // The server's interval is validated by parseAcceptedBody; clamp again as defence in depth.
      return Math.min(Math.max(outcome.intervalSeconds, INTERVAL_BOUNDS.min), INTERVAL_BOUNDS.max);
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
