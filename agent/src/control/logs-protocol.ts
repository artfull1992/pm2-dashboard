// Log tail protocol (ADR-018): Agent ⇄ broker operations `logTargets` and `logs`. Read-only, separate from the
// control lifecycle. Requests carry only a target key, a bounded line count, an id and a deadline — never a path,
// glob, offset, args or env. Responses carry sanitised text and safe metadata only (no paths, no raw errors).

export const LOG_LIMITS = Object.freeze({
  maxLines: 100,
  maxLineChars: 1000,
  /** UTF-8 bytes of stdout+stderr text together. */
  totalTextBytes: 8 * 1024,
  /** At most this many trailing bytes of each file are read. */
  tailBytes: 256 * 1024,
  /** Serialised broker response / HTTP result body (JSON escaping included). */
  maxFrameBytes: 32 * 1024,
  readTimeoutMs: 5_000,
  maxConcurrentReads: 2,
});

export const LOG_STREAM_STATES = ['ok', 'empty', 'missing', 'unavailable', 'merged'] as const;
export type LogStreamState = (typeof LOG_STREAM_STATES)[number];

export const LOG_REASONS = [
  'not_allowlisted', 'logs_not_allowed', 'allowlist_invalid', 'not_found', 'ambiguous', 'cluster_unsupported',
  'fingerprint_mismatch', 'daemon_unavailable', 'deadline_passed', 'invalid_deadline', 'broker_busy', 'timeout',
  // Set by the Agent (not the broker) when the broker cannot be asked.
  'broker_unavailable', 'broker_unsupported',
  // Version 2 (ADR-028): the target the broker resolves is not the service/definition the request was authorised for.
  'target_changed', 'identity_changed',
] as const;
export type LogReason = (typeof LOG_REASONS)[number];

export interface LogStream {
  state: LogStreamState;
  text: string;
  lines: number;
  /** True when older content exists that is not shown (file larger than the tail, or lines/bytes cut). */
  truncated: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface LogTarget {
  targetKey: string; name: string; pmId: number | null; matchStatus: string;
  /** Version 2 only: definition identity of a matched target (16 hex), null otherwise. */
  identity?: string | null;
}

/** Version 2 (ADR-028): adds the broker mode and up to 500 targets; requests/results are otherwise the same. */
export const MAX_LOG_TARGETS_V1 = 50;
export const MAX_LOG_TARGETS_V2 = 500;
export type BrokerMode = 'allowlist' | 'auto';

export type LogTargetsRequest = { v: 1 | 2; op: 'logTargets' };
/** Version 2 adds what the target must still be (name; identity when the API recorded one) — checked before reading. */
export type LogsRequest =
  | { v: 1; op: 'logs'; requestId: string; targetKey: string; lines: number; deadlineAt: string }
  | { v: 2; op: 'logs'; requestId: string; targetKey: string; lines: number; deadlineAt: string; name: string; identity: string | null };

export type LogTargetsResponse = {
  v: 1 | 2; op: 'logTargets'; daemon: 'ok' | 'unavailable'; allowlist: 'ok' | 'invalid'; targets: LogTarget[];
  /** Version 2 only. */
  mode?: BrokerMode; total?: number;
};
export interface LogsResponse {
  v: 1 | 2;
  op: 'logs';
  requestId: string;
  outcome: 'ok' | 'rejected' | 'failed';
  reason: LogReason | null;
  readAt: string;
  stdout: LogStream | null;
  stderr: LogStream | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MATCH = ['ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable'] as const;
// eslint-disable-next-line no-control-regex -- names must not carry control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const IDENTITY_RE = /^[0-9a-f]{16}$/;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 128 && !CONTROL_RE.test(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_UTC_RE.test(v) && Number.isFinite(Date.parse(v));
const isLines = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= LOG_LIMITS.maxLines;

export function parseLogsRequest(value: Record<string, unknown>): LogTargetsRequest | LogsRequest | null {
  if (value.v !== 1 && value.v !== 2) return null;
  const v = value.v;
  if (value.op === 'logTargets') return exactKeys(value, ['v', 'op']) ? { v, op: 'logTargets' } : null;
  if (value.op !== 'logs' || !exactKeys(value, ['v', 'op', 'requestId', 'targetKey', 'lines', 'deadlineAt', ...(v === 2 ? ['name', 'identity'] : [])])) return null;
  const { requestId, targetKey, lines, deadlineAt, name, identity } = value;
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId) || typeof targetKey !== 'string' || !TARGET_KEY_RE.test(targetKey)) return null;
  if (!isLines(lines) || !isIso(deadlineAt)) return null;
  if (v === 1) return { v: 1, op: 'logs', requestId, targetKey, lines, deadlineAt };
  if (!isName(name) || !(identity === null || (typeof identity === 'string' && IDENTITY_RE.test(identity)))) return null;
  return { v: 2, op: 'logs', requestId, targetKey, lines, deadlineAt, name, identity };
}

export function parseLogStream(v: unknown): LogStream | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !exactKeys(v, ['state', 'text', 'lines', 'truncated', 'sizeBytes', 'modifiedAt'])) return undefined;
  const { state, text, lines, truncated, sizeBytes, modifiedAt } = v;
  if (!oneOf(LOG_STREAM_STATES, state) || typeof text !== 'string' || Buffer.byteLength(text) > LOG_LIMITS.totalTextBytes) return undefined;
  if (typeof lines !== 'number' || !Number.isSafeInteger(lines) || lines < 0 || lines > LOG_LIMITS.maxLines || typeof truncated !== 'boolean') return undefined;
  if (!(sizeBytes === null || (typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0))) return undefined;
  if (!(modifiedAt === null || isIso(modifiedAt))) return undefined;
  return { state, text, lines, truncated, sizeBytes, modifiedAt };
}

export function parseLogsResponse(value: unknown, expected: LogTargetsRequest | LogsRequest): LogTargetsResponse | LogsResponse | null {
  if (!isObject(value) || value.v !== expected.v || value.op !== expected.op) return null;
  if (expected.op === 'logTargets') {
    if (!exactKeys(value, ['v', 'op', 'daemon', 'allowlist', 'targets', ...(expected.v === 2 ? ['mode', 'total'] : [])])) return null;
    const { daemon, allowlist, targets, mode, total } = value;
    const max = expected.v === 2 ? MAX_LOG_TARGETS_V2 : MAX_LOG_TARGETS_V1;
    if ((daemon !== 'ok' && daemon !== 'unavailable') || (allowlist !== 'ok' && allowlist !== 'invalid') || !Array.isArray(targets) || targets.length > max) return null;
    const parsed: LogTarget[] = [];
    for (const t of targets as unknown[]) {
      if (!isObject(t) || !exactKeys(t, ['targetKey', 'name', 'pmId', 'matchStatus', ...(expected.v === 2 ? ['identity'] : [])])) return null;
      const { targetKey, name, pmId, matchStatus, identity } = t;
      if (typeof targetKey !== 'string' || !TARGET_KEY_RE.test(targetKey) || typeof name !== 'string' || name.length < 1 || name.length > 128 || CONTROL_RE.test(name)) return null;
      if (!(pmId === null || (typeof pmId === 'number' && Number.isSafeInteger(pmId) && pmId >= 0)) || !oneOf(MATCH, matchStatus)) return null;
      if (expected.v === 2) {
        // A matched target always carries its identity, an unmatched one never.
        if (matchStatus === 'ok' ? !(typeof identity === 'string' && IDENTITY_RE.test(identity)) : identity !== null) return null;
        parsed.push({ targetKey, name, pmId, matchStatus, identity: identity as string | null });
      } else parsed.push({ targetKey, name, pmId, matchStatus });
    }
    if (new Set(parsed.map((t) => t.targetKey)).size !== parsed.length) return null;
    if (expected.v === 1) return { v: 1, op: 'logTargets', daemon, allowlist, targets: parsed };
    if ((mode !== 'allowlist' && mode !== 'auto') || typeof total !== 'number' || !Number.isSafeInteger(total) || total < parsed.length || total > 100_000) return null;
    return { v: 2, op: 'logTargets', daemon, allowlist, targets: parsed, mode, total };
  }
  if (!exactKeys(value, ['v', 'op', 'requestId', 'outcome', 'reason', 'readAt', 'stdout', 'stderr'])) return null;
  const { requestId, outcome, reason, readAt, stdout, stderr } = value;
  if (requestId !== expected.requestId || (outcome !== 'ok' && outcome !== 'rejected' && outcome !== 'failed') || !isIso(readAt)) return null;
  if (!(reason === null || oneOf(LOG_REASONS, reason)) || (outcome === 'ok') !== (reason === null)) return null;
  const out = parseLogStream(stdout);
  const err = parseLogStream(stderr);
  if (out === undefined || err === undefined || (outcome === 'ok') !== (out !== null && err !== null)) return null;
  return { v: expected.v, op: 'logs', requestId, outcome, reason, readAt, stdout: out, stderr: err };
}
