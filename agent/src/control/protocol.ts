// Agent ⇄ broker protocol (ADR-017): one JSON object per line over the broker's unix socket, one request per
// connection, both directions bounded. Only typed operations exist — there is no field that could carry a command
// line, path, args or env. Both sides parse strictly and reject anything else.

export const CONTROL_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const MATCH_STATUSES = ['ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const OUTCOMES = ['succeeded', 'failed', 'rejected', 'expired', 'unknown'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Server-defined reasons (metadata only; never raw PM2 text). */
export const REASONS = [
  'not_allowlisted', 'action_not_allowed', 'allowlist_invalid', 'not_found', 'ambiguous', 'cluster_unsupported',
  'fingerprint_mismatch', 'invalid_state', 'daemon_unavailable', 'pm2_error', 'timeout', 'deadline_passed',
  'invalid_deadline', 'interrupted', 'identity_changed', 'verification_failed', 'command_conflict', 'broker_busy',
  'broker_unavailable',
] as const;
export type Reason = (typeof REASONS)[number];

export const PROCESS_STATES = ['online', 'stopping', 'stopped', 'launching', 'errored', 'one-launch-status', 'waiting restart', 'unknown'] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

export const MAX_FRAME_BYTES = 64 * 1024;
/** A version-2 list/logTargets answer may describe every process of the PM2 owner (ADR-028). */
export const MAX_RESPONSE_BYTES_V2 = 256 * 1024;
export const MAX_TARGETS = 50;
export const MAX_TARGETS_V2 = 500;
export const TARGET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Definition identity of a target (16 hex of the definition fingerprint; ADR-028). */
export const IDENTITY_RE = /^[0-9a-f]{16}$/;

/** allowlist: root-owned list of targets (ADR-017); auto: every process of the registered PM2 owner (ADR-028). */
export const BROKER_MODES = ['allowlist', 'auto'] as const;
export type BrokerMode = (typeof BROKER_MODES)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex -- reject control characters in names
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface BrokerTarget {
  targetKey: string;
  name: string;
  pmId: number | null;
  actions: ControlAction[];
  matchStatus: MatchStatus;
  /** Version 2 only: identity of the matched definition; null when not exactly one matching process. */
  identity?: string | null;
}

export interface ProcessSnapshot { status: ProcessState }

// Version 1: allowlist broker (ADR-017). Version 2 (ADR-028): adds the broker mode, the definition identity of each
// target and up to 500 targets; an execute names the identity the API authorised, so a changed definition is refused.
export type BrokerRequest =
  | { v: 1 | 2; op: 'list' }
  | { v: 1; op: 'execute'; commandId: string; targetKey: string; action: ControlAction; deadlineAt: string }
  | { v: 2; op: 'execute'; commandId: string; targetKey: string; action: ControlAction; deadlineAt: string; identity: string | null };

export interface ListResponse {
  v: 1 | 2;
  op: 'list';
  /** Version 2 only. */
  mode?: BrokerMode;
  daemon: 'ok' | 'unavailable';
  allowlist: 'ok' | 'invalid';
  targets: BrokerTarget[];
  /** Version 2 only: number of targets that exist; more than targets.length means the list was cut (never silently). */
  total?: number;
}

export type BrokerResponse = ListResponse | ExecuteResult;

export interface ExecuteResult {
  v: 1 | 2;
  op: 'execute';
  commandId: string;
  outcome: Outcome;
  reason: Reason | null;
  before: ProcessSnapshot | null;
  after: ProcessSnapshot | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const isTargetKey = (v: unknown): v is string => typeof v === 'string' && TARGET_KEY_RE.test(v);
export const isProcessName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 128 && !CONTROL_CHARS.test(v);

export function isActionList(v: unknown): v is ControlAction[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= CONTROL_ACTIONS.length && new Set(v).size === v.length && v.every((a) => oneOf(CONTROL_ACTIONS, a));
}

export const isIdentity = (v: unknown): v is string => typeof v === 'string' && IDENTITY_RE.test(v);

export function parseBrokerRequest(value: unknown): BrokerRequest | null {
  if (!isObject(value) || (value.v !== 1 && value.v !== 2)) return null;
  const v = value.v;
  if (value.op === 'list') return exactKeys(value, ['v', 'op']) ? { v, op: 'list' } : null;
  const keys = ['v', 'op', 'commandId', 'targetKey', 'action', 'deadlineAt', ...(v === 2 ? ['identity'] : [])];
  if (value.op !== 'execute' || !exactKeys(value, keys)) return null;
  const { commandId, targetKey, action, deadlineAt, identity } = value;
  if (!isUuid(commandId) || !isTargetKey(targetKey) || !oneOf(CONTROL_ACTIONS, action) || !isIsoUtc(deadlineAt)) return null;
  if (v === 1) return { v: 1, op: 'execute', commandId, targetKey, action, deadlineAt };
  if (!(identity === null || isIdentity(identity))) return null;
  return { v: 2, op: 'execute', commandId, targetKey, action, deadlineAt, identity };
}

function parseSnapshot(v: unknown): ProcessSnapshot | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !exactKeys(v, ['status']) || !oneOf(PROCESS_STATES, v.status)) return undefined;
  return { status: v.status };
}

export function parseTarget(v: unknown, version: 1 | 2 = 1): BrokerTarget | null {
  if (!isObject(v) || !exactKeys(v, ['targetKey', 'name', 'pmId', 'actions', 'matchStatus', ...(version === 2 ? ['identity'] : [])])) return null;
  const { targetKey, name, pmId, actions, matchStatus, identity } = v;
  if (!isTargetKey(targetKey) || !isProcessName(name) || !isActionList(actions) || !oneOf(MATCH_STATUSES, matchStatus)) return null;
  if (!(pmId === null || (typeof pmId === 'number' && Number.isSafeInteger(pmId) && pmId >= 0 && pmId <= 1_000_000))) return null;
  if ((matchStatus === 'ok') !== (pmId !== null)) return null;
  if (version === 1) return { targetKey, name, pmId, actions, matchStatus };
  // A matched target always carries its identity, an unmatched one never.
  if (matchStatus === 'ok' ? !isIdentity(identity) : identity !== null) return null;
  return { targetKey, name, pmId, actions, matchStatus, identity: identity as string | null };
}

export function parseBrokerResponse(value: unknown, expected: BrokerRequest): BrokerResponse | null {
  if (!isObject(value) || value.v !== expected.v || value.op !== expected.op) return null;
  if (expected.op === 'list') {
    if (expected.v === 1) {
      if (!exactKeys(value, ['v', 'op', 'daemon', 'allowlist', 'targets'])) return null;
    } else if (!exactKeys(value, ['v', 'op', 'mode', 'daemon', 'allowlist', 'targets', 'total'])) return null;
    const { daemon, allowlist, targets, mode, total } = value;
    if ((daemon !== 'ok' && daemon !== 'unavailable') || (allowlist !== 'ok' && allowlist !== 'invalid')) return null;
    const max = expected.v === 2 ? MAX_TARGETS_V2 : MAX_TARGETS;
    if (!Array.isArray(targets) || targets.length > max) return null;
    const parsed = targets.map((t) => parseTarget(t, expected.v));
    if (parsed.some((t) => t === null) || new Set(parsed.map((t) => t?.targetKey)).size !== parsed.length) return null;
    if (expected.v === 1) return { v: 1, op: 'list', daemon, allowlist, targets: parsed as BrokerTarget[] };
    if (!oneOf(BROKER_MODES, mode) || typeof total !== 'number' || !Number.isSafeInteger(total) || total < parsed.length || total > 100_000) return null;
    return { v: 2, op: 'list', mode, daemon, allowlist, targets: parsed as BrokerTarget[], total };
  }
  if (!exactKeys(value, ['v', 'op', 'commandId', 'outcome', 'reason', 'before', 'after'])) return null;
  const { commandId, outcome, reason, before, after } = value;
  if (commandId !== expected.commandId || !oneOf(OUTCOMES, outcome)) return null;
  if (!(reason === null || oneOf(REASONS, reason))) return null;
  if (outcome !== 'succeeded' && reason === null) return null;
  const b = parseSnapshot(before);
  const a = parseSnapshot(after);
  if (b === undefined || a === undefined) return null;
  return { v: expected.v, op: 'execute', commandId, outcome, reason, before: b, after: a };
}
