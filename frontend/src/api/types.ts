// Runtime validation of API responses (ADR-012). The backend contract is in README / ADR-011; anything that
// does not match exactly is treated as an unexpected response instead of being trusted by the UI.

export const KNOWN_PERMISSIONS = ['monitoring:read', 'processes:control', 'users:manage', 'servers:manage', 'audit:read'] as const;
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
  details: { reason?: string; permission?: string; route?: string; serverId?: string; rotated?: boolean; revoked?: boolean };
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

const DETAIL_KEYS = ['reason', 'permission', 'route', 'serverId'] as const;
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
