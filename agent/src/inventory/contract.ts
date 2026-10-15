// PM2 inventory contract (ADR-016), shared by the exporter (writes the snapshot file) and the Agent (reads it and
// reports it to the API). Only the allowlisted fields below ever leave the exporter process: no env, args, paths,
// log files or other pm2_env content. Missing metrics are null — never a fabricated 0.

export const INVENTORY_FORMAT = 'node-control/pm2-inventory';
export const INVENTORY_VERSION = 1;

export const INVENTORY_LIMITS = Object.freeze({
  maxProcesses: 500,
  maxPmId: 1_000_000,
  maxNameLength: 128,
  /** 10 years: anything longer is not a believable process uptime. */
  maxUptimeSeconds: 315_576_000,
  maxRestarts: 1_000_000_000,
  /** PM2 reports CPU per process across cores, so > 100 is legitimate; 100 × 100 cores is the sanity bound. */
  maxCpuPercent: 10_000,
  /** 1 PiB. */
  maxMemoryBytes: 2 ** 50,
  /** Snapshot file size bound (exporter writes ≤ this, Agent refuses larger files). */
  maxFileBytes: 512 * 1024,
});

export const PROCESS_STATUSES = ['online', 'stopping', 'stopped', 'launching', 'errored', 'one-launch-status', 'waiting restart', 'unknown'] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];
export const EXEC_MODES = ['fork', 'cluster'] as const;
export type ExecMode = (typeof EXEC_MODES)[number];

/** Why an inventory is not available. Metadata only — never a raw PM2 error or payload. */
export const UNAVAILABLE_REASONS = [
  'daemon_not_running', 'permission_denied', 'timeout', 'protocol_error', 'invalid_data', 'too_many_processes',
  'pm2_home_invalid', 'snapshot_missing', 'snapshot_invalid', 'snapshot_insecure',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface InventoryProcess {
  pmId: number;
  name: string;
  status: ProcessStatus;
  uptimeSeconds: number | null;
  restarts: number | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  execMode: ExecMode | null;
}

/** What the exporter writes. `capturedAt` is the exporter's clock at the time of the attempt (also for failures). */
export type InventorySnapshot =
  | { format: typeof INVENTORY_FORMAT; version: 1; source: string; capturedAt: string; state: 'ok'; reason: null; processes: InventoryProcess[] }
  | { format: typeof INVENTORY_FORMAT; version: 1; source: string; capturedAt: string; state: 'unavailable'; reason: UnavailableReason; processes: [] };

export const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const nullableInt = (v: unknown, max: number) => v === null || intIn(v, 0, max);
const hasExactKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

export function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

export function isValidProcessName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= INVENTORY_LIMITS.maxNameLength && !CONTROL_RE.test(value);
}

const PROCESS_KEYS = ['pmId', 'name', 'status', 'uptimeSeconds', 'restarts', 'cpuPercent', 'memoryBytes', 'execMode'] as const;

export function isValidProcess(value: unknown): value is InventoryProcess {
  if (!isObject(value) || !hasExactKeys(value, PROCESS_KEYS)) return false;
  const L = INVENTORY_LIMITS;
  return intIn(value.pmId, 0, L.maxPmId)
    && isValidProcessName(value.name)
    && (PROCESS_STATUSES as readonly unknown[]).includes(value.status)
    && nullableInt(value.uptimeSeconds, L.maxUptimeSeconds)
    && nullableInt(value.restarts, L.maxRestarts)
    && (value.cpuPercent === null || (typeof value.cpuPercent === 'number' && Number.isFinite(value.cpuPercent) && value.cpuPercent >= 0 && value.cpuPercent <= L.maxCpuPercent))
    && nullableInt(value.memoryBytes, L.maxMemoryBytes)
    && (value.execMode === null || (EXEC_MODES as readonly unknown[]).includes(value.execMode));
}

/** Validates a full process list: bounded length, valid entries, unique pmId. */
export function isValidProcessList(value: unknown): value is InventoryProcess[] {
  if (!Array.isArray(value) || value.length > INVENTORY_LIMITS.maxProcesses) return false;
  const seen = new Set<number>();
  for (const p of value) {
    if (!isValidProcess(p) || seen.has(p.pmId)) return false;
    seen.add(p.pmId);
  }
  return true;
}

const SNAPSHOT_KEYS = ['format', 'version', 'source', 'capturedAt', 'state', 'reason', 'processes'] as const;

/** Strict parser for the snapshot file written by the exporter. Returns null for anything off-contract. */
export function parseInventorySnapshot(value: unknown): InventorySnapshot | null {
  if (!isObject(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;
  if (value.format !== INVENTORY_FORMAT || value.version !== INVENTORY_VERSION) return null;
  if (typeof value.source !== 'string' || !SOURCE_RE.test(value.source) || !isIsoUtc(value.capturedAt)) return null;
  if (value.state === 'ok') {
    if (value.reason !== null || !isValidProcessList(value.processes)) return null;
    return value as InventorySnapshot;
  }
  if (value.state === 'unavailable') {
    if (!(UNAVAILABLE_REASONS as readonly unknown[]).includes(value.reason) || !Array.isArray(value.processes) || value.processes.length !== 0) return null;
    return value as InventorySnapshot;
  }
  return null;
}
