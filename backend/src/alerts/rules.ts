// Alert rules (ADR-021): a PURE function from one consistent snapshot + the previous per-condition state to the next
// state and the incident transitions. No I/O, no clock reads — `now` and every sample time come from the database.
//
// Evidence per condition and observation:
//   problem  — the open threshold is met by a NEW sample;
//   recovery — the recovery threshold is met by a NEW sample;
//   hold     — a new sample in the hysteresis band (breaks a pending/recovering streak, keeps a firing incident);
//   skip     — no usable data (offline server, stale inventory, null metric, total memory 0, same sample again):
//              nothing changes — missing data is never treated as recovery.

export const RULES = ['server_offline', 'inventory_stale', 'process_down', 'process_cpu', 'server_memory', 'process_restarts'] as const;
export type Rule = (typeof RULES)[number];
export type Severity = 'critical' | 'warning';
export type ConditionState = 'ok' | 'pending' | 'firing' | 'recovering';
export type Resolution = 'recovered' | 'process_gone' | 'excluded';

export interface AlertThresholds {
  cpuOpenPercent: number; cpuClosePercent: number;
  memoryOpenPercent: number; memoryClosePercent: number;
  /** New samples in a row needed to open / to resolve the CPU and memory rules. */
  confirmSamples: number; recoverSamples: number;
  /** New inventory samples in a row needed to open process_down and inventory_stale. */
  statusConfirmSamples: number;
  restartsThreshold: number; restartsWindowSeconds: number;
}

export interface ProcessObs {
  source: string; pmId: number; name: string; status: string; cpuPercent: number | null; restarts: number | null; firstSeenAt: string;
}
export interface ServerObs {
  id: string; name: string;
  status: 'online' | 'offline' | 'never_connected';
  heartbeatAt: number | null;
  memory: { totalBytes: number; freeBytes: number } | null;
  inventory: { state: 'current' | 'stale' | 'unavailable' | 'not_reported'; reportedAt: number | null; collectedAt: number | null };
  /** All processes of the last collected inventory (used only when the inventory is current and the server online). */
  processes: ProcessObs[];
}

export interface Sample { t: number; r: number; f: string }
export interface ConditionRow {
  key: string; serverId: string; rule: Rule; processKey: string | null;
  state: ConditionState; streak: number; lastSampleAt: number | null; samples: Sample[]; incidentId: string | null;
}
export type Detail = Record<string, string | number | null>;

export type Transition =
  | { kind: 'open'; key: string; rule: Rule; severity: Severity; serverId: string; serverName: string; processName: string | null; pmId: number | null; detail: Detail; observedAt: number }
  | { kind: 'observe'; key: string; incidentId: string; detail: Detail; observedAt: number }
  | { kind: 'resolve'; key: string; incidentId: string; resolution: Resolution; detail: Detail; observedAt: number };

export interface EvaluationResult { upserts: ConditionRow[]; deletes: string[]; transitions: Transition[] }

export const PROBLEM_PROCESS_STATUSES = ['stopped', 'errored'] as const;
const MAX_SAMPLES = 64;

export const processKeyOf = (p: Pick<ProcessObs, 'source' | 'pmId' | 'name'>) => `${p.source}:${String(p.pmId)}:${p.name}`;
export const conditionKey = (rule: Rule, serverId: string, processKey: string | null = null) => (processKey === null ? `${rule}:${serverId}` : `${rule}:${serverId}:${processKey}`);

type Evidence = 'problem' | 'recovery' | 'hold' | 'skip';

interface StepContext {
  key: string; rule: Rule; server: ServerObs; process: ProcessObs | null; severity: Severity; detail: Detail;
  evidence: Evidence; sampleAt: number | null; confirm: number; recover: number; samples?: Sample[];
}

/** One condition, one observation: the debounce/hysteresis state machine. Returns the new row (null = ok/absent). */
function step(prev: ConditionRow | undefined, c: StepContext, out: Transition[]): ConditionRow | null | undefined {
  // undefined = "leave the stored row untouched".
  if (c.evidence === 'skip' || c.sampleAt === null) return undefined;
  if (prev && prev.lastSampleAt !== null && c.sampleAt <= prev.lastSampleAt) return undefined; // same snapshot again
  const base: ConditionRow = prev ?? {
    key: c.key, serverId: c.server.id, rule: c.rule, processKey: c.process ? processKeyOf(c.process) : null,
    state: 'ok', streak: 0, lastSampleAt: null, samples: [], incidentId: null,
  };
  const row: ConditionRow = { ...base, lastSampleAt: c.sampleAt, samples: c.samples ?? base.samples };
  const open = () => {
    out.push({
      kind: 'open', key: c.key, rule: c.rule, severity: c.severity, serverId: c.server.id, serverName: c.server.name,
      processName: c.process ? c.process.name : null, pmId: c.process ? c.process.pmId : null, detail: c.detail, observedAt: c.sampleAt ?? 0,
    });
    return { ...row, state: 'firing' as const, streak: 0 };
  };
  const keepRow = (r: ConditionRow) => (r.state === 'ok' && r.samples.length === 0 ? null : r);
  switch (base.state) {
    case 'ok':
    case 'pending': {
      if (c.evidence === 'problem') {
        const streak = (base.state === 'pending' ? base.streak : 0) + 1;
        return streak >= c.confirm ? open() : { ...row, state: 'pending', streak };
      }
      return keepRow({ ...row, state: 'ok', streak: 0 });
    }
    case 'firing':
    case 'recovering': {
      const incidentId = base.incidentId ?? '';
      if (c.evidence === 'recovery') {
        const streak = (base.state === 'recovering' ? base.streak : 0) + 1;
        if (streak >= c.recover) {
          out.push({ kind: 'resolve', key: c.key, incidentId, resolution: 'recovered', detail: c.detail, observedAt: c.sampleAt });
          return keepRow({ ...row, state: 'ok', streak: 0, incidentId: null });
        }
        return { ...row, state: 'recovering', streak };
      }
      if (c.evidence === 'problem') out.push({ kind: 'observe', key: c.key, incidentId, detail: c.detail, observedAt: c.sampleAt });
      return { ...row, state: 'firing', streak: 0 };
    }
  }
}

/** Restart samples: baseline, identity/counter reset and the delta inside the window (never the cumulative count). */
function restartEvidence(prev: ConditionRow | undefined, p: ProcessObs, at: number, t: AlertThresholds): { evidence: Evidence; samples: Sample[]; detail: Detail } {
  if (p.restarts === null) return { evidence: 'skip', samples: prev?.samples ?? [], detail: {} };
  const last = prev?.samples.at(-1);
  if (last && at <= last.t) return { evidence: 'skip', samples: prev?.samples ?? [], detail: {} };
  const current: Sample = { t: at, r: p.restarts, f: p.firstSeenAt };
  // First sample, a counter that went down (PM2 reset / process re-created) or another identity: new baseline.
  if (!last || p.restarts < last.r || last.f !== p.firstSeenAt) {
    return { evidence: prev && prev.state !== 'ok' ? 'hold' : 'skip', samples: [current], detail: { delta: 0 } };
  }
  const windowMs = t.restartsWindowSeconds * 1000;
  const all = [...(prev?.samples ?? []), current];
  // Keep the samples inside the window plus the newest one before it (the anchor for the window start).
  let firstInside = all.findIndex((s) => s.t >= at - windowMs);
  if (firstInside < 0) firstInside = all.length - 1;
  const kept = all.slice(Math.max(0, firstInside - 1)).slice(-MAX_SAMPLES);
  const anchor = kept[0] ?? current;
  const delta = current.r - anchor.r;
  const spanSeconds = Math.round((current.t - anchor.t) / 1000);
  const detail: Detail = { delta, spanSeconds, threshold: t.restartsThreshold, windowSeconds: t.restartsWindowSeconds };
  if (delta >= t.restartsThreshold && current.t - anchor.t <= windowMs * 1.5) return { evidence: 'problem', samples: kept, detail };
  if (delta === 0 && current.t - anchor.t >= windowMs) return { evidence: 'recovery', samples: kept, detail };
  return { evidence: 'hold', samples: kept, detail };
}

export function evaluate(servers: readonly ServerObs[], previous: readonly ConditionRow[], t: AlertThresholds): EvaluationResult {
  const prev = new Map(previous.map((r) => [r.key, r]));
  const touched = new Map<string, ConditionRow | null>();
  const transitions: Transition[] = [];
  const apply = (c: StepContext) => {
    const next = step(prev.get(c.key), c, transitions);
    if (next !== undefined) touched.set(c.key, next);
  };
  const byId = new Map(servers.map((s) => [s.id, s]));

  for (const s of servers) {
    // 1. Server offline: only for a server that has reported before (never_connected is not "went down").
    if (s.status !== 'never_connected') {
      apply({
        key: conditionKey('server_offline', s.id), rule: 'server_offline', server: s, process: null, severity: 'critical',
        detail: { lastSeenAt: s.heartbeatAt === null ? null : new Date(s.heartbeatAt).toISOString() },
        evidence: s.status === 'offline' ? 'problem' : 'recovery', sampleAt: s.heartbeatAt, confirm: 1, recover: 1,
      });
    }
    // Everything below needs an online server; an offline one is covered by the single server_offline incident.
    if (s.status !== 'online') continue;

    // 2. Server memory: NOT evaluated in the rollback compatibility release — the rule is retired (ADR-023, migration
    //    1791900000008); evaluating it again would reopen incidents and queue notifications for a retired rule.

    // 3. Inventory stale/unavailable on an online server (not_reported = PM2 inventory not set up: no alert).
    const inv = s.inventory;
    apply({
      key: conditionKey('inventory_stale', s.id), rule: 'inventory_stale', server: s, process: null, severity: 'warning',
      detail: { state: inv.state },
      evidence: inv.state === 'stale' || inv.state === 'unavailable' ? 'problem' : inv.state === 'current' ? 'recovery' : 'skip',
      sampleAt: inv.reportedAt, confirm: t.statusConfirmSamples, recover: 1,
    });
    if (inv.state !== 'current' || inv.collectedAt === null) continue; // process data not current: suppressed

    // 4–6. Per live process, sampled by the inventory collection time.
    const at = inv.collectedAt;
    const seen = new Set<string>();
    for (const p of s.processes) {
      const pk = processKeyOf(p);
      seen.add(pk);
      const down = (PROBLEM_PROCESS_STATUSES as readonly string[]).includes(p.status);
      apply({
        key: conditionKey('process_down', s.id, pk), rule: 'process_down', server: s, process: p,
        severity: p.status === 'errored' ? 'critical' : 'warning', detail: { status: p.status },
        evidence: down ? 'problem' : p.status === 'online' ? 'recovery' : 'hold', sampleAt: at, confirm: t.statusConfirmSamples, recover: 1,
      });
      apply({
        key: conditionKey('process_cpu', s.id, pk), rule: 'process_cpu', server: s, process: p, severity: 'warning',
        detail: { value: p.cpuPercent, threshold: t.cpuOpenPercent },
        evidence: p.cpuPercent === null ? 'skip' : p.cpuPercent >= t.cpuOpenPercent ? 'problem' : p.cpuPercent < t.cpuClosePercent ? 'recovery' : 'hold',
        sampleAt: at, confirm: t.confirmSamples, recover: t.recoverSamples,
      });
      const rk = conditionKey('process_restarts', s.id, pk);
      const r = restartEvidence(prev.get(rk), p, at, t);
      const before = prev.get(rk);
      const next = step(before, {
        key: rk, rule: 'process_restarts', server: s, process: p, severity: 'warning', detail: r.detail,
        evidence: r.evidence === 'skip' ? 'hold' : r.evidence, sampleAt: at, confirm: 1, recover: 1, samples: r.samples,
      }, transitions);
      // The restart row keeps its baseline even in "ok" (the samples are the baseline).
      if (next !== undefined) touched.set(rk, next ?? { key: rk, serverId: s.id, rule: 'process_restarts', processKey: pk, state: 'ok', streak: 0, lastSampleAt: at, samples: r.samples, incidentId: null });
    }
    // A process that left a CURRENT inventory: closed as "gone" — neither healthy nor a restart.
    for (const row of previous) {
      if (row.serverId !== s.id || row.processKey === null || seen.has(row.processKey) || touched.has(row.key)) continue;
      if ((row.state === 'firing' || row.state === 'recovering') && row.incidentId) {
        transitions.push({ kind: 'resolve', key: row.key, incidentId: row.incidentId, resolution: 'process_gone', detail: {}, observedAt: at });
      }
      touched.set(row.key, null);
    }
  }

  // Servers no longer evaluated (deactivated or deleted): close their incidents as "excluded", drop their state.
  for (const row of previous) {
    if (byId.has(row.serverId) || touched.has(row.key)) continue;
    if ((row.state === 'firing' || row.state === 'recovering') && row.incidentId) {
      transitions.push({ kind: 'resolve', key: row.key, incidentId: row.incidentId, resolution: 'excluded', detail: {}, observedAt: 0 });
    }
    touched.set(row.key, null);
  }

  const upserts: ConditionRow[] = [];
  const deletes: string[] = [];
  for (const [key, row] of touched) {
    if (row === null) { if (prev.has(key)) deletes.push(key); } else upserts.push(row);
  }
  return { upserts, deletes, transitions };
}
