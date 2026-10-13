import type { AgentConfig, InventoryConfig } from '../config.js';
import { abortableSleep, type AgentLogger } from '../agent.js';
import { type FetchLike, machinePost, type MachinePostOutcome } from '../heartbeat.js';
import { type InventoryProcess, isIsoUtc, type UnavailableReason } from './contract.js';
import { readSnapshotSecure, SnapshotFileError } from './snapshot-file.js';

// Agent → API PM2 inventory reporting (ADR-016). Independent of the heartbeat: its own sequential loop, its own
// backoff; a missing exporter or a failing inventory endpoint never delays or breaks the heartbeat.

export const INVENTORY_REPORT_VERSION = 1;
/** Server-suggested inventory interval bounds (same as NC_AGENT_INVENTORY_INTERVAL_SECONDS). */
export const INVENTORY_INTERVAL_BOUNDS = Object.freeze({ min: 30, max: 600 });
/** A capturedAt this far in the future (exporter clock = Agent clock, same host) is not believable. */
const FUTURE_SKEW_MS = 5 * 60_000;

export type InventoryReport =
  | { version: 1; state: 'ok'; reason: null; source: string; capturedAt: string; processes: InventoryProcess[] }
  | { version: 1; state: 'stale'; reason: null; source: string; capturedAt: string; processes: [] }
  | { version: 1; state: 'unavailable'; reason: UnavailableReason; source: string | null; capturedAt: string | null; processes: [] };

/**
 * Turns the exporter snapshot file into the report. A snapshot older than maxAge is reported as `stale` WITHOUT its
 * processes: the API keeps the last data and does not treat it as a new collection.
 */
export async function buildInventoryReport(config: InventoryConfig, now: number = Date.now(), read = readSnapshotSecure): Promise<InventoryReport> {
  let snapshot;
  try {
    snapshot = await read(config.file, undefined, { allowSameOwner: config.allowSameOwner });
  } catch (error) {
    const reason = error instanceof SnapshotFileError ? error.reason : 'snapshot_invalid';
    return { version: 1, state: 'unavailable', reason, source: null, capturedAt: null, processes: [] };
  }
  const captured = Date.parse(snapshot.capturedAt);
  if (captured > now + FUTURE_SKEW_MS) {
    return { version: 1, state: 'unavailable', reason: 'snapshot_invalid', source: snapshot.source, capturedAt: null, processes: [] };
  }
  if (now - captured > config.maxAgeSeconds * 1000) {
    return { version: 1, state: 'stale', reason: null, source: snapshot.source, capturedAt: snapshot.capturedAt, processes: [] };
  }
  if (snapshot.state === 'unavailable') {
    return { version: 1, state: 'unavailable', reason: snapshot.reason, source: snapshot.source, capturedAt: snapshot.capturedAt, processes: [] };
  }
  return { version: 1, state: 'ok', reason: null, source: snapshot.source, capturedAt: snapshot.capturedAt, processes: snapshot.processes };
}

/** API reply contract: { status: 'accepted' | 'ignored', receivedAt: ISO-8601 UTC, intervalSeconds: integer 30..600 }. */
export function parseInventoryReply(text: string): { status: 'accepted' | 'ignored'; intervalSeconds: number } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { status, receivedAt, intervalSeconds } = body as Record<string, unknown>;
  if (status !== 'accepted' && status !== 'ignored') return null;
  if (!isIsoUtc(receivedAt)) return null;
  if (typeof intervalSeconds !== 'number' || !Number.isSafeInteger(intervalSeconds)) return null;
  if (intervalSeconds < INVENTORY_INTERVAL_BOUNDS.min || intervalSeconds > INVENTORY_INTERVAL_BOUNDS.max) return null;
  return { status, intervalSeconds };
}

export type InventoryOutcome = MachinePostOutcome<{ status: 'accepted' | 'ignored'; intervalSeconds: number }>;

export function sendInventory(config: AgentConfig, report: InventoryReport, signal: AbortSignal, fetchImpl?: FetchLike): Promise<InventoryOutcome> {
  return machinePost(config, '/api/agent/inventory', report, signal, parseInventoryReply, fetchImpl);
}

/**
 * Seconds until the next inventory report. ok → max(local interval, server suggestion); 404 (older API without the
 * route) and 401/403 → the long maximum, so an old API is never hammered; other failures → exponential backoff with
 * full jitter from the local interval. Never resets on failure.
 */
export function inventoryDelaySeconds(outcome: InventoryOutcome, state: { failures: number }, config: AgentConfig, random: () => number = Math.random): number {
  const inv = config.inventory;
  const base = inv?.intervalSeconds ?? INVENTORY_INTERVAL_BOUNDS.min;
  const max = Math.max(config.maxBackoffSeconds, base);
  switch (outcome.kind) {
    case 'ok':
      state.failures = 0;
      return Math.min(Math.max(base, outcome.value.intervalSeconds), INVENTORY_INTERVAL_BOUNDS.max);
    case 'not_found':
    case 'unauthorized':
      state.failures += 1;
      return max;
    case 'rate_limited':
      state.failures += 1;
      return Math.min(Math.max(outcome.retryAfterSeconds ?? base, base), max);
    case 'aborted':
      return 0;
    default: {
      state.failures += 1;
      const ceiling = Math.min(max, base * 2 ** Math.min(state.failures, 10));
      return Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
    }
  }
}

export interface InventoryLoopDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  readSnapshot?: typeof readSnapshotSecure;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger: AgentLogger;
}

/** Sequential inventory loop (no overlapping requests); returns the number of attempts when `signal` aborts. */
export async function runInventory(config: AgentConfig, signal: AbortSignal, deps: InventoryLoopDeps): Promise<number> {
  const inv = config.inventory;
  if (!inv) return 0;
  const state = { failures: 0 };
  const sleep = deps.sleep ?? abortableSleep;
  let attempts = 0;
  let last = '';
  while (!signal.aborted) {
    attempts += 1;
    const report = await buildInventoryReport(inv, (deps.now ?? Date.now)(), deps.readSnapshot);
    const outcome = await sendInventory(config, report, signal, deps.fetchImpl);
    if (outcome.kind === 'aborted') break;
    const delay = inventoryDelaySeconds(outcome, state, config, deps.random);
    // Metadata only: report state/reason/count and the outcome — never process names, paths or the token.
    const summary = `${outcome.kind}|${report.state}|${report.reason ?? ''}`;
    if (summary !== last || outcome.kind !== 'ok') {
      const event = {
        msg: 'inventory', outcome: outcome.kind === 'ok' ? outcome.value.status : outcome.kind, state: report.state, reason: report.reason,
        processCount: report.processes.length, nextInSeconds: delay, consecutiveFailures: state.failures,
      };
      if (outcome.kind === 'ok' && report.state === 'ok') deps.logger.info(event);
      else deps.logger.warn(event);
    }
    last = summary;
    await sleep(delay * 1000, signal);
  }
  return attempts;
}
