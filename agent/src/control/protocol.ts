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
export const MAX_TARGETS = 50;
export const TARGET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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
}

export interface ProcessSnapshot { status: ProcessState }

export type BrokerRequest =
  | { v: 1; op: 'list' }
  | { v: 1; op: 'execute'; commandId: string; targetKey: string; action: ControlAction; deadlineAt: string };

export type BrokerResponse =
  | { v: 1; op: 'list'; daemon: 'ok' | 'unavailable'; allowlist: 'ok' | 'invalid'; targets: BrokerTarget[] }
  | ExecuteResult;

export interface ExecuteResult {
  v: 1;
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

export function parseBrokerRequest(value: unknown): BrokerRequest | null {
  if (!isObject(value) || value.v !== 1) return null;
  if (value.op === 'list') return exactKeys(value, ['v', 'op']) ? { v: 1, op: 'list' } : null;
  if (value.op !== 'execute' || !exactKeys(value, ['v', 'op', 'commandId', 'targetKey', 'action', 'deadlineAt'])) return null;
  const { commandId, targetKey, action, deadlineAt } = value;
  if (!isUuid(commandId) || !isTargetKey(targetKey) || !oneOf(CONTROL_ACTIONS, action) || !isIsoUtc(deadlineAt)) return null;
  return { v: 1, op: 'execute', commandId, targetKey, action, deadlineAt };
}

function parseSnapshot(v: unknown): ProcessSnapshot | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !exactKeys(v, ['status']) || !oneOf(PROCESS_STATES, v.status)) return undefined;
  return { status: v.status };
}

export function parseTarget(v: unknown): BrokerTarget | null {
  if (!isObject(v) || !exactKeys(v, ['targetKey', 'name', 'pmId', 'actions', 'matchStatus'])) return null;
  const { targetKey, name, pmId, actions, matchStatus } = v;
  if (!isTargetKey(targetKey) || !isProcessName(name) || !isActionList(actions) || !oneOf(MATCH_STATUSES, matchStatus)) return null;
  if (!(pmId === null || (typeof pmId === 'number' && Number.isSafeInteger(pmId) && pmId >= 0 && pmId <= 1_000_000))) return null;
  if ((matchStatus === 'ok') !== (pmId !== null)) return null;
  return { targetKey, name, pmId, actions, matchStatus };
}

export function parseBrokerResponse(value: unknown, expected: BrokerRequest): BrokerResponse | null {
  if (!isObject(value) || value.v !== 1 || value.op !== expected.op) return null;
  if (expected.op === 'list') {
    if (!exactKeys(value, ['v', 'op', 'daemon', 'allowlist', 'targets'])) return null;
    const { daemon, allowlist, targets } = value;
    if ((daemon !== 'ok' && daemon !== 'unavailable') || (allowlist !== 'ok' && allowlist !== 'invalid')) return null;
    if (!Array.isArray(targets) || targets.length > MAX_TARGETS) return null;
    const parsed = targets.map(parseTarget);
    if (parsed.some((t) => t === null) || new Set(parsed.map((t) => t?.targetKey)).size !== parsed.length) return null;
    return { v: 1, op: 'list', daemon, allowlist, targets: parsed as BrokerTarget[] };
  }
  if (!exactKeys(value, ['v', 'op', 'commandId', 'outcome', 'reason', 'before', 'after'])) return null;
  const { commandId, outcome, reason, before, after } = value;
  if (commandId !== expected.commandId || !oneOf(OUTCOMES, outcome)) return null;
  if (!(reason === null || oneOf(REASONS, reason))) return null;
  if (outcome !== 'succeeded' && reason === null) return null;
  const b = parseSnapshot(before);
  const a = parseSnapshot(after);
  if (b === undefined || a === undefined) return null;
  return { v: 1, op: 'execute', commandId, outcome, reason, before: b, after: a };
}
