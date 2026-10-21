// Allowlisted PM2 process control — API-side contract (ADR-017). Mirrors agent/src/control/protocol.ts.
// Static schemas only (additionalProperties:false; strict Ajv rejects unknown fields).

export const CONTROL_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export const MATCH_STATUSES = ['ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const COMMAND_STATUSES = ['queued', 'dispatched', 'succeeded', 'failed', 'rejected', 'expired', 'unknown'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
export const OUTCOMES = ['succeeded', 'failed', 'rejected', 'expired', 'unknown'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const AGENT_REASONS = [
  'not_allowlisted', 'action_not_allowed', 'allowlist_invalid', 'not_found', 'ambiguous', 'cluster_unsupported',
  'fingerprint_mismatch', 'invalid_state', 'daemon_unavailable', 'pm2_error', 'timeout', 'deadline_passed',
  'invalid_deadline', 'interrupted', 'identity_changed', 'verification_failed', 'command_conflict', 'broker_busy',
  'broker_unavailable',
] as const;
export const PROCESS_STATES = ['online', 'stopping', 'stopped', 'launching', 'errored', 'one-launch-status', 'waiting restart', 'unknown'] as const;

/** A command not dispatched by then expires; a dispatched one may still report until deadline + grace. */
export const COMMAND_DEADLINE_SECONDS = 120;
export const LEASE_SECONDS = 45;
export const RESULT_GRACE_SECONDS = 120;
export const MAX_ATTEMPTS = 3;
/** Targets reported by the Agent older than this are not controllable. */
export const TARGET_FRESH_SECONDS = 60;
export const POLL_INTERVAL_ENABLED_SECONDS = 10;
export const POLL_INTERVAL_DISABLED_SECONDS = 60;
/** Version 2 reports every process of the PM2 owner (auto broker, ADR-028): up to the inventory bound. */
export const MAX_TARGETS_V1 = 50;
export const MAX_TARGETS_V2 = 500;
export const POLL_BODY_LIMIT = 256 * 1024;
export const RESULT_BODY_LIMIT = 4 * 1024;

const TARGET_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const NAME_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f]+$';
const actionsSchema = { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: CONTROL_ACTIONS } } as const;
const snapshotSchema = {
  anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: PROCESS_STATES } } }],
} as const;

export const targetSchema = {
  type: 'object', additionalProperties: false, required: ['targetKey', 'name', 'pmId', 'actions', 'matchStatus'],
  properties: {
    targetKey: { type: 'string', pattern: TARGET_KEY_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 128, pattern: NAME_PATTERN },
    pmId: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
    actions: actionsSchema,
    matchStatus: { type: 'string', enum: MATCH_STATUSES },
  },
} as const;

/** Identity of the process definition the target refers to (auto broker; 16 hex of the definition digest). */
export const IDENTITY_PATTERN = '^[0-9a-f]{16}$';

export interface ControlTarget {
  targetKey: string; name: string; pmId: number | null; actions: ControlAction[]; matchStatus: MatchStatus;
  /** Version 2 only: definition identity (null when the target does not match exactly one process). */
  identity?: string | null;
}

export type BrokerMode = 'allowlist' | 'auto';

export interface PollReport {
  version: 1 | 2;
  /** Version 2 only. */
  mode?: BrokerMode | null;
  broker: 'ok' | 'unavailable';
  daemon: 'ok' | 'unavailable' | null;
  allowlist: 'ok' | 'invalid' | null;
  targets: ControlTarget[];
  /** Version 2 only. */
  total?: number;
}

const pollCommon = {
  broker: { type: 'string', enum: ['ok', 'unavailable'] },
  daemon: { type: ['string', 'null'], enum: ['ok', 'unavailable', null] },
  allowlist: { type: ['string', 'null'], enum: ['ok', 'invalid', null] },
} as const;

export const targetSchemaV2 = {
  type: 'object', additionalProperties: false, required: ['targetKey', 'name', 'pmId', 'actions', 'matchStatus', 'identity'],
  properties: { ...targetSchema.properties, identity: { type: ['string', 'null'], pattern: IDENTITY_PATTERN } },
} as const;

/** Version 1 (allowlist broker, ≤ 50 targets) or version 2 (ADR-028: mode, identity, ≤ 500 targets). */
export const pollSchema = {
  anyOf: [
    {
      type: 'object', additionalProperties: false, required: ['version', 'broker', 'daemon', 'allowlist', 'targets'],
      properties: { version: { type: 'integer', enum: [1] }, ...pollCommon, targets: { type: 'array', maxItems: MAX_TARGETS_V1, items: targetSchema } },
    },
    {
      type: 'object', additionalProperties: false, required: ['version', 'mode', 'broker', 'daemon', 'allowlist', 'targets'],
      properties: {
        version: { type: 'integer', enum: [2] }, mode: { type: ['string', 'null'], enum: ['allowlist', 'auto', null] }, ...pollCommon,
        targets: { type: 'array', maxItems: MAX_TARGETS_V2, items: targetSchemaV2 },
        // Targets the broker knows; more than reported = cut at MAX_TARGETS_V2 (shown in the UI, never silent).
        total: { type: 'integer', minimum: 0, maximum: 100_000 },
      },
    },
  ],
} as const;

export interface ResultReport {
  version: 1;
  commandId: string;
  attempt: number;
  outcome: Outcome;
  reason: string | null;
  before: { status: string } | null;
  after: { status: string } | null;
}

export const resultSchema = {
  type: 'object', additionalProperties: false, required: ['version', 'commandId', 'attempt', 'outcome', 'reason', 'before', 'after'],
  properties: {
    version: { type: 'integer', enum: [1] },
    commandId: { type: 'string', pattern: UUID_PATTERN },
    attempt: { type: 'integer', minimum: 1, maximum: MAX_ATTEMPTS },
    outcome: { type: 'string', enum: OUTCOMES },
    reason: { type: ['string', 'null'], enum: [...AGENT_REASONS, null] },
    before: snapshotSchema,
    after: snapshotSchema,
  },
} as const;

/** Cross-field checks the schema cannot express. */
export function pollProblem(r: PollReport): string | null {
  if (new Set(r.targets.map((t) => t.targetKey)).size !== r.targets.length) return 'duplicate target';
  if (r.targets.some((t) => (t.matchStatus === 'ok') !== (t.pmId !== null))) return 'pmId/matchStatus';
  if (r.broker === 'unavailable' && r.targets.length > 0) return 'targets without broker';
  // Auto broker: a matched target always carries the identity of its process definition, an unmatched one never.
  if (r.version === 2 && r.total !== undefined && r.total < r.targets.length) return 'total';
  if (r.version === 2 && r.mode === 'auto' && r.targets.some((t) => (t.matchStatus === 'ok') !== (typeof t.identity === 'string'))) return 'identity/matchStatus';
  return null;
}

export function resultProblem(r: ResultReport): string | null {
  return r.outcome !== 'succeeded' && r.reason === null ? 'reason required' : null;
}

export const commandBodySchema = {
  type: 'object', additionalProperties: false, required: ['targetKey', 'action', 'idempotencyKey'],
  properties: {
    targetKey: { type: 'string', pattern: TARGET_KEY_PATTERN },
    action: { type: 'string', enum: CONTROL_ACTIONS },
    idempotencyKey: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

export const commandViewProperties = {
  id: { type: 'string' }, serverId: { type: 'string' }, targetKey: { type: 'string' }, serviceName: { type: ['string', 'null'] }, action: { type: 'string', enum: CONTROL_ACTIONS },
  status: { type: 'string', enum: COMMAND_STATUSES }, reason: { type: ['string', 'null'] }, requestedBy: { type: 'string' },
  requestedAt: { type: 'string' }, deadlineAt: { type: 'string' }, dispatchedAt: { type: ['string', 'null'] },
  completedAt: { type: ['string', 'null'] }, attempts: { type: 'integer' }, before: snapshotSchema, after: snapshotSchema,
} as const;
export const commandViewSchema = { type: 'object', additionalProperties: false, required: Object.keys(commandViewProperties), properties: commandViewProperties } as const;

export interface CommandView {
  id: string; serverId: string; targetKey: string; serviceName: string | null; action: ControlAction; status: CommandStatus; reason: string | null;
  requestedBy: string; requestedAt: string; deadlineAt: string; dispatchedAt: string | null; completedAt: string | null;
  attempts: number; before: { status: string } | null; after: { status: string } | null;
}
