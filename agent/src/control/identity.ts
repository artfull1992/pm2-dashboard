import { createHash } from 'node:crypto';
import type { AllowlistEntry } from './allowlist.js';
import { type MatchStatus, PROCESS_STATES, type ProcessState } from './protocol.js';

// Process identity for control (ADR-017). Neither pm_id (PM2 reuses it) nor the name alone (names can repeat,
// cluster instances share one) is enough: a target matches only if exactly one PM2 process carries the name, it
// runs in fork mode with a single instance, and its definition fingerprint equals the allowlisted one.
// Paths/args are hashed here locally and never leave the broker.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface RawProcessView {
  pmId: number;
  name: string;
  env: Record<string, unknown>;
}

/** Narrow view over a raw getMonitorData entry; anything without a valid pm_id/name is ignored. */
export function viewOf(raw: unknown): RawProcessView | null {
  if (!isObject(raw)) return null;
  const env = isObject(raw.pm2_env) ? raw.pm2_env : {};
  const pmId = raw.pm_id ?? env.pm_id;
  const name = raw.name ?? env.name;
  if (typeof pmId !== 'number' || !Number.isSafeInteger(pmId) || pmId < 0 || typeof name !== 'string') return null;
  return { pmId, name, env };
}

/** sha256 over the canonical JSON of the definition fields; identifies WHAT runs under the name, not who may act. */
export function fingerprintOf(view: RawProcessView): string {
  const e = view.env;
  const field = (v: unknown) => (v === undefined ? null : v);
  const canonical = JSON.stringify([view.name, field(e.pm_exec_path), field(e.pm_cwd), field(e.exec_interpreter), field(e.args), field(e.node_args), field(e.exec_mode)]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function stateOf(view: RawProcessView): { status: ProcessState; restarts: number | null; startedAt: number | null } {
  const status = (PROCESS_STATES as readonly unknown[]).includes(view.env.status) ? view.env.status as ProcessState : 'unknown';
  const restarts = typeof view.env.restart_time === 'number' && Number.isSafeInteger(view.env.restart_time) ? view.env.restart_time : null;
  const startedAt = typeof view.env.pm_uptime === 'number' && Number.isFinite(view.env.pm_uptime) ? view.env.pm_uptime : null;
  return { status, restarts, startedAt };
}

export type Match = { status: Exclude<MatchStatus, 'ok' | 'daemon_unavailable'> } | { status: 'ok'; view: RawProcessView };

export function matchEntry(entry: AllowlistEntry, raw: readonly unknown[]): Match {
  const candidates = raw.map(viewOf).filter((v): v is RawProcessView => v !== null && v.name === entry.name);
  if (candidates.length === 0) return { status: 'not_found' };
  if (candidates.length > 1) return { status: 'ambiguous' };
  const [view] = candidates as [RawProcessView];
  const instances = view.env.instances;
  if (view.env.exec_mode !== 'fork_mode' || (instances !== undefined && instances !== 1 && instances !== '1')) return { status: 'cluster_unsupported' };
  if (fingerprintOf(view) !== entry.fingerprint) return { status: 'fingerprint_mismatch' };
  return { status: 'ok', view };
}
