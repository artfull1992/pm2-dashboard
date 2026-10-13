import { type ExecMode, INVENTORY_LIMITS, type InventoryProcess, PROCESS_STATUSES, type ProcessStatus } from '../inventory/contract.js';

// Raw PM2 `getMonitorData` → allowlisted inventory (ADR-016). The raw objects carry the full pm2_env, including the
// application's environment variables; this module copies ONLY the fields named below, field by field, and never
// spreads, serialises or logs the raw object. Anything implausible becomes null rather than a made-up value.

export class InventoryDataError extends Error {
  constructor(readonly reason: 'invalid_data' | 'too_many_processes') {
    super(reason);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CLOCK_SKEW_MS = 60_000;
// eslint-disable-next-line no-control-regex -- control characters are replaced, never rendered
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT = '�';

/** Process names are user-chosen: control characters are replaced and the length is bounded. */
export function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Lone surrogates and control characters become U+FFFD; truncation is by whole code points (never splits a pair).
  const cleaned = value.replace(LONE_SURROGATE_RE, REPLACEMENT).replace(CONTROL_RE, REPLACEMENT).trim();
  let bounded = '';
  for (const ch of cleaned) {
    if (bounded.length + ch.length > INVENTORY_LIMITS.maxNameLength) break;
    bounded += ch;
  }
  return bounded.trim() || null;
}

function status(value: unknown): ProcessStatus {
  return (PROCESS_STATUSES as readonly unknown[]).includes(value) && value !== 'unknown' ? value as ProcessStatus : 'unknown';
}

function execMode(value: unknown): ExecMode | null {
  if (value === 'fork_mode') return 'fork';
  if (value === 'cluster_mode') return 'cluster';
  return null;
}

const boundedInt = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

/**
 * pm_uptime is the start timestamp (ms) PM2 recorded; it is only trusted for online processes and only when it lies
 * in the plausible past of the exporter's own clock (small skew tolerated). Otherwise the uptime is unknown.
 */
function uptimeSeconds(processStatus: ProcessStatus, startedAtMs: unknown, nowMs: number): number | null {
  if (processStatus !== 'online' || typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  if (startedAtMs > nowMs + CLOCK_SKEW_MS) return null;
  const seconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  return seconds <= INVENTORY_LIMITS.maxUptimeSeconds ? seconds : null;
}

/**
 * CPU/memory come from PM2's pidusage sampling and are meaningful only for running processes; for stopped/errored
 * processes PM2 reports 0, which would be a fabricated value, so they become null.
 */
function cpu(processStatus: ProcessStatus, value: unknown): number | null {
  if (processStatus !== 'online' || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > INVENTORY_LIMITS.maxCpuPercent) return null;
  return Math.round(value * 10) / 10;
}

function memory(processStatus: ProcessStatus, value: unknown): number | null {
  return processStatus === 'online' ? boundedInt(value, INVENTORY_LIMITS.maxMemoryBytes) : null;
}

export function sanitizeProcess(raw: unknown, nowMs: number): InventoryProcess {
  if (!isObject(raw)) throw new InventoryDataError('invalid_data');
  const env = isObject(raw.pm2_env) ? raw.pm2_env : {};
  const monit = isObject(raw.monit) ? raw.monit : {};
  const pmId = boundedInt(raw.pm_id ?? env.pm_id, INVENTORY_LIMITS.maxPmId);
  const name = sanitizeName(raw.name ?? env.name);
  if (pmId === null || name === null) throw new InventoryDataError('invalid_data');
  const st = status(env.status);
  return {
    pmId,
    name,
    status: st,
    uptimeSeconds: uptimeSeconds(st, env.pm_uptime, nowMs),
    restarts: boundedInt(env.restart_time, INVENTORY_LIMITS.maxRestarts),
    cpuPercent: cpu(st, monit.cpu),
    memoryBytes: memory(st, monit.memory),
    execMode: execMode(env.exec_mode),
  };
}

/** Whole list: bounded count, every entry sanitised, duplicate pm_id rejected (ambiguous identity). Sorted by pmId. */
export function sanitizeProcessList(raw: unknown, nowMs: number, maxProcesses: number = INVENTORY_LIMITS.maxProcesses): InventoryProcess[] {
  if (!Array.isArray(raw)) throw new InventoryDataError('invalid_data');
  if (raw.length > maxProcesses) throw new InventoryDataError('too_many_processes');
  const seen = new Set<number>();
  const out: InventoryProcess[] = [];
  for (const item of raw) {
    const p = sanitizeProcess(item, nowMs);
    if (seen.has(p.pmId)) throw new InventoryDataError('invalid_data');
    seen.add(p.pmId);
    out.push(p);
  }
  return out.sort((a, b) => a.pmId - b.pmId);
}
