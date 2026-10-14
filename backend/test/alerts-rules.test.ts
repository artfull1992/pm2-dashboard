import { describe, expect, it } from 'vitest';
import { type AlertThresholds, type ConditionRow, evaluate, type ProcessObs, type ServerObs, type Transition } from '../src/alerts/rules.js';

// Pure alert rules (Task 013, ADR-021): every rule and its recovery, debounce/hysteresis, the same snapshot never
// counted twice, missing data never treated as recovery, suppression while offline, restart baselines.

const T: AlertThresholds = {
  cpuOpenPercent: 90, cpuClosePercent: 70, memoryOpenPercent: 90, memoryClosePercent: 80,
  confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowSeconds: 600,
};
const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const p = (over: Partial<ProcessObs> = {}): ProcessObs => ({ source: 'pm2', pmId: 1, name: 'api', status: 'online', cpuPercent: 5, restarts: 0, firstSeenAt: '2026-10-14T00:00:00.000Z', ...over });
function server(t: number, over: Partial<ServerObs> = {}): ServerObs {
  return {
    id: S, name: 'alpha', status: 'online', heartbeatAt: t, memory: { totalBytes: 1000, freeBytes: 500 },
    inventory: { state: 'current', reportedAt: t, collectedAt: t }, processes: [p()], ...over,
  };
}

/** Runs observations in order, carrying condition state like the store does (incident ids for opened ones). */
function run(steps: ServerObs[][], thresholds = T) {
  let rows: ConditionRow[] = [];
  const all: Transition[][] = [];
  let n = 0;
  for (const servers of steps) {
    const r = evaluate(servers, rows, thresholds);
    const opened = new Map(r.transitions.filter((t) => t.kind === 'open').map((t) => [t.key, `inc-${String(++n)}`]));
    const next = new Map(rows.map((x) => [x.key, x]));
    for (const d of r.deletes) next.delete(d);
    for (const u of r.upserts) next.set(u.key, { ...u, incidentId: u.state === 'firing' || u.state === 'recovering' ? (opened.get(u.key) ?? u.incidentId) : null });
    rows = [...next.values()];
    all.push(r.transitions);
  }
  return { transitions: all, rows };
}
const kinds = (ts: Transition[][], rule?: string) => ts.map((step) => step.filter((t) => !rule || t.key.startsWith(rule)).map((t) => (t.kind === 'resolve' ? `resolve:${t.resolution}` : t.kind)));
const MIN = 60_000;

describe('server_offline', () => {
  it('opens once for a server that reported before; resolves on a fresh heartbeat; repeated offline snapshots add nothing', () => {
    const { transitions } = run([[server(0)], [server(0, { status: 'offline' })], [server(0, { status: 'offline' })], [server(5 * MIN)]]);
    expect(kinds(transitions, 'server_offline')).toEqual([[], ['open'], [], ['resolve:recovered']]);
  });

  it('never_connected never opens "went down"; an offline server suppresses every other rule (no avalanche)', () => {
    const never = run([[server(0, { status: 'never_connected', heartbeatAt: null })]]);
    expect(never.transitions.flat()).toEqual([]);
    const procs = Array.from({ length: 30 }, (_, i) => p({ pmId: i, name: `p${String(i)}`, status: 'errored', cpuPercent: 99 }));
    const off = run([[server(0, { status: 'offline', processes: procs, memory: { totalBytes: 100, freeBytes: 1 } })], [server(0, { status: 'offline', processes: procs })]]);
    expect(off.transitions.flat().map((t) => t.key.split(':')[0])).toEqual(['server_offline']);
  });
});

describe('server_memory (OS total − free)', () => {
  it('opens after 3 NEW heartbeats ≥ 90 %, the same heartbeat re-evaluated is not counted; recovers after 2 below 80 %', () => {
    const hot = (t: number) => server(t, { memory: { totalBytes: 1000, freeBytes: 50 } });
    const { transitions } = run([[hot(0)], [hot(0)], [hot(30_000)], [hot(30_000)], [hot(60_000)], [server(90_000, { memory: { totalBytes: 1000, freeBytes: 500 } })], [server(120_000)]]);
    expect(kinds(transitions, 'server_memory')).toEqual([[], [], [], [], ['open'], [], ['resolve:recovered']]);
    const open = transitions.flat().find((t) => t.kind === 'open');
    expect(open).toMatchObject({ severity: 'warning', detail: { value: 95, threshold: 90 } });
  });

  it('hysteresis: 85 % neither opens nor resolves; it breaks a pending streak and a recovering streak', () => {
    const m = (t: number, free: number) => server(t, { memory: { totalBytes: 1000, freeBytes: free } });
    const { transitions } = run([[m(1, 50)], [m(2, 50)], [m(3, 150)], [m(4, 50)], [m(5, 50)], [m(6, 50)], [m(7, 500)], [m(8, 150)], [m(9, 500)], [m(10, 500)]]);
    expect(kinds(transitions, 'server_memory')).toEqual([[], [], [], [], [], ['open'], [], [], [], ['resolve:recovered']]);
  });

  it('total memory 0 or no snapshot is unknown — never 0 % and never a recovery', () => {
    const hot = (t: number) => server(t, { memory: { totalBytes: 1000, freeBytes: 10 } });
    const { transitions } = run([[hot(1)], [hot(2)], [hot(3)], [server(4, { memory: { totalBytes: 0, freeBytes: 0 } })], [server(5, { memory: null })], [server(6, { memory: { totalBytes: 0, freeBytes: 0 } })]]);
    expect(kinds(transitions, 'server_memory')).toEqual([[], [], ['open'], [], [], []]);
  });
});

describe('inventory_stale', () => {
  it('stale/unavailable on an online server opens after 2 new reports; current resolves; not_reported is not an alert', () => {
    const st = (t: number, state: 'stale' | 'unavailable' | 'current' | 'not_reported') => server(t, { inventory: { state, reportedAt: t, collectedAt: state === 'current' ? t : null } });
    const { transitions } = run([[st(1, 'stale')], [st(1, 'stale')], [st(2, 'unavailable')], [st(3, 'current')]]);
    expect(kinds(transitions, 'inventory_stale')).toEqual([[], [], ['open'], ['resolve:recovered']]);
    expect(run([[st(1, 'not_reported')], [st(2, 'not_reported')], [st(3, 'not_reported')]]).transitions.flat()).toEqual([]);
  });

  it('a stale inventory suppresses process rules (no new process alerts, no recovery of open ones)', () => {
    const down = (t: number) => server(t, { processes: [p({ status: 'errored' })] });
    const stale = (t: number) => server(t, { inventory: { state: 'stale', reportedAt: t, collectedAt: 0 }, processes: [p({ status: 'online' })] });
    const { transitions } = run([[down(1)], [down(2)], [stale(3)], [stale(4)]]);
    expect(kinds(transitions, 'process_down')).toEqual([[], ['open'], [], []]);
  });
});

describe('process_down', () => {
  it('errored → critical after 2 inventory samples; stopped → warning that does not claim a crash; online resolves', () => {
    const st = (t: number, status: string) => server(t, { processes: [p({ status })] });
    const r = run([[st(1, 'errored')], [st(2, 'errored')], [st(3, 'online')], [st(4, 'stopped')], [st(5, 'stopped')]]);
    expect(kinds(r.transitions, 'process_down')).toEqual([[], ['open'], ['resolve:recovered'], [], ['open']]);
    expect(r.transitions[1]?.find((t) => t.kind === 'open')).toMatchObject({ severity: 'critical', processName: 'api', pmId: 1, detail: { status: 'errored' } });
    expect(r.transitions[4]?.find((t) => t.kind === 'open')).toMatchObject({ severity: 'warning', detail: { status: 'stopped' } });
  });

  it('transition states (launching/stopping/waiting) neither open nor resolve', () => {
    const st = (t: number, status: string) => server(t, { processes: [p({ status })] });
    const { transitions } = run([[st(1, 'errored')], [st(2, 'errored')], [st(3, 'launching')], [st(4, 'waiting restart')]]);
    expect(kinds(transitions, 'process_down')).toEqual([[], ['open'], [], []]);
  });

  it('a process that leaves a CURRENT inventory closes its incidents as "gone" (not healthy, not a restart)', () => {
    const { transitions, rows } = run([[server(1, { processes: [p({ status: 'errored' })] })], [server(2, { processes: [p({ status: 'errored' })] })], [server(3, { processes: [] })]]);
    expect(kinds(transitions, 'process_down')).toEqual([[], ['open'], ['resolve:process_gone']]);
    expect(rows.filter((r) => r.processKey !== null)).toEqual([]);
  });
});

describe('process_cpu (PM2 CPU %, not load average)', () => {
  it('3 new samples ≥ 90 % open, 2 below 70 % resolve; null CPU is skipped', () => {
    const c = (t: number, cpu: number | null) => server(t, { processes: [p({ cpuPercent: cpu })] });
    const { transitions } = run([[c(1, 95)], [c(2, null)], [c(3, 95)], [c(4, 99)], [c(5, null)], [c(6, 10)], [c(7, 10)]]);
    expect(kinds(transitions, 'process_cpu')).toEqual([[], [], [], ['open'], [], [], ['resolve:recovered']]);
  });
});

describe('process_restarts (delta between new samples, never the cumulative counter)', () => {
  const r = (t: number, restarts: number | null, over: Partial<ProcessObs> = {}) => server(t, { processes: [p({ restarts, ...over })] });

  it('first sample is only a baseline: a huge cumulative counter alone never alerts', () => {
    expect(run([[r(0, 5000)], [r(MIN, 5000)]]).transitions.flat()).toEqual([]);
  });

  it('≥ 3 new restarts inside the window open; a full window without restarts resolves', () => {
    const { transitions } = run([[r(0, 10)], [r(MIN, 11)], [r(2 * MIN, 13)], [r(3 * MIN, 13)], [r(9 * MIN, 13)], [r(14 * MIN, 13)]]);
    // 3 and 9 min: the same 3 restarts are still inside the 10-min window → the incident is only observed again.
    expect(kinds(transitions, 'process_restarts')).toEqual([[], [], ['open'], ['observe'], ['observe'], ['resolve:recovered']]);
    expect(transitions[2]?.[0]).toMatchObject({ detail: { delta: 3, threshold: 3, windowSeconds: 600 } });
  });

  it('restarts spread wider than the window do not open', () => {
    expect(kinds(run([[r(0, 0)], [r(6 * MIN, 1)], [r(12 * MIN, 2)], [r(18 * MIN, 3)], [r(24 * MIN, 4)]]).transitions, 'process_restarts').flat()).toEqual([]);
  });

  it('a counter that goes down or another identity (re-created process) resets the baseline instead of counting', () => {
    const reset = run([[r(0, 50)], [r(MIN, 0)], [r(2 * MIN, 1)], [r(3 * MIN, 2)]]);
    expect(reset.transitions.flat()).toEqual([]);
    const other = run([[r(0, 0)], [r(MIN, 5, { firstSeenAt: '2026-10-14T05:00:00.000Z' })], [r(2 * MIN, 6, { firstSeenAt: '2026-10-14T05:00:00.000Z' })]]);
    expect(other.transitions.flat()).toEqual([]);
  });

  it('the same inventory sample evaluated again is not a new observation', () => {
    expect(kinds(run([[r(0, 0)], [r(MIN, 5)], [r(MIN, 9)]]).transitions, 'process_restarts')).toEqual([[], ['open'], []]);
  });
});

describe('exclusion and missing data', () => {
  it('an incident of a server that disappears from the evaluated set (deactivated) closes as "excluded"', () => {
    const { transitions } = run([[server(0)], [server(0, { status: 'offline' })], []]);
    expect(kinds(transitions)).toEqual([[], ['open'], ['resolve:excluded']]);
  });

  it('missing fresh data never resolves a firing incident', () => {
    const hot = (t: number) => server(t, { memory: { totalBytes: 1000, freeBytes: 10 } });
    const { transitions } = run([[hot(1)], [hot(2)], [hot(3)], [hot(3)], [hot(3)], [server(3, { status: 'offline' })]]);
    expect(kinds(transitions, 'server_memory')).toEqual([[], [], ['open'], [], [], []]);
  });
});
