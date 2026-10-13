import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { INVENTORY_FORMAT, INVENTORY_LIMITS, INVENTORY_VERSION, type InventorySnapshot, SOURCE_RE, type UnavailableReason } from '../inventory/contract.js';
import { writeSnapshotAtomic } from '../inventory/snapshot-file.js';
import { getMonitorData, RpcError } from './rpc.js';
import { InventoryDataError, sanitizeProcessList } from './sanitize.js';

// PM2 inventory exporter (ADR-016): one run = one read of an already running PM2 daemon + one atomic snapshot write.
// Runs as the PM2 owner (systemd timer), holds no API token or DB credentials, opens no listener, executes no
// commands and calls only getMonitorData. NOTE: access to rpc.sock technically allows any PM2 command — the
// read-only property comes from this code calling one method, not from OS-level isolation.

export interface ExporterConfig {
  pm2Home: string;
  snapshotFile: string;
  source: string;
  timeoutMs: number;
  maxProcesses: number;
}

export class ExporterConfigError extends Error {
  constructor(readonly issues: string[]) {
    super('invalid exporter configuration');
  }
}

function absolutePath(value: string | undefined, key: string, issues: string[]): string {
  if (!value || !isAbsolute(value) || normalize(value) !== value || value.endsWith('/') || value.includes('\0')) {
    issues.push(`${key} must be a normalized absolute path without a trailing slash`);
    return '';
  }
  return value;
}

function intSetting(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number, issues: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) { issues.push(`${key} must be an integer ${String(min)}..${String(max)}`); return fallback; }
  return Number(raw);
}

export function loadExporterConfig(env: Record<string, string | undefined>, uid: number = process.getuid?.() ?? -1): ExporterConfig {
  const issues: string[] = [];
  if (uid === 0) issues.push('the exporter must not run as root: run it as the PM2 owner');
  const pm2Home = absolutePath(env.NC_PM2_HOME, 'NC_PM2_HOME', issues);
  const snapshotFile = absolutePath(env.NC_PM2_SNAPSHOT_FILE, 'NC_PM2_SNAPSHOT_FILE', issues);
  if (pm2Home && snapshotFile && !relative(pm2Home, snapshotFile).startsWith('..')) issues.push('NC_PM2_SNAPSHOT_FILE must not be inside NC_PM2_HOME');
  const source = env.NC_PM2_SOURCE ?? 'pm2';
  if (!SOURCE_RE.test(source)) issues.push('NC_PM2_SOURCE must match ^[a-z0-9][a-z0-9._-]{0,63}$');
  const timeoutMs = intSetting(env, 'NC_PM2_TIMEOUT_SECONDS', 10, 1, 60, issues) * 1000;
  const maxProcesses = intSetting(env, 'NC_PM2_MAX_PROCESSES', INVENTORY_LIMITS.maxProcesses, 1, INVENTORY_LIMITS.maxProcesses, issues);
  if (issues.length > 0) throw new ExporterConfigError(issues);
  return { pm2Home, snapshotFile, source, timeoutMs, maxProcesses };
}

export interface CollectDeps {
  uid?: number;
  now?: () => number;
  fetchMonitorData?: (socketPath: string, timeoutMs: number) => Promise<unknown>;
}

/**
 * Checks PM2_HOME and its rpc.sock WITHOUT creating anything: a missing socket means no daemon is running and the
 * result is `unavailable/daemon_not_running` (PM2 is never started). The socket must belong to this user.
 */
export async function collectInventory(config: ExporterConfig, deps: CollectDeps = {}): Promise<InventorySnapshot> {
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const now = deps.now ?? Date.now;
  const fetchMonitorData = deps.fetchMonitorData ?? ((socketPath, timeoutMs) => getMonitorData({ socketPath, timeoutMs }));
  const capturedAt = new Date(now()).toISOString();
  const unavailable = (reason: UnavailableReason): InventorySnapshot =>
    ({ format: INVENTORY_FORMAT, version: INVENTORY_VERSION, source: config.source, capturedAt, state: 'unavailable', reason, processes: [] });

  try {
    const home = await lstat(config.pm2Home);
    if (!home.isDirectory() || home.uid !== uid) return unavailable('pm2_home_invalid');
  } catch (error) {
    const c = (error as NodeJS.ErrnoException).code;
    return unavailable(c === 'EACCES' ? 'permission_denied' : 'pm2_home_invalid');
  }
  const socketPath = join(config.pm2Home, 'rpc.sock');
  try {
    const sock = await lstat(socketPath);
    if (!sock.isSocket() || sock.uid !== uid) return unavailable('pm2_home_invalid');
  } catch (error) {
    const c = (error as NodeJS.ErrnoException).code;
    return unavailable(c === 'ENOENT' ? 'daemon_not_running' : c === 'EACCES' ? 'permission_denied' : 'pm2_home_invalid');
  }

  let raw: unknown;
  try {
    raw = await fetchMonitorData(socketPath, config.timeoutMs);
  } catch (error) {
    return unavailable(error instanceof RpcError && error.reason !== 'pm2_error' ? error.reason : 'protocol_error');
  }
  try {
    const processes = sanitizeProcessList(raw, now(), config.maxProcesses);
    return { format: INVENTORY_FORMAT, version: INVENTORY_VERSION, source: config.source, capturedAt, state: 'ok', reason: null, processes };
  } catch (error) {
    return unavailable(error instanceof InventoryDataError ? error.reason : 'invalid_data');
  }
}

export interface ExportResult {
  snapshot: InventorySnapshot;
  durationMs: number;
}

export async function runExporter(config: ExporterConfig, deps: CollectDeps = {}): Promise<ExportResult> {
  const started = Date.now();
  const snapshot = await collectInventory(config, deps);
  await writeSnapshotAtomic(config.snapshotFile, snapshot, deps.uid);
  return { snapshot, durationMs: Date.now() - started };
}
