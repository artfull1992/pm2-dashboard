// Runtime validation of API responses (ADR-012). The backend contract is in README / ADR-011; anything that
// does not match exactly is treated as an unexpected response instead of being trusted by the UI.

export const KNOWN_PERMISSIONS = ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read', 'logs:read', 'alerts:manage'] as const;
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
  details: {
    reason?: string; permission?: string; route?: string; serverId?: string; targetKey?: string; commandId?: string; action?: string;
    targetUserId?: string; role?: string; fromRole?: string; toRole?: string; rotated?: boolean; revoked?: boolean; sessionsRevoked?: number;
  };
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

const DETAIL_KEYS = ['reason', 'permission', 'route', 'serverId', 'targetKey', 'commandId', 'action', 'targetUserId', 'role', 'fromRole', 'toRole'] as const;
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
  if (details.sessionsRevoked !== undefined) {
    expect(typeof details.sessionsRevoked === 'number' && Number.isInteger(details.sessionsRevoked) && details.sessionsRevoked >= 0);
    safeDetails.sessionsRevoked = details.sessionsRevoked;
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
  /** null: not in the stored snapshot (minimal snapshot of ADR-023 — rollback compatibility); unknown, never 0. */
  uptimeSeconds: number | null;
  cpuCount: number | null;
  loadAverage: [number, number, number];
  memory: { totalBytes: number; freeBytes: number } | null;
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
  expect(isObject(value) && Array.isArray(value.loadAverage) && value.loadAverage.length === 3);
  const { agentVersion, hostname, platform, arch, uptimeSeconds, cpuCount, loadAverage, memory } = value;
  expect(isString(agentVersion, 16) && isString(hostname, 253) && isString(platform, 16) && isString(arch, 16));
  expect((loadAverage as unknown[]).every((n) => isCount(n, 100_000)));
  // Host metrics are optional (minimal snapshots, ADR-023): when present they are validated as before.
  expect((uptimeSeconds === undefined || isCount(uptimeSeconds, 1e10)) && (cpuCount === undefined || isCount(cpuCount, 4096)));
  let mem: ServerSnapshot['memory'] = null;
  if (memory !== undefined) {
    expect(isObject(memory));
    const { totalBytes, freeBytes } = memory;
    expect(isCount(totalBytes, Number.MAX_SAFE_INTEGER) && isCount(freeBytes, Number.MAX_SAFE_INTEGER) && freeBytes <= totalBytes);
    mem = { totalBytes, freeBytes };
  }
  const [l1, l5, l15] = loadAverage as [number, number, number];
  return { agentVersion, hostname, platform, arch, uptimeSeconds: uptimeSeconds ?? null, cpuCount: cpuCount ?? null, loadAverage: [l1, l5, l15], memory: mem };
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

// --- Users (Task 011, ADR-019) -----------------------------------------------------------------------------------

export interface UserView { id: string; email: string; role: Role; isActive: boolean; createdAt: string; updatedAt: string }
export interface UserPage { items: UserView[]; nextAfter: string | null }

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly the public fields — a response carrying anything else (e.g. a hash) is a contract violation. */
export function parseUserView(value: unknown): UserView {
  expect(isObject(value));
  expect(Object.keys(value).sort().join(',') === 'createdAt,email,id,isActive,role,updatedAt');
  const { id, email, role, isActive, createdAt, updatedAt } = value;
  expect(isString(id, 36) && USER_ID_RE.test(id) && isString(email, 254) && (KNOWN_ROLES as readonly unknown[]).includes(role));
  expect(typeof isActive === 'boolean' && isDate(createdAt) && isDate(updatedAt));
  return { id, email, role: role as Role, isActive, createdAt, updatedAt };
}

export function parseUserPage(value: unknown): UserPage {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 100);
  expect(value.nextAfter === null || (isString(value.nextAfter, 36) && USER_ID_RE.test(value.nextAfter)));
  return { items: value.items.map(parseUserView), nextAfter: value.nextAfter };
}

// --- Dashboard (Task 012, ADR-020) -------------------------------------------------------------------------------

export type InventoryStateAll = 'current' | 'stale' | 'unavailable' | 'not_reported';
export type AttentionReason = 'offline' | 'never_connected' | 'inventory_unavailable' | 'inventory_stale' | 'inventory_not_reported';
interface Bounded<T> { items: T[]; total: number; limit: number }

export interface DashboardServer {
  id: string; name: string; status: ServerStatus; lastSeenAt: string | null;
  metrics: { hostname: string; uptimeSeconds: number | null; cpuCount: number | null; loadAverage: [number, number, number]; memory: { totalBytes: number; usedBytes: number; usedPercent: number | null } | null } | null;
  inventory: { state: InventoryStateAll; collectedAt: string | null };
  processes: { total: number; online: number; problem: number } | null;
}
export interface RecentAction {
  id: string; serverId: string; serverName: string; targetKey: string; action: ControlAction; status: CommandView['status']; reason: string | null;
  requestedAt: string; completedAt: string | null; requestedByMe: boolean; overdue: boolean;
}
export interface DashboardView {
  generatedAt: string;
  windows: { onlineSeconds: number; inventoryFreshSeconds: number };
  servers: { total: number; inactive: number; active: number; online: number; offline: number; neverConnected: number };
  inventory: { current: number; stale: number; unavailable: number; notReported: number };
  processes: { live: { total: number; online: number; problem: number; transitional: number }; notLive: number };
  attentionServers: Bounded<{ id: string; name: string; status: ServerStatus; reason: AttentionReason; lastSeenAt: string | null; inventoryCollectedAt: string | null }>;
  attentionProcesses: Bounded<{ serverId: string; serverName: string; pmId: number; name: string; status: ProcessStatus; restarts: number | null; uptimeSeconds: number | null }>;
  serverList: Bounded<DashboardServer>;
  recentActions: { items: RecentAction[]; limit: number } | null;
}

const DASH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVENTORY_STATES_ALL = ['current', 'stale', 'unavailable', 'not_reported'] as const;
const ATTENTION_REASONS = ['offline', 'never_connected', 'inventory_unavailable', 'inventory_stale', 'inventory_not_reported'] as const;
const COMMAND_STATUSES_ALL = ['queued', 'dispatched', 'succeeded', 'failed', 'rejected', 'expired', 'unknown'] as const;
const isId = (v: unknown): v is string => typeof v === 'string' && DASH_UUID.test(v);
const isName = (v: unknown): v is string => isString(v, 253) && v.length > 0;
const isNum = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
function counts<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> {
  expect(isObject(v) && Object.keys(v).length === keys.length);
  const out = {} as Record<K, number>;
  for (const k of keys) { const n = v[k]; expect(isNum(n) && Number.isInteger(n)); out[k] = n; }
  return out;
}
function bounded<T>(v: unknown, item: (x: unknown) => T, max: number): Bounded<T> {
  expect(isObject(v) && Array.isArray(v.items) && v.items.length <= max && isNum(v.total) && isNum(v.limit) && v.items.length <= v.total);
  return { items: v.items.map(item), total: v.total, limit: v.limit };
}

function parseDashboardServer(v: unknown): DashboardServer {
  expect(isObject(v) && isId(v.id) && isName(v.name) && isServerStatus(v.status) && isNullableDate(v.lastSeenAt));
  expect(isObject(v.inventory) && oneOf(INVENTORY_STATES_ALL, v.inventory.state) && isNullableDate(v.inventory.collectedAt));
  let metrics: DashboardServer['metrics'] = null;
  if (v.metrics !== null) {
    const m = v.metrics;
    expect(isObject(m) && isName(m.hostname) && (m.uptimeSeconds === null || isNum(m.uptimeSeconds)) && (m.cpuCount === null || isNum(m.cpuCount, 4096)) && Array.isArray(m.loadAverage) && m.loadAverage.length === 3 && m.loadAverage.every((x) => isNum(x)));
    let memory: NonNullable<DashboardServer['metrics']>['memory'] = null;
    if (m.memory !== null) {
      expect(isObject(m.memory) && isNum(m.memory.totalBytes) && isNum(m.memory.usedBytes) && (m.memory.usedPercent === null || isNum(m.memory.usedPercent, 100)));
      memory = { totalBytes: m.memory.totalBytes, usedBytes: m.memory.usedBytes, usedPercent: m.memory.usedPercent };
    }
    const [a, b, c] = m.loadAverage as [number, number, number];
    metrics = { hostname: m.hostname, uptimeSeconds: m.uptimeSeconds, cpuCount: m.cpuCount, loadAverage: [a, b, c], memory };
  }
  const processes = v.processes === null ? null : counts(v.processes, ['total', 'online', 'problem'] as const);
  return { id: v.id, name: v.name, status: v.status, lastSeenAt: v.lastSeenAt, metrics, inventory: { state: v.inventory.state, collectedAt: v.inventory.collectedAt }, processes };
}

/** Strict: unknown statuses, out-of-range numbers or oversized lists are a contract violation (nothing is guessed). */
export function parseDashboard(value: unknown): DashboardView {
  expect(isObject(value) && isDate(value.generatedAt));
  const windows = counts(value.windows, ['onlineSeconds', 'inventoryFreshSeconds'] as const);
  const servers = counts(value.servers, ['total', 'inactive', 'active', 'online', 'offline', 'neverConnected'] as const);
  const inventory = counts(value.inventory, ['current', 'stale', 'unavailable', 'notReported'] as const);
  expect(isObject(value.processes) && Object.keys(value.processes).length === 2 && isNum(value.processes.notLive));
  const processes = { live: counts(value.processes.live, ['total', 'online', 'problem', 'transitional'] as const), notLive: value.processes.notLive };
  const attentionServers = bounded(value.attentionServers, (x) => {
    expect(isObject(x) && isId(x.id) && isName(x.name) && isServerStatus(x.status) && oneOf(ATTENTION_REASONS, x.reason) && isNullableDate(x.lastSeenAt) && isNullableDate(x.inventoryCollectedAt));
    return { id: x.id, name: x.name, status: x.status, reason: x.reason, lastSeenAt: x.lastSeenAt, inventoryCollectedAt: x.inventoryCollectedAt };
  }, 100);
  const attentionProcesses = bounded(value.attentionProcesses, (x) => {
    expect(isObject(x) && isId(x.serverId) && isName(x.serverName) && isNum(x.pmId) && isString(x.name, 128) && oneOf(PROCESS_STATUSES, x.status));
    expect((x.restarts === null || isNum(x.restarts)) && (x.uptimeSeconds === null || isNum(x.uptimeSeconds)));
    return { serverId: x.serverId, serverName: x.serverName, pmId: x.pmId, name: x.name, status: x.status, restarts: x.restarts, uptimeSeconds: x.uptimeSeconds };
  }, 100);
  const serverList = bounded(value.serverList, parseDashboardServer, 100);
  let recentActions: DashboardView['recentActions'] = null;
  if (value.recentActions !== null) {
    const r = value.recentActions;
    expect(isObject(r) && Array.isArray(r.items) && r.items.length <= 50 && isNum(r.limit));
    recentActions = {
      limit: r.limit,
      items: r.items.map((x: unknown) => {
        expect(isObject(x) && isId(x.id) && isId(x.serverId) && isName(x.serverName) && isString(x.targetKey, 64) && oneOf(CONTROL_ACTIONS, x.action) && oneOf(COMMAND_STATUSES_ALL, x.status));
        expect(isNullableString(x.reason) && isDate(x.requestedAt) && isNullableDate(x.completedAt) && typeof x.requestedByMe === 'boolean' && typeof x.overdue === 'boolean');
        return { id: x.id, serverId: x.serverId, serverName: x.serverName, targetKey: x.targetKey, action: x.action, status: x.status, reason: x.reason, requestedAt: x.requestedAt, completedAt: x.completedAt, requestedByMe: x.requestedByMe, overdue: x.overdue };
      }),
    };
  }
  return { generatedAt: value.generatedAt, windows, servers, inventory, processes, attentionServers, attentionProcesses, serverList, recentActions };
}

// --- Alerts (Task 013, ADR-021) ----------------------------------------------------------------------------------

export const ALERT_RULES = ['server_offline', 'inventory_stale', 'process_down', 'process_cpu', 'server_memory', 'process_restarts'] as const;
export type AlertRule = (typeof ALERT_RULES)[number];
export const OUTBOX_STATES = ['none', 'queued', 'sending', 'sent', 'failed', 'unknown', 'dropped'] as const;
export interface Incident {
  /** retired: the rule was taken out of service (ADR-023 migration) — not a recovery. */
  id: string; rule: AlertRule; severity: 'critical' | 'warning'; status: 'firing' | 'resolved'; resolution: 'recovered' | 'process_gone' | 'excluded' | 'retired' | null;
  serverId: string; serverName: string; serverStatus: ServerStatus | 'inactive'; processName: string | null; pmId: number | null;
  detail: { value?: number | null; threshold?: number | null; status?: string; state?: string; lastSeenAt?: string | null; delta?: number; spanSeconds?: number; windowSeconds?: number };
  openedAt: string; lastObservedAt: string; resolvedAt: string | null;
  notification: { notify: boolean; state: (typeof OUTBOX_STATES)[number]; attempts: number; lastError: string | null } | null;
}
export interface IncidentPage { items: Incident[]; nextBefore: string | null }
export interface AlertsStatus {
  engine: { enabled: boolean; running: boolean; lastEvaluationAt: string | null; lastEvaluationOk: boolean | null };
  delivery: { enabled: boolean };
  activeCount: number;
  admin: {
    webhookConfigured: boolean; publicUrlConfigured: boolean; intervalSeconds: number; cooldownMinutes: number; reminderMinutes: number; maxAttempts: number; queueMax: number;
    thresholds: Record<'cpuOpenPercent' | 'cpuClosePercent' | 'memoryOpenPercent' | 'memoryClosePercent' | 'confirmSamples' | 'recoverSamples' | 'statusConfirmSamples' | 'restartsThreshold' | 'restartsWindowMinutes', number>;
    queue: Record<'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'dropped', number>;
    lastSentAt: string | null; lastDeliveryError: string | null; lastEvaluationError: string | null;
  } | null;
}

const INCIDENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nullableNum = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const nullableBool = (v: unknown): v is boolean | null => v === null || typeof v === 'boolean';

function parseIncident(v: unknown): Incident {
  expect(isObject(v) && isString(v.id, 36) && INCIDENT_UUID.test(v.id) && oneOf(ALERT_RULES, v.rule) && (v.severity === 'critical' || v.severity === 'warning'));
  expect((v.status === 'firing' || v.status === 'resolved') && (v.resolution === null || v.resolution === 'recovered' || v.resolution === 'process_gone' || v.resolution === 'excluded' || v.resolution === 'retired'));
  expect(isString(v.serverId, 36) && INCIDENT_UUID.test(v.serverId) && isString(v.serverName, 100) && (isServerStatus(v.serverStatus) || v.serverStatus === 'inactive'));
  expect(isNullableString(v.processName) && (v.pmId === null || (typeof v.pmId === 'number' && Number.isInteger(v.pmId))));
  expect(isDate(v.openedAt) && isDate(v.lastObservedAt) && isNullableDate(v.resolvedAt) && isObject(v.detail));
  const d = v.detail;
  const detail: Incident['detail'] = {};
  for (const k of ['value', 'threshold'] as const) if (d[k] !== undefined) { const x = d[k]; expect(nullableNum(x)); detail[k] = x; }
  for (const k of ['delta', 'spanSeconds', 'windowSeconds'] as const) if (d[k] !== undefined) { const x = d[k]; expect(typeof x === 'number' && Number.isFinite(x)); detail[k] = x; }
  for (const k of ['status', 'state'] as const) if (d[k] !== undefined) { const x = d[k]; expect(isString(x, 40)); detail[k] = x; }
  if (d.lastSeenAt !== undefined) { expect(isNullableDate(d.lastSeenAt)); detail.lastSeenAt = d.lastSeenAt; }
  let notification: Incident['notification'] = null;
  if (v.notification !== null) {
    const n = v.notification;
    expect(isObject(n) && typeof n.notify === 'boolean' && oneOf(OUTBOX_STATES, n.state) && isCount(n.attempts, 100) && isNullableString(n.lastError));
    notification = { notify: n.notify, state: n.state, attempts: n.attempts, lastError: n.lastError };
  }
  return {
    id: v.id, rule: v.rule, severity: v.severity, status: v.status, resolution: v.resolution, serverId: v.serverId, serverName: v.serverName, serverStatus: v.serverStatus,
    processName: v.processName, pmId: v.pmId, detail, openedAt: v.openedAt, lastObservedAt: v.lastObservedAt, resolvedAt: v.resolvedAt, notification,
  };
}

export function parseIncidentPage(value: unknown): IncidentPage {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 100 && (value.nextBefore === null || (isString(value.nextBefore, 36) && INCIDENT_UUID.test(value.nextBefore))));
  return { items: value.items.map(parseIncident), nextBefore: value.nextBefore };
}

export function parseAlertsStatus(value: unknown): AlertsStatus {
  expect(isObject(value) && isObject(value.engine) && isObject(value.delivery) && isCount(value.activeCount, 1_000_000));
  const e = value.engine;
  expect(typeof e.enabled === 'boolean' && typeof e.running === 'boolean' && isNullableDate(e.lastEvaluationAt) && nullableBool(e.lastEvaluationOk) && typeof value.delivery.enabled === 'boolean');
  let admin: AlertsStatus['admin'] = null;
  if (value.admin !== null) {
    const a = value.admin;
    expect(isObject(a) && typeof a.webhookConfigured === 'boolean' && typeof a.publicUrlConfigured === 'boolean' && !('webhookUrl' in a));
    const numbers = (o: unknown, keys: readonly string[]) => {
      expect(isObject(o));
      const out: Record<string, number> = {};
      for (const k of keys) { const x = o[k]; expect(isCount(x, 10_000_000)); out[k] = x; }
      return out;
    };
    const top = numbers(a, ['intervalSeconds', 'cooldownMinutes', 'reminderMinutes', 'maxAttempts', 'queueMax']);
    expect(isNullableDate(a.lastSentAt) && isNullableString(a.lastDeliveryError) && isNullableString(a.lastEvaluationError));
    admin = {
      webhookConfigured: a.webhookConfigured, publicUrlConfigured: a.publicUrlConfigured,
      intervalSeconds: top.intervalSeconds ?? 0, cooldownMinutes: top.cooldownMinutes ?? 0, reminderMinutes: top.reminderMinutes ?? 0, maxAttempts: top.maxAttempts ?? 0, queueMax: top.queueMax ?? 0,
      thresholds: numbers(a.thresholds, ['cpuOpenPercent', 'cpuClosePercent', 'memoryOpenPercent', 'memoryClosePercent', 'confirmSamples', 'recoverSamples', 'statusConfirmSamples', 'restartsThreshold', 'restartsWindowMinutes']),
      queue: numbers(a.queue, ['queued', 'sending', 'sent', 'failed', 'unknown', 'dropped']),
      lastSentAt: a.lastSentAt, lastDeliveryError: a.lastDeliveryError, lastEvaluationError: a.lastEvaluationError,
    };
  }
  return { engine: { enabled: e.enabled, running: e.running, lastEvaluationAt: e.lastEvaluationAt, lastEvaluationOk: e.lastEvaluationOk }, delivery: { enabled: value.delivery.enabled }, activeCount: value.activeCount, admin };
}

// --- Alert settings & Slack integration (Task 013.1, ADR-022) ----------------------------------------------------

export const RULE_FIELDS = ['cpuOpenPercent', 'cpuClosePercent', 'memoryOpenPercent', 'memoryClosePercent', 'confirmSamples', 'recoverSamples', 'statusConfirmSamples', 'restartsThreshold', 'restartsWindowMinutes'] as const;
export const TIMING_FIELDS = ['intervalSeconds', 'cooldownMinutes', 'reminderMinutes'] as const;
export const ADVANCED_FIELDS = ['httpTimeoutMs', 'maxAttempts', 'queueMax'] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export type TimingField = (typeof TIMING_FIELDS)[number];
export type AdvancedField = (typeof ADVANCED_FIELDS)[number];
const QUEUE_FIELDS = ['queued', 'sending', 'sent', 'failed', 'unknown', 'dropped', 'cancelled'] as const;

export interface SettingsView {
  revision: number; updatedAt: string; engineEnabled: boolean; deliveryEnabled: boolean;
  rules: Record<RuleField, number>; timing: Record<TimingField, number> & { reminderEnabled: boolean }; advanced: Record<AdvancedField, number>;
  ranges: Record<RuleField | TimingField | AdvancedField, { min: number; max: number; default: number }>;
  slack: {
    state: 'not_configured' | 'configured' | 'error'; error: 'key_missing' | 'key_version_mismatch' | 'decrypt_failed' | null; generation: number;
    configuredAt: string | null; keyAvailable: boolean; lastTest: { outcome: 'success' | 'failed' | 'unknown'; code: string | null; at: string } | null;
  };
  queue: Record<(typeof QUEUE_FIELDS)[number], number>;
  publicUrlConfigured: boolean;
}
export interface SlackTestResult { operationId: string; generation: number; outcome: 'success' | 'failed' | 'unknown'; code: string | null; at: string; stored: boolean }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000;
function ints<K extends string>(v: unknown, keys: readonly K[]): Record<K, number> {
  expect(isObject(v));
  const out = {} as Record<K, number>;
  for (const k of keys) { const x = v[k]; expect(isInt(x)); out[k] = x; }
  return out;
}
const SAFE_CODE = /^[a-z0-9_]{1,40}$/;

/** Strict: anything that looks like a secret (a URL, a "webhook" field) is a contract violation, never displayed. */
export function parseSettingsView(value: unknown): SettingsView {
  expect(isObject(value) && !JSON.stringify(value).includes('hooks.slack.com'));
  const { revision, updatedAt, engineEnabled, deliveryEnabled, slack, ranges } = value;
  expect(isInt(revision) && isDate(updatedAt) && typeof engineEnabled === 'boolean' && typeof deliveryEnabled === 'boolean' && typeof value.publicUrlConfigured === 'boolean');
  expect(isObject(value.timing) && typeof value.timing.reminderEnabled === 'boolean');
  expect(isObject(ranges) && isObject(slack));
  const allFields = [...RULE_FIELDS, ...TIMING_FIELDS, ...ADVANCED_FIELDS] as const;
  const r = {} as SettingsView['ranges'];
  for (const k of allFields) { const x = ranges[k]; expect(isObject(x)); const v = ints(x, ['min', 'max', 'default'] as const); r[k] = v; }
  expect(slack.state === 'not_configured' || slack.state === 'configured' || slack.state === 'error');
  expect(slack.error === null || slack.error === 'key_missing' || slack.error === 'key_version_mismatch' || slack.error === 'decrypt_failed');
  expect(isInt(slack.generation) && isNullableDate(slack.configuredAt) && typeof slack.keyAvailable === 'boolean' && !('webhookUrl' in slack));
  let lastTest: SettingsView['slack']['lastTest'] = null;
  if (slack.lastTest !== null) {
    const t = slack.lastTest;
    expect(isObject(t) && (t.outcome === 'success' || t.outcome === 'failed' || t.outcome === 'unknown') && (t.code === null || (isString(t.code, 40) && SAFE_CODE.test(t.code))) && isDate(t.at));
    lastTest = { outcome: t.outcome, code: t.code, at: t.at };
  }
  return {
    revision, updatedAt, engineEnabled, deliveryEnabled,
    rules: ints(value.rules, RULE_FIELDS), timing: { ...ints(value.timing, TIMING_FIELDS), reminderEnabled: value.timing.reminderEnabled }, advanced: ints(value.advanced, ADVANCED_FIELDS),
    ranges: r,
    slack: { state: slack.state, error: slack.error, generation: slack.generation, configuredAt: slack.configuredAt, keyAvailable: slack.keyAvailable, lastTest },
    queue: ints(value.queue, QUEUE_FIELDS), publicUrlConfigured: value.publicUrlConfigured,
  };
}

export function parseSlackTestResult(value: unknown): SlackTestResult {
  expect(isObject(value) && isString(value.operationId, 36) && isInt(value.generation) && isDate(value.at) && typeof value.stored === 'boolean');
  expect((value.outcome === 'success' || value.outcome === 'failed' || value.outcome === 'unknown') && (value.code === null || (isString(value.code, 40) && SAFE_CODE.test(value.code))));
  return { operationId: value.operationId, generation: value.generation, outcome: value.outcome, code: value.code, at: value.at, stored: value.stored };
}
