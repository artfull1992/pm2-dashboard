import { describe, expect, it } from 'vitest';
import { type AlertThresholds, type ConditionRow, evaluate, MAX_SAMPLES, type ProcessObs, type ServerObs, type Transition } from '../src/alerts/rules.js';

// Pure alert rules (Task 013, ADR-021): every rule and its recovery, debounce/hysteresis, the same snapshot never
// counted twice, missing data never treated as recovery, suppression while offline, restart baselines.

const T: AlertThresholds = {
  cpuOpenPercent: 90, cpuClosePercent: 70,
  confirmSamples: 3, recoverSamples: 2, statusConfirmSamples: 2, restartsThreshold: 3, restartsWindowSeconds: 600,
};
const S = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const p = (over: Partial<ProcessObs> = {}): ProcessObs => ({ source: 'pm2', pmId: 1, name: 'api', status: 'online', cpuPercent: 5, restarts: 0, firstSeenAt: '2026-10-14T00:00:00.000Z', ...over });
function server(t: number, over: Partial<ServerObs> = {}): ServerObs {
  return {
    id: S, name: 'alpha', status: 'online', heartbeatAt: t,
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
    const off = run([[server(0, { status: 'offline', processes: procs })], [server(0, { status: 'offline', processes: procs })]]);
    expect(off.transitions.flat().map((t) => t.key.split(':')[0])).toEqual(['server_offline']);
  });
});

describe('server_memory is retired (ADR-023: host metrics belong to Zabbix)', () => {
  it('is never evaluated: no condition row and no transition, whatever the server reports', () => {
    const { transitions } = run([[server(1)], [server(2)], [server(3)], [server(4)]]);
    expect(transitions.flat().filter((t) => t.key.startsWith('server_memory:'))).toEqual([]);
    const r = evaluate([server(5)], [], T);
    expect(r.upserts.some((u) => u.rule === 'server_memory')).toBe(false);
  });

  it('a stored firing server_memory row is left to the store: never "recovered", never "excluded", never re-upserted', () => {
    const legacy: ConditionRow = {
      key: `server_memory:${S}`, serverId: S, rule: 'server_memory', processKey: null, state: 'firing', streak: 0, lastSampleAt: 1,
      samples: [], incidentId: '11111111-1111-4111-8111-111111111111',
    };
    for (const servers of [[server(10)], [] as ServerObs[]]) { // still evaluated, or deactivated
      const r = evaluate(servers, [legacy], T);
      expect(r.transitions.filter((t) => t.key === legacy.key)).toEqual([]);
      expect(r.upserts.some((u) => u.key === legacy.key)).toBe(false);
      expect(r.deletes).not.toContain(legacy.key);
    }
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

  it('multi-core: PM2 CPU above 100 % is a valid value; thresholds above 100 % open and resolve normally', () => {
    const high: AlertThresholds = { ...T, cpuOpenPercent: 300, cpuClosePercent: 150, confirmSamples: 2, recoverSamples: 1 };
    const c = (t: number, cpu: number) => server(t, { processes: [p({ cpuPercent: cpu })] });
    const { transitions } = run([[c(1, 250)], [c(2, 350)], [c(3, 420)], [c(4, 120)]], high);
    expect(kinds(transitions, 'process_cpu')).toEqual([[], [], ['open'], ['resolve:recovered']]);
  });

  it('hysteresis: a value between the thresholds breaks a pending or recovering streak but never closes a firing incident', () => {
    const c = (t: number, cpu: number) => server(t, { processes: [p({ cpuPercent: cpu })] });
    // pending 95, 95, then 80 (band) → streak restarts: 95, 95 is not enough, the third 95 opens.
    const opening = run([[c(1, 95)], [c(2, 95)], [c(3, 80)], [c(4, 95)], [c(5, 95)], [c(6, 95)]]);
    expect(kinds(opening.transitions, 'process_cpu')).toEqual([[], [], [], [], [], ['open']]);
    // firing; 10 (recovering), 80 (band: back to firing, not resolved), 10, 10 → resolved.
    const closing = run([[c(1, 95)], [c(2, 95)], [c(3, 95)], [c(4, 10)], [c(5, 80)], [c(6, 10)], [c(7, 10)]]);
    expect(kinds(closing.transitions, 'process_cpu')).toEqual([[], [], ['open'], [], [], [], ['resolve:recovered']]);
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

// Review 2026-10-19 (P2): long windows (allowed 2–1440 min). The state is bounded (≤ MAX_SAMPLES points, the stored
// format) and carried between evaluations through JSON exactly as the store persists it.
describe('process_restarts: long windows with bounded state', () => {
  const H = 60 * MIN;
  /** Inventory every `everySec`; restarts(tMs) gives the counter (null = unknown) and identity; state JSON-round-tripped. */
  function stream(o: { windowMin: number; everySec: number; untilMs: number; restarts: (t: number) => number | null; firstSeen?: (t: number) => string; initial?: ConditionRow[]; start?: number }) {
    const thresholds = { ...T, restartsWindowSeconds: o.windowMin * 60 };
    let rows: ConditionRow[] = o.initial ?? [];
    const opens: number[] = [];
    const resolves: number[] = [];
    let maxPoints = 0;
    let maxBytes = 0;
    let n = 0;
    for (let t = o.start ?? 0; t <= o.untilMs; t += o.everySec * 1000) {
      const proc = p({ restarts: o.restarts(t), ...(o.firstSeen ? { firstSeenAt: o.firstSeen(t) } : {}) });
      const r = evaluate([server(t, { processes: [proc] })], rows, thresholds);
      const next = new Map(rows.map((x) => [x.key, x]));
      for (const d of r.deletes) next.delete(d);
      for (const tr of r.transitions) {
        if (!tr.key.startsWith('process_restarts')) continue;
        if (tr.kind === 'open') opens.push(t); else if (tr.kind === 'resolve') resolves.push(t);
      }
      const opened = new Map(r.transitions.filter((x) => x.kind === 'open').map((x) => [x.key, `inc-${String(++n)}`]));
      for (const u of r.upserts) next.set(u.key, { ...u, incidentId: u.state === 'firing' || u.state === 'recovering' ? (opened.get(u.key) ?? u.incidentId) : null });
      // The store's serialization: JSON (jsonb) with at most MAX_SAMPLES points.
      rows = (JSON.parse(JSON.stringify([...next.values()])) as ConditionRow[]).map((x) => ({ ...x, samples: x.samples.slice(-MAX_SAMPLES) }));
      const restartRow = rows.find((x) => x.rule === 'process_restarts');
      maxPoints = Math.max(maxPoints, restartRow?.samples.length ?? 0);
      maxBytes = Math.max(maxBytes, JSON.stringify(restartRow?.samples ?? []).length);
    }
    return { opens, resolves, maxPoints, maxBytes, rows, state: rows.find((x) => x.rule === 'process_restarts')?.state };
  }

  it('window 120 min, inventory every 30 s, 0 → 3 restarts then none: opens once, resolves one window later', () => {
    const r = stream({ windowMin: 120, everySec: 30, untilMs: 200 * MIN, restarts: (t) => (t === 0 ? 0 : 3) });
    expect(r.opens).toEqual([30_000]);
    expect(r.resolves).toHaveLength(1);
    // The last restart is in the 30-s sample; the window without restarts ends 120 min later (+ bounded precision).
    expect(r.resolves[0]).toBeGreaterThanOrEqual(30_000 + 120 * MIN);
    expect(r.resolves[0]).toBeLessThanOrEqual(30_000 + 120 * MIN + Math.ceil(120 * MIN / 30));
    expect(r.state).toBe('ok');
    expect(r.maxPoints).toBeLessThanOrEqual(MAX_SAMPLES);
  });

  it('restarts accumulated over the whole long window (far beyond the last 64 samples) open', () => {
    // One restart at 10, 50 and 90 min: 3 inside the 120-min window, never 3 inside any 32-min stretch.
    const restarts = (t: number) => [10, 50, 90].filter((m) => t >= m * MIN).length;
    const r = stream({ windowMin: 120, everySec: 30, untilMs: 100 * MIN, restarts });
    expect(r.opens).toEqual([90 * MIN]);
    // The same restarts spread wider than the window (10, 80, 150 min): never 3 inside 120 min.
    const wide = stream({ windowMin: 120, everySec: 30, untilMs: 200 * MIN, restarts: (t) => [10, 80, 150].filter((m) => t >= m * MIN).length });
    expect(wide.opens).toEqual([]);
  });

  it('the default short window keeps its exact behaviour (every sample retained)', () => {
    const r = stream({ windowMin: 10, everySec: 30, untilMs: 30 * MIN, restarts: (t) => (t < MIN ? 0 : 3) });
    expect(r.opens).toEqual([MIN]);
    // Anchor = the newest sample before the window start: the 1-min sample anchors from 11.5 min on.
    expect(r.resolves).toEqual([11.5 * MIN]);
    expect(r.maxPoints).toBe(22); // 10 min / 30 s + the anchor + the newest point: nothing thinned
  });

  it.each([
    [2, 10], [2, 60], [1440, 10], [1440, 60], [1440, 300], [600, 30],
  ])('window %i min, inventory every %i s: one open, one resolve after a full quiet window, bounded state', (windowMin, everySec) => {
    const at = 5 * everySec * 1000; // restarts happen after a few baseline samples
    const r = stream({ windowMin, everySec, untilMs: at + windowMin * MIN * 1.2 + 10 * MIN, restarts: (t) => (t < at ? 0 : 3) });
    expect(r.opens).toEqual([at]);
    expect(r.resolves).toHaveLength(1);
    expect(r.resolves[0]).toBeGreaterThanOrEqual(at + windowMin * MIN);
    expect(r.resolves[0]).toBeLessThanOrEqual(at + windowMin * MIN + Math.ceil(windowMin * MIN / 30) + everySec * 1000);
    expect(r.maxPoints).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(r.maxBytes).toBeLessThanOrEqual(MAX_SAMPLES * 60);
  }, 30_000);

  it('a long stream with frequent restarts stays bounded (≤ MAX_SAMPLES points) and keeps counting', () => {
    // 2 days, inventory every 10 s, a restart every 7 min, 1440-min window, threshold 3.
    const r = stream({ windowMin: 1440, everySec: 10, untilMs: 48 * H, restarts: (t) => Math.floor(t / (7 * MIN)) });
    expect(r.opens).toEqual([21 * MIN]);
    expect(r.resolves).toEqual([]);
    expect(r.maxPoints).toBeLessThanOrEqual(MAX_SAMPLES);
  }, 30_000);

  it('counter reset and identity change during a long window: a new baseline, still no recovery before a full quiet window', () => {
    // Opened at 1 min (0 → 3). PM2 reset at 60 min (counter 0), then quiet: resolves one full window after the reset.
    const reset = stream({ windowMin: 120, everySec: 30, untilMs: 240 * MIN, restarts: (t) => (t === 0 ? 0 : t < 60 * MIN ? 3 : 0) });
    expect(reset.opens).toEqual([30_000]);
    expect(reset.resolves).toHaveLength(1);
    expect(reset.resolves[0]).toBeGreaterThanOrEqual(60 * MIN + 120 * MIN);
    // Re-created process (another identity) at 60 min: the same.
    const other = stream({
      windowMin: 120, everySec: 30, untilMs: 240 * MIN, restarts: (t) => (t === 0 ? 0 : 3),
      firstSeen: (t) => (t < 60 * MIN ? '2026-10-14T00:00:00.000Z' : '2026-10-14T05:00:00.000Z'),
    });
    expect(other.opens).toEqual([30_000]);
    expect(other.resolves[0]).toBeGreaterThanOrEqual(60 * MIN + 120 * MIN);
  });

  it('an unknown counter (null) or a repeated sample adds nothing and never resolves', () => {
    const r = stream({ windowMin: 120, everySec: 30, untilMs: 300 * MIN, restarts: (t) => (t === 0 ? 0 : t < MIN ? 3 : null) });
    expect(r.opens).toEqual([30_000]);
    expect(r.resolves).toEqual([]);
    expect(r.state).toBe('firing');
  });

  it('state saved by the previous release (64 dense samples, 31.5-min span) is read and recovery completes', () => {
    // What the previous code stored after 200 min of the 120/30 s scenario: the last 64 samples only.
    const old = stream({ windowMin: 120, everySec: 30, untilMs: 200 * MIN, restarts: (t) => (t === 0 ? 0 : 3) });
    const saved = old.rows.map((x) => (x.rule === 'process_restarts'
      ? { ...x, state: 'firing' as const, incidentId: 'inc-old', samples: Array.from({ length: 64 }, (_, i) => ({ t: 200 * MIN - (63 - i) * 30_000, r: 3, f: '2026-10-14T00:00:00.000Z' })) }
      : x));
    const next = stream({ windowMin: 120, everySec: 30, start: 200 * MIN + 30_000, untilMs: 400 * MIN, restarts: () => 3, initial: saved });
    expect(next.opens).toEqual([]);
    expect(next.resolves).toHaveLength(1);
    // Its oldest kept point (168.5 min) becomes the anchor once a full window has passed.
    expect(next.resolves[0]).toBeGreaterThanOrEqual(168.5 * MIN + 120 * MIN);
    expect(next.resolves[0]).toBeLessThanOrEqual(168.5 * MIN + 120 * MIN + 30_000);
  });
});

describe('exclusion and missing data', () => {
  it('an incident of a server that disappears from the evaluated set (deactivated) closes as "excluded"', () => {
    const { transitions } = run([[server(0)], [server(0, { status: 'offline' })], []]);
    expect(kinds(transitions)).toEqual([[], ['open'], ['resolve:excluded']]);
  });

  it('missing fresh data never resolves a firing incident', () => {
    const hot = (t: number) => server(t, { processes: [p({ cpuPercent: 95 })] });
    const { transitions } = run([[hot(1)], [hot(2)], [hot(3)], [hot(3)], [hot(3)], [server(3, { status: 'offline' })]]);
    expect(kinds(transitions, 'process_cpu')).toEqual([[], [], ['open'], [], [], []]);
  });
});
