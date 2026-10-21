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

/** Short identity of a definition sent to the API (ADR-028): 16 hex of the fingerprint — no path/args leave the host. */
export function identityOf(view: RawProcessView): string {
  return fingerprintOf(view).slice('sha256:'.length, 'sha256:'.length + 16);
}

/** Target key of a service in auto mode (ADR-028): derived from the PM2 name only, never from pm_id. */
export function autoTargetKey(name: string): string {
  return `n-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 24)}`;
}

export type Match = { status: Exclude<MatchStatus, 'ok' | 'daemon_unavailable'> } | { status: 'ok'; view: RawProcessView };

/** Exactly one fork-mode, single-instance process carries the name (no fingerprint: auto mode). */
export function matchName(name: string, raw: readonly unknown[]): Match {
  const candidates = raw.map(viewOf).filter((v): v is RawProcessView => v !== null && v.name === name);
  if (candidates.length === 0) return { status: 'not_found' };
  if (candidates.length > 1) return { status: 'ambiguous' };
  const [view] = candidates as [RawProcessView];
  const instances = view.env.instances;
  if (view.env.exec_mode !== 'fork_mode' || (instances !== undefined && instances !== 1 && instances !== '1')) return { status: 'cluster_unsupported' };
  return { status: 'ok', view };
}

export function matchEntry(entry: AllowlistEntry, raw: readonly unknown[]): Match {
  const m = matchName(entry.name, raw);
  if (m.status === 'ok' && fingerprintOf(m.view) !== entry.fingerprint) return { status: 'fingerprint_mismatch' };
  return m;
}

/** Distinct valid PM2 names of the daemon (auto mode targets), sorted. Names unfit for the protocol are skipped. */
export function processNames(raw: readonly unknown[], valid: (name: string) => boolean): string[] {
  return [...new Set(raw.map(viewOf).filter((v): v is RawProcessView => v !== null && valid(v.name)).map((v) => v.name))].sort();
}
