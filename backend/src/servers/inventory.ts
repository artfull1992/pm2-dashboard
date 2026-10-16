import { createHash } from 'node:crypto';
// PM2 inventory contract on the API side (ADR-016). Mirrors agent/src/inventory/contract.ts; both are covered by
// contract tests. Static JSON schemas only (additionalProperties:false) — no dynamic keys (NC-SEC-001).

export const INVENTORY_BODY_LIMIT = 512 * 1024;
export const INVENTORY_MAX_PROCESSES = 500;
/** Suggested Agent reporting interval (Agent bounds: 30..600). */
export const INVENTORY_INTERVAL_SECONDS = 60;
/** Inventory data is `current` only if its collection (server clock) is newer than this; 3 × interval. */
export const INVENTORY_FRESH_SECONDS = 180;

export const PROCESS_STATUSES = ['online', 'stopping', 'stopped', 'launching', 'errored', 'one-launch-status', 'waiting restart', 'unknown'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];
export const UNAVAILABLE_REASONS = [
  'daemon_not_running', 'permission_denied', 'timeout', 'protocol_error', 'invalid_data', 'too_many_processes',
  'pm2_home_invalid', 'snapshot_missing', 'snapshot_invalid', 'snapshot_insecure',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export const SOURCE_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';
const ISO_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
// Control characters (C0, DEL, C1) are rejected in names; the Agent replaces them before sending.
const NAME_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f]+$';

export interface InventoryProcess {
  pmId: number;
  name: string;
  status: ProcessStatus;
  uptimeSeconds: number | null;
  restarts: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  execMode: 'fork' | 'cluster' | null;
}

export type InventoryReport =
  | { version: 1; state: 'ok'; reason: null; source: string; capturedAt: string; processes: InventoryProcess[] }
  | { version: 1; state: 'stale'; reason: null; source: string; capturedAt: string; processes: [] }
  | { version: 1; state: 'unavailable'; reason: UnavailableReason; source: string | null; capturedAt: string | null; processes: [] };

const nullableInt = (max: number) => ({ type: ['integer', 'null'], minimum: 0, maximum: max }) as const;

export const processSchema = {
  type: 'object', additionalProperties: false,
  required: ['pmId', 'name', 'status', 'uptimeSeconds', 'restarts', 'cpuPercent', 'memoryBytes', 'execMode'],
  properties: {
    pmId: { type: 'integer', minimum: 0, maximum: 1_000_000 },
    name: { type: 'string', minLength: 1, maxLength: 128, pattern: NAME_PATTERN },
    status: { type: 'string', enum: PROCESS_STATUSES },
    uptimeSeconds: nullableInt(315_576_000),
    restarts: nullableInt(1_000_000_000),
    cpuPercent: { type: ['number', 'null'], minimum: 0, maximum: 10_000 },
    memoryBytes: nullableInt(2 ** 50),
    execMode: { type: ['string', 'null'], enum: ['fork', 'cluster', null] },
  },
} as const;

export const inventoryReportSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'state', 'reason', 'source', 'capturedAt', 'processes'],
  properties: {
    version: { type: 'integer', enum: [1] },
    state: { type: 'string', enum: ['ok', 'stale', 'unavailable'] },
    reason: { type: ['string', 'null'], enum: [...UNAVAILABLE_REASONS, null] },
    source: { type: ['string', 'null'], pattern: SOURCE_PATTERN },
    capturedAt: { type: ['string', 'null'], pattern: ISO_PATTERN },
    processes: { type: 'array', maxItems: INVENTORY_MAX_PROCESSES, items: processSchema },
  },
} as const;

function isRealIso(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

/** What the JSON schema guarantees; cross-field rules are checked by toInventoryReport. */
export interface SchemaValidReport {
  version: 1;
  state: 'ok' | 'stale' | 'unavailable';
  reason: UnavailableReason | null;
  source: string | null;
  capturedAt: string | null;
  processes: InventoryProcess[];
}

/**
 * Cross-field rules the schema cannot express (real timestamp, unique pmId, state-specific shape).
 * Returns the narrowed report, or null when the report is inconsistent.
 */
export function toInventoryReport(raw: SchemaValidReport): InventoryReport | null {
  const { state, reason, source, capturedAt, processes } = raw;
  if (capturedAt !== null && !isRealIso(capturedAt)) return null;
  const seen = new Set<number>();
  for (const p of processes) {
    if (seen.has(p.pmId)) return null;
    seen.add(p.pmId);
  }
  if (state === 'ok') {
    return reason === null && source !== null && capturedAt !== null ? { version: 1, state, reason, source, capturedAt, processes } : null;
  }
  if (processes.length !== 0) return null;
  if (state === 'stale') {
    return reason === null && source !== null && capturedAt !== null ? { version: 1, state, reason, source, capturedAt, processes: [] } : null;
  }
  return reason !== null ? { version: 1, state, reason, source, capturedAt, processes: [] } : null;
}

/** Opaque keyset cursor for the global application list: base64url(JSON [name, serverId, pmId]). */
/** Keyset position; `context` (cursors issued since name search) binds it to the filters it was issued for. */
export interface ApplicationCursor { name: string; serverId: string; pmId: number; context?: string | null }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(c: ApplicationCursor): string {
  const tuple = c.context ? [c.name, c.serverId, c.pmId, c.context] : [c.name, c.serverId, c.pmId];
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

/** Short fingerprint of the list filters a cursor belongs to (not secret; only detects a cursor of another list). */
export function cursorContext(filter: { serverId: string | null; status: string | null; q: string | null }): string {
  return createHash('sha256').update(JSON.stringify([filter.serverId, filter.status, filter.q])).digest('base64url').slice(0, 12);
}

export const SEARCH_MAX_LENGTH = 128;
/** Name search: trimmed; empty → no search; null for an invalid value (too long or control characters). */
export function normalizeSearch(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const q = raw.trim();
  if (q === '') return undefined;
  let control = false;
  for (let i = 0; i < q.length; i++) { const c = q.charCodeAt(i); if (c < 0x20 || c === 0x7f) control = true; }
  if (q.length > SEARCH_MAX_LENGTH || control) return null;
  return q;
}

export function decodeCursor(value: string): ApplicationCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || (parsed.length !== 3 && parsed.length !== 4)) return null;
  const [name, serverId, pmId, context] = parsed as unknown[];
  if (parsed.length === 4 && (typeof context !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(context))) return null;
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return null;
  if (typeof serverId !== 'string' || !UUID_RE.test(serverId)) return null;
  if (typeof pmId !== 'number' || !Number.isSafeInteger(pmId) || pmId < 0 || pmId > 1_000_000) return null;
  return typeof context === 'string' ? { name, serverId, pmId, context } : { name, serverId, pmId };
}
