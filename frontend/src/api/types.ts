// Runtime validation of API responses (ADR-012). The backend contract is in README / ADR-011; anything that
// does not match exactly is treated as an unexpected response instead of being trusted by the UI.

export const KNOWN_PERMISSIONS = ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read'] as const;
export type Permission = (typeof KNOWN_PERMISSIONS)[number];
export const KNOWN_ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof KNOWN_ROLES)[number];

export interface SessionInfo {
  user: { id: string; email: string; role: Role };
  permissions: Permission[];
  csrfToken: string;
  expiresAt: string;
}

export interface AuditItem {
  id: string;
  occurredAt: string;
  event: string;
  outcome: 'success' | 'failure' | 'denied';
  actorUserId: string | null;
  requestId: string | null;
  details: { reason?: string; permission?: string; route?: string; serverId?: string; targetKey?: string; commandId?: string; action?: string; rotated?: boolean; revoked?: boolean };
}

export interface AuditPage {
  items: AuditItem[];
  nextBeforeId: string | null;
}

export class ContractError extends Error {
  constructor() {
    super('unexpected API response');
    this.name = 'ContractError';
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max;
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);

function expect(condition: boolean): asserts condition {
  if (!condition) throw new ContractError();
}

export function parseSessionInfo(value: unknown): SessionInfo {
  expect(isObject(value) && isObject(value.user));
  const { user, permissions, csrfToken, expiresAt } = value;
  expect(isObject(user) && isString(user.id, 64) && isString(user.email, 254) && (KNOWN_ROLES as readonly unknown[]).includes(user.role));
  expect(Array.isArray(permissions) && permissions.every((p) => (KNOWN_PERMISSIONS as readonly unknown[]).includes(p)));
  expect(isString(csrfToken, 128) && /^[A-Za-z0-9_-]{43}$/.test(csrfToken));
  expect(isString(expiresAt, 64) && !Number.isNaN(Date.parse(expiresAt)));
  return {
    user: { id: user.id, email: user.email, role: user.role as Role },
    permissions: permissions as Permission[],
    csrfToken,
    expiresAt,
  };
}

const DETAIL_KEYS = ['reason', 'permission', 'route', 'serverId', 'targetKey', 'commandId', 'action'] as const;
const DETAIL_FLAGS = ['rotated', 'revoked'] as const;

function parseAuditItem(value: unknown): AuditItem {
  expect(isObject(value) && isObject(value.details));
  const { id, occurredAt, event, outcome, actorUserId, requestId, details } = value;
  expect(isString(id, 20) && /^\d+$/.test(id));
  expect(isString(occurredAt, 64) && !Number.isNaN(Date.parse(occurredAt)));
  expect(isString(event, 64));
  expect(outcome === 'success' || outcome === 'failure' || outcome === 'denied');
  expect(isNullableString(actorUserId) && isNullableString(requestId));
  const safeDetails: AuditItem['details'] = {};
  for (const key of DETAIL_KEYS) {
    const detail = details[key];
    if (detail === undefined) continue;
    expect(isString(detail, 256));
    safeDetails[key] = detail;
  }
  for (const key of DETAIL_FLAGS) {
    const flag = details[key];
    if (flag === undefined) continue;
    expect(typeof flag === 'boolean');
    safeDetails[key] = flag;
  }
  return { id, occurredAt, event, outcome, actorUserId, requestId, details: safeDetails };
}

export function parseAuditPage(value: unknown): AuditPage {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 100);
  expect(isNullableString(value.nextBeforeId));
  return { items: value.items.map(parseAuditItem), nextBeforeId: value.nextBeforeId };
}

// --- Server registry (Task 007) -------------------------------------------------------------------------------

export type ServerStatus = 'online' | 'offline' | 'never_connected';

export interface ServerSummary {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  status: ServerStatus;
  lastSeenAt: string | null;
  hasActiveCredential: boolean;
}

export interface ServerSnapshot {
  agentVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  cpuCount: number;
  loadAverage: [number, number, number];
  memory: { totalBytes: number; freeBytes: number };
}

export interface ServerDetail extends ServerSummary {
  snapshot: ServerSnapshot | null;
}

export interface ServerPage {
  items: ServerSummary[];
  nextAfterId: string | null;
  onlineWindowSeconds: number;
}

export interface IssuedCredential {
  serverId: string;
  token: string;
  issuedAt: string;
  rotated: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isDate = (v: unknown): v is string => isString(v, 64) && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

export function parseServerSummary(value: unknown): ServerSummary {
  expect(isObject(value));
  const { id, name, isActive, createdAt, status, lastSeenAt, hasActiveCredential } = value;
  expect(isString(id, 36) && UUID_RE.test(id) && isString(name, 100) && typeof isActive === 'boolean' && isDate(createdAt));
  expect(status === 'online' || status === 'offline' || status === 'never_connected');
  expect((lastSeenAt === null || isDate(lastSeenAt)) && typeof hasActiveCredential === 'boolean');
  return { id, name, isActive, createdAt, status, lastSeenAt, hasActiveCredential };
}

function parseSnapshot(value: unknown): ServerSnapshot {
  expect(isObject(value) && isObject(value.memory) && Array.isArray(value.loadAverage) && value.loadAverage.length === 3);
  const { agentVersion, hostname, platform, arch, uptimeSeconds, cpuCount, loadAverage, memory } = value;
  expect(isString(agentVersion, 16) && isString(hostname, 253) && isString(platform, 16) && isString(arch, 16));
  expect(isCount(uptimeSeconds, 1e10) && isCount(cpuCount, 4096) && (loadAverage as unknown[]).every((n) => isCount(n, 100_000)));
  const { totalBytes, freeBytes } = memory;
  expect(isCount(totalBytes, Number.MAX_SAFE_INTEGER) && isCount(freeBytes, Number.MAX_SAFE_INTEGER) && freeBytes <= totalBytes);
  const [l1, l5, l15] = loadAverage as [number, number, number];
  return { agentVersion, hostname, platform, arch, uptimeSeconds, cpuCount, loadAverage: [l1, l5, l15], memory: { totalBytes, freeBytes } };
}

export function parseServerDetail(value: unknown): ServerDetail {
  expect(isObject(value));
  return { ...parseServerSummary(value), snapshot: value.snapshot === null ? null : parseSnapshot(value.snapshot) };
}

export function parseServerPage(value: unknown): ServerPage {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 100);
  expect(isNullableString(value.nextAfterId) && isCount(value.onlineWindowSeconds, 3600));
  return { items: value.items.map(parseServerSummary), nextAfterId: value.nextAfterId, onlineWindowSeconds: value.onlineWindowSeconds };
}

export function parseIssuedCredential(value: unknown): IssuedCredential {
  expect(isObject(value));
  const { serverId, token, issuedAt, rotated } = value;
  expect(isString(serverId, 36) && isString(token, 64) && /^ncag_[A-Za-z0-9_-]{43}$/.test(token) && isDate(issuedAt) && typeof rotated === 'boolean');
  return { serverId, token, issuedAt, rotated };
}

export function parseRevokeResult(value: unknown): { serverId: string; revoked: boolean } {
  expect(isObject(value) && isString(value.serverId, 36) && typeof value.revoked === 'boolean');
  return { serverId: value.serverId, revoked: value.revoked };
}

// PM2 inventory (ADR-016) — read-only. Every field is validated; unknown values are rejected, never rendered as HTML.
export const PROCESS_STATUSES = ['online', 'stopping', 'stopped', 'launching', 'errored', 'one-launch-status', 'waiting restart', 'unknown'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];
export type InventoryState = 'not_reported' | 'current' | 'stale' | 'unavailable';

export interface ApplicationItem {
  key: string;
  serverId: string;
  serverName: string;
  serverStatus: ServerStatus;
  source: string;
  pmId: number;
  name: string;
  status: ProcessStatus;
  uptimeSeconds: number | null;
  restarts: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  execMode: 'fork' | 'cluster' | null;
  firstSeenAt: string;
  inventoryState: Exclude<InventoryState, 'not_reported'>;
  capturedAt: string | null;
  collectedAt: string | null;
}

export interface ApplicationPage {
  items: ApplicationItem[];
  nextCursor: string | null;
  freshWindowSeconds: number;
}

export interface InventoryInfo {
  state: InventoryState;
  reason: string | null;
  source: string | null;
  capturedAt: string | null;
  collectedAt: string | null;
  reportedAt: string | null;
  processCount: number | null;
}

export interface ServerApplications {
  serverId: string;
  serverStatus: ServerStatus;
  inventory: InventoryInfo;
  items: ApplicationItem[];
  freshWindowSeconds: number;
}

const isServerStatus = (v: unknown): v is ServerStatus => v === 'online' || v === 'offline' || v === 'never_connected';
const isNullableDate = (v: unknown): v is string | null => v === null || isDate(v);
const isNullableCount = (v: unknown, max: number): v is number | null => v === null || isCount(v, max);

function parseApplicationItem(value: unknown): ApplicationItem {
  expect(isObject(value));
  const v = value;
  expect(isString(v.key, 200) && isString(v.serverId, 36) && UUID_RE.test(v.serverId) && isString(v.serverName, 100) && isServerStatus(v.serverStatus));
  expect(isString(v.source, 64) && typeof v.pmId === 'number' && Number.isInteger(v.pmId) && isCount(v.pmId, 1_000_000));
  expect(isString(v.name, 128) && v.name.length > 0 && (PROCESS_STATUSES as readonly unknown[]).includes(v.status));
  expect(isNullableCount(v.uptimeSeconds, 315_576_000) && isNullableCount(v.restarts, 1_000_000_000));
  expect(isNullableCount(v.cpuPercent, 10_000) && isNullableCount(v.memoryBytes, 2 ** 50));
  expect(v.execMode === null || v.execMode === 'fork' || v.execMode === 'cluster');
  expect(isDate(v.firstSeenAt) && (v.inventoryState === 'current' || v.inventoryState === 'stale' || v.inventoryState === 'unavailable'));
  expect(isNullableDate(v.capturedAt) && isNullableDate(v.collectedAt));
  return {
    key: v.key, serverId: v.serverId, serverName: v.serverName, serverStatus: v.serverStatus, source: v.source, pmId: v.pmId, name: v.name,
    status: v.status as ProcessStatus, uptimeSeconds: v.uptimeSeconds, restarts: v.restarts, cpuPercent: v.cpuPercent, memoryBytes: v.memoryBytes,
    execMode: v.execMode, firstSeenAt: v.firstSeenAt, inventoryState: v.inventoryState, capturedAt: v.capturedAt, collectedAt: v.collectedAt,
  };
}

export function parseApplicationPage(value: unknown): ApplicationPage {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 100);
  expect(isNullableString(value.nextCursor) && isCount(value.freshWindowSeconds, 3600));
  return { items: value.items.map(parseApplicationItem), nextCursor: value.nextCursor, freshWindowSeconds: value.freshWindowSeconds };
}

export function parseServerApplications(value: unknown): ServerApplications {
  expect(isObject(value) && isObject(value.inventory) && Array.isArray(value.items) && value.items.length <= 500);
  const { serverId, serverStatus, inventory: i, freshWindowSeconds } = value;
  expect(isString(serverId, 36) && UUID_RE.test(serverId) && isServerStatus(serverStatus) && isCount(freshWindowSeconds, 3600));
  expect(i.state === 'not_reported' || i.state === 'current' || i.state === 'stale' || i.state === 'unavailable');
  expect((i.reason === null || (isString(i.reason, 40) && /^[a-z_]+$/.test(i.reason))) && (i.source === null || isString(i.source, 64)));
  expect(isNullableDate(i.capturedAt) && isNullableDate(i.collectedAt) && isNullableDate(i.reportedAt) && isNullableCount(i.processCount, 500));
  const items = value.items.map(parseApplicationItem);
  expect(items.every((item) => item.serverId === serverId));
  return {
    serverId, serverStatus, freshWindowSeconds, items,
    inventory: {
      state: i.state, reason: i.reason, source: i.source, capturedAt: i.capturedAt, collectedAt: i.collectedAt,
      reportedAt: i.reportedAt, processCount: i.processCount,
    },
  };
}

// PM2 process control (ADR-017). Commands carry only a target key and an action from a fixed enum.
export const CONTROL_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export const MATCH_STATUSES = ['ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const COMMAND_STATUSES = ['queued', 'dispatched', 'succeeded', 'failed', 'rejected', 'expired', 'unknown'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
export const FINAL_COMMAND_STATUSES: readonly CommandStatus[] = ['succeeded', 'failed', 'rejected', 'expired', 'unknown'];

export interface ControlTarget { targetKey: string; name: string; pmId: number | null; actions: ControlAction[]; matchStatus: MatchStatus }
export interface ControlView {
  serverId: string;
  enabled: boolean;
  serverStatus: ServerStatus;
  broker: { state: 'ok' | 'unavailable'; daemon: string | null; allowlist: string | null; reportedAt: string; fresh: boolean } | null;
  targets: ControlTarget[];
  targetFreshSeconds: number;
}
export interface CommandView {
  id: string; serverId: string; targetKey: string; action: ControlAction; status: CommandStatus; reason: string | null;
  requestedBy: string; requestedAt: string; deadlineAt: string; dispatchedAt: string | null; completedAt: string | null;
  attempts: number; before: { status: string } | null; after: { status: string } | null;
}

const TARGET_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASON_RE = /^[a-z_]{1,40}$/;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);
const isActions = (v: unknown): v is ControlAction[] => Array.isArray(v) && v.length >= 1 && v.length <= 3 && v.every((a) => oneOf(CONTROL_ACTIONS, a));
const isState = (v: unknown): v is { status: string } | null => v === null || (isObject(v) && isString(v.status, 32) && Object.keys(v).length === 1);

function parseTarget(v: unknown): ControlTarget {
  expect(isObject(v));
  const { targetKey, name, pmId, actions, matchStatus } = v;
  expect(isString(targetKey, 64) && TARGET_KEY_RE.test(targetKey) && isString(name, 128) && name.length > 0 && isActions(actions) && oneOf(MATCH_STATUSES, matchStatus));
  expect(pmId === null || (typeof pmId === 'number' && Number.isInteger(pmId) && isCount(pmId, 1_000_000)));
  return { targetKey, name, pmId, actions, matchStatus };
}

export function parseControlView(value: unknown): ControlView {
  expect(isObject(value) && Array.isArray(value.targets) && value.targets.length <= 50);
  const { serverId, enabled, serverStatus, broker, targetFreshSeconds } = value;
  expect(isString(serverId, 36) && UUID_RE.test(serverId) && typeof enabled === 'boolean' && isServerStatus(serverStatus) && isCount(targetFreshSeconds, 3600));
  let b: ControlView['broker'] = null;
  if (broker !== null) {
    expect(isObject(broker) && (broker.state === 'ok' || broker.state === 'unavailable') && isDate(broker.reportedAt) && typeof broker.fresh === 'boolean');
    expect((broker.daemon === null || isString(broker.daemon, 16)) && (broker.allowlist === null || isString(broker.allowlist, 16)));
    b = { state: broker.state, daemon: broker.daemon, allowlist: broker.allowlist, reportedAt: broker.reportedAt, fresh: broker.fresh };
  }
  return { serverId, enabled, serverStatus, broker: b, targets: value.targets.map(parseTarget), targetFreshSeconds };
}

export function parseCommandView(value: unknown): CommandView {
  expect(isObject(value));
  const v = value;
  expect(isString(v.id, 36) && UUID_RE.test(v.id) && isString(v.serverId, 36) && UUID_RE.test(v.serverId) && isString(v.requestedBy, 36));
  expect(isString(v.targetKey, 64) && TARGET_KEY_RE.test(v.targetKey) && oneOf(CONTROL_ACTIONS, v.action) && oneOf(COMMAND_STATUSES, v.status));
  expect(v.reason === null || (isString(v.reason, 40) && REASON_RE.test(v.reason)));
  expect(isDate(v.requestedAt) && isDate(v.deadlineAt) && isNullableDate(v.dispatchedAt) && isNullableDate(v.completedAt) && isCount(v.attempts, 3));
  expect(isState(v.before) && isState(v.after));
  return {
    id: v.id, serverId: v.serverId, targetKey: v.targetKey, action: v.action, status: v.status, reason: v.reason, requestedBy: v.requestedBy,
    requestedAt: v.requestedAt, deadlineAt: v.deadlineAt, dispatchedAt: v.dispatchedAt, completedAt: v.completedAt, attempts: v.attempts,
    before: v.before, after: v.after,
  };
}

export function parseCommandList(value: unknown): CommandView[] {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 50);
  return value.items.map(parseCommandView);
}

// Bounded log viewing (ADR-018). Text is shown as plain React text only; never stored.
export const LOG_STREAM_STATES = ['ok', 'empty', 'missing', 'unavailable', 'merged'] as const;
export type LogsSupport = 'supported' | 'not_connected' | 'unsupported' | 'broker_unavailable';
export interface LogTarget { targetKey: string; name: string; pmId: number | null; matchStatus: MatchStatus }
export interface LogTargetsView { serverId: string; state: LogsSupport; reportedAt: string | null; targets: LogTarget[] }
export interface LogStream { state: (typeof LOG_STREAM_STATES)[number]; text: string; lines: number; truncated: boolean; sizeBytes: number | null; modifiedAt: string | null }
export interface LogResult { outcome: 'ok' | 'rejected' | 'failed'; reason: string | null; readAt: string; stdout: LogStream | null; stderr: LogStream | null }
export interface LogRequestView { requestId: string; serverId: string; targetKey: string; status: 'pending' | 'done' | 'expired'; deadlineAt: string; result: LogResult | null }

function parseLogStream(v: unknown): LogStream | null {
  if (v === null) return null;
  expect(isObject(v) && oneOf(LOG_STREAM_STATES, v.state) && typeof v.text === 'string' && v.text.length <= 16_384 && typeof v.truncated === 'boolean');
  expect(typeof v.lines === 'number' && Number.isInteger(v.lines) && isCount(v.lines, 100));
  expect((v.sizeBytes === null || isCount(v.sizeBytes, Number.MAX_SAFE_INTEGER)) && isNullableDate(v.modifiedAt));
  return { state: v.state, text: v.text, lines: v.lines, truncated: v.truncated, sizeBytes: v.sizeBytes, modifiedAt: v.modifiedAt };
}

export function parseLogTargets(value: unknown): LogTargetsView {
  expect(isObject(value) && Array.isArray(value.targets) && value.targets.length <= 50);
  const { serverId, state, reportedAt } = value;
  expect(isString(serverId, 36) && UUID_RE.test(serverId) && oneOf(['supported', 'not_connected', 'unsupported', 'broker_unavailable'] as const, state) && isNullableDate(reportedAt));
  const targets = value.targets.map((t: unknown) => {
    expect(isObject(t) && isString(t.targetKey, 64) && TARGET_KEY_RE.test(t.targetKey) && isString(t.name, 128) && t.name.length > 0 && oneOf(MATCH_STATUSES, t.matchStatus));
    expect(t.pmId === null || (typeof t.pmId === 'number' && Number.isInteger(t.pmId) && isCount(t.pmId, 1_000_000)));
    return { targetKey: t.targetKey, name: t.name, pmId: t.pmId, matchStatus: t.matchStatus };
  });
  return { serverId, state, reportedAt, targets };
}

export function parseLogRequestCreated(value: unknown): { requestId: string; deadlineAt: string } {
  expect(isObject(value) && isString(value.requestId, 36) && UUID_RE.test(value.requestId) && isDate(value.deadlineAt));
  return { requestId: value.requestId, deadlineAt: value.deadlineAt };
}

export function parseLogRequestView(value: unknown): LogRequestView {
  expect(isObject(value) && isString(value.requestId, 36) && UUID_RE.test(value.requestId) && isString(value.serverId, 36) && UUID_RE.test(value.serverId));
  expect(isString(value.targetKey, 64) && TARGET_KEY_RE.test(value.targetKey) && oneOf(['pending', 'done', 'expired'] as const, value.status) && isDate(value.deadlineAt));
  let result: LogResult | null = null;
  if (value.result !== null) {
    const r = value.result;
    expect(isObject(r) && oneOf(['ok', 'rejected', 'failed'] as const, r.outcome) && (r.reason === null || (isString(r.reason, 40) && REASON_RE.test(r.reason))) && isDate(r.readAt));
    result = { outcome: r.outcome, reason: r.reason, readAt: r.readAt, stdout: parseLogStream(r.stdout), stderr: parseLogStream(r.stderr) };
  }
  return { requestId: value.requestId, serverId: value.serverId, targetKey: value.targetKey, status: value.status, deadlineAt: value.deadlineAt, result };
}
