// Runtime validation of API responses (ADR-012). The backend contract is in README / ADR-011; anything that
// does not match exactly is treated as an unexpected response instead of being trusted by the UI.

export const KNOWN_PERMISSIONS = ['monitoring:read', 'processes:control', 'users:manage', 'audit:read'] as const;
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
  details: { reason?: string; permission?: string; route?: string };
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

const DETAIL_KEYS = ['reason', 'permission', 'route'] as const;

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
  return { id, occurredAt, event, outcome, actorUserId, requestId, details: safeDetails };
}

export function parseAuditPage(value: unknown): AuditPage {
  expect(isObject(value) && Array.isArray(value.items) && value.items.length <= 100);
  expect(isNullableString(value.nextBeforeId));
  return { items: value.items.map(parseAuditItem), nextBeforeId: value.nextBeforeId };
}
