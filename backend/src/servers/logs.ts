import { randomUUID } from 'node:crypto';

// Bounded authorized log viewing — API side (ADR-018). Log text lives ONLY in this bounded in-memory hub for a
// short time; it is never written to PostgreSQL, audit or service logs. After an API restart everything here is
// gone (open viewers see "expired" and request again).

export const LOG_LIMITS = Object.freeze({
  maxLines: 100,
  totalTextBytes: 8 * 1024,
  requestDeadlineMs: 15_000,
  resultTtlMs: 60_000,
  agentHoldMs: 25_000,
  agentSeenMs: 60_000,
  userWaitMs: 8_000,
  maxRequests: 200,
  maxPendingPerActor: 2,
  ratePerActorPerMinute: 30,
  maxPerPoll: 4,
  auditThrottleMs: 10 * 60_000,
  // Result waiters (GET /api/log-requests/:id holding up to userWaitMs). The UI keeps at most one GET per open viewer
  // and never overlaps them; 2 per request covers a reconnect while the old connection is still closing, 3 per actor
  // a second tab, 100 overall bounds timers/sockets far above the expected number of concurrent operators.
  maxWaitersPerRequest: 2,
  maxWaitersPerActor: 3,
  maxWaiters: 100,
  pollBodyBytes: 256 * 1024,
  maxTargetsV1: 50,
  maxTargetsV2: 500,
  resultBodyBytes: 40 * 1024,
});

export const STREAM_STATES = ['ok', 'empty', 'missing', 'unavailable', 'merged'] as const;
export const LOG_REASONS = [
  'not_allowlisted', 'logs_not_allowed', 'allowlist_invalid', 'not_found', 'ambiguous', 'cluster_unsupported',
  'fingerprint_mismatch', 'daemon_unavailable', 'deadline_passed', 'invalid_deadline', 'broker_busy', 'timeout',
  'broker_unavailable', 'broker_unsupported',
] as const;
const MATCH = ['ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable'] as const;
const TARGET_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const ISO_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

export interface LogStream { state: (typeof STREAM_STATES)[number]; text: string; lines: number; truncated: boolean; sizeBytes: number | null; modifiedAt: string | null }
export interface LogTarget { targetKey: string; name: string; pmId: number | null; matchStatus: (typeof MATCH)[number] }
export interface LogResult { outcome: 'ok' | 'rejected' | 'failed'; reason: string | null; readAt: string; stdout: LogStream | null; stderr: LogStream | null }
export interface AgentLogReport {
  version: 1 | 2;
  /** Version 2 only (ADR-028): 'auto' = every process of the PM2 owner, no allowlist. */
  mode?: 'allowlist' | 'auto' | null;
  broker: 'ok' | 'unavailable' | 'unsupported'; daemon: 'ok' | 'unavailable' | null; allowlist: 'ok' | 'invalid' | null; targets: LogTarget[];
  /** Version 2 only: log targets the broker knows (more than listed = cut). */
  total?: number;
}

export const logStreamSchema = {
  anyOf: [{ type: 'null' }, {
    type: 'object', additionalProperties: false, required: ['state', 'text', 'lines', 'truncated', 'sizeBytes', 'modifiedAt'],
    properties: {
      state: { type: 'string', enum: STREAM_STATES }, text: { type: 'string', maxLength: LOG_LIMITS.totalTextBytes },
      lines: { type: 'integer', minimum: 0, maximum: LOG_LIMITS.maxLines }, truncated: { type: 'boolean' },
      sizeBytes: { type: ['integer', 'null'], minimum: 0 }, modifiedAt: { type: ['string', 'null'], pattern: ISO_PATTERN },
    },
  }],
} as const;

export const logTargetSchema = {
  type: 'object', additionalProperties: false, required: ['targetKey', 'name', 'pmId', 'matchStatus'],
  properties: {
    targetKey: { type: 'string', pattern: TARGET_KEY_PATTERN }, name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' },
    pmId: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 }, matchStatus: { type: 'string', enum: MATCH },
  },
} as const;

const pollCommon = {
  broker: { type: 'string', enum: ['ok', 'unavailable', 'unsupported'] },
  daemon: { type: ['string', 'null'], enum: ['ok', 'unavailable', null] }, allowlist: { type: ['string', 'null'], enum: ['ok', 'invalid', null] },
} as const;
/** Version 1 (allowlist, ≤ 50 targets) or version 2 (mode, ≤ 500 targets — every process of the PM2 owner). */
export const agentPollSchema = {
  anyOf: [
    {
      type: 'object', additionalProperties: false, required: ['version', 'broker', 'daemon', 'allowlist', 'targets'],
      properties: { version: { type: 'integer', enum: [1] }, ...pollCommon, targets: { type: 'array', maxItems: LOG_LIMITS.maxTargetsV1, items: logTargetSchema } },
    },
    {
      type: 'object', additionalProperties: false, required: ['version', 'mode', 'broker', 'daemon', 'allowlist', 'targets'],
      properties: {
        version: { type: 'integer', enum: [2] }, mode: { type: ['string', 'null'], enum: ['allowlist', 'auto', null] }, ...pollCommon,
        targets: { type: 'array', maxItems: LOG_LIMITS.maxTargetsV2, items: logTargetSchema },
        total: { type: 'integer', minimum: 0, maximum: 100_000 },
      },
    },
  ],
} as const;

export const agentResultSchema = {
  type: 'object', additionalProperties: false, required: ['version', 'requestId', 'outcome', 'reason', 'readAt', 'stdout', 'stderr'],
  properties: {
    version: { type: 'integer', enum: [1] }, requestId: { type: 'string', pattern: UUID_PATTERN },
    outcome: { type: 'string', enum: ['ok', 'rejected', 'failed'] }, reason: { type: ['string', 'null'], enum: [...LOG_REASONS, null] },
    readAt: { type: 'string', pattern: ISO_PATTERN }, stdout: logStreamSchema, stderr: logStreamSchema,
  },
} as const;

/** Cross-field checks: ok ⇔ no reason and both streams present; bounded total text. */
export function resultProblem(r: LogResult): string | null {
  if ((r.outcome === 'ok') !== (r.reason === null)) return 'reason';
  if ((r.outcome === 'ok') !== (r.stdout !== null && r.stderr !== null)) return 'streams';
  const bytes = Buffer.byteLength(r.stdout?.text ?? '') + Buffer.byteLength(r.stderr?.text ?? '');
  return bytes > LOG_LIMITS.totalTextBytes ? 'size' : null;
}

export type ViewStatus = 'pending' | 'done' | 'expired';
export interface RequestView { requestId: string; serverId: string; targetKey: string; serviceName: string; status: ViewStatus; deadlineAt: string; result: LogResult | null }
export interface Delivered { requestId: string; targetKey: string; lines: number; deadlineAt: string }
/** null: unknown or not the requester's (no detail); limit_*: refused before any waiter/timer was created. */
export type GetOutcome = RequestView | null | 'limit_request' | 'limit_actor' | 'limit_global';
export type CreateOutcome =
  | { request: RequestView; audit: boolean }
  | 'not_connected' | 'unsupported' | 'broker_unavailable' | 'target_not_allowed' | 'rate_limited' | 'busy';

interface Entry {
  id: string; serverId: string; targetKey: string; serviceName: string; actorUserId: string; lines: number;
  deadline: number; state: 'pending' | 'delivered' | 'done' | 'expired'; result: LogResult | null; finishedAt: number | null;
  waiters: Set<() => void>;
}
interface AgentState {
  seenAt: number; report: AgentLogReport;
  waiter: { resolve: (r: Delivered[]) => void; timer: NodeJS.Timeout } | null;
}

export class LogHub {
  private readonly requests = new Map<string, Entry>();
  private readonly agents = new Map<string, AgentState>();
  private readonly rate = new Map<string, number[]>();
  private readonly audited = new Map<string, number>();
  private readonly actorWaiters = new Map<string, number>();
  private waiters = 0;
  /** After close() nothing is held any more: a late long-poll or result wait is answered at once (shutdown). */
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => { this.cleanup(); }, 5_000);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const a of this.agents.values()) this.release(a, []);
    for (const e of this.requests.values()) for (const w of [...e.waiters]) w();
  }

  /** Bounded sizes for tests/observability (no content). */
  stats() {
    let waitersInRequests = 0;
    for (const e of this.requests.values()) waitersInRequests += e.waiters.size;
    return { requests: this.requests.size, agents: this.agents.size, waiters: this.waiters, waitingActors: this.actorWaiters.size, waitersInRequests };
  }

  status(serverId: string): { state: 'supported' | 'not_connected' | 'unsupported' | 'broker_unavailable'; reportedAt: string | null; targets: LogTarget[] } {
    const a = this.agents.get(serverId);
    if (!a || this.now() - a.seenAt > LOG_LIMITS.agentSeenMs) return { state: 'not_connected', reportedAt: a ? new Date(a.seenAt).toISOString() : null, targets: [] };
    const reportedAt = new Date(a.seenAt).toISOString();
    if (a.report.broker === 'unsupported') return { state: 'unsupported', reportedAt, targets: [] };
    // An auto broker (version 2) has no allowlist at all; an allowlist broker needs a valid one.
    if (a.report.broker !== 'ok' || (a.report.allowlist !== 'ok' && a.report.mode !== 'auto')) return { state: 'broker_unavailable', reportedAt, targets: [] };
    return { state: 'supported', reportedAt, targets: a.report.targets };
  }

  /** `serviceName`: the service the caller authorised (ADR-028); it must still be the reported name of the target. */
  create(input: { serverId: string; targetKey: string; serviceName: string; actorUserId: string; lines: number }): CreateOutcome {
    this.cleanup();
    const st = this.status(input.serverId);
    if (st.state !== 'supported') return st.state;
    if (!st.targets.some((t) => t.targetKey === input.targetKey && t.name === input.serviceName && t.matchStatus === 'ok')) return 'target_not_allowed';
    const now = this.now();
    const hits = (this.rate.get(input.actorUserId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= LOG_LIMITS.ratePerActorPerMinute) return 'rate_limited';
    const pending = [...this.requests.values()].filter((e) => e.actorUserId === input.actorUserId && (e.state === 'pending' || e.state === 'delivered')).length;
    if (pending >= LOG_LIMITS.maxPendingPerActor || this.requests.size >= LOG_LIMITS.maxRequests) return 'busy';
    hits.push(now);
    this.rate.set(input.actorUserId, hits);
    const entry: Entry = {
      id: randomUUID(), serverId: input.serverId, targetKey: input.targetKey, serviceName: input.serviceName, actorUserId: input.actorUserId, lines: input.lines,
      deadline: now + LOG_LIMITS.requestDeadlineMs, state: 'pending', result: null, finishedAt: null, waiters: new Set(),
    };
    this.requests.set(entry.id, entry);
    const auditKey = `${input.actorUserId}|${input.serverId}|${input.targetKey}`;
    const audit = now - (this.audited.get(auditKey) ?? -Infinity) >= LOG_LIMITS.auditThrottleMs;
    if (audit) this.audited.set(auditKey, now);
    // Hand it to a waiting Agent poll right away.
    const agent = this.agents.get(input.serverId);
    if (agent?.waiter) this.release(agent, this.takeFor(input.serverId));
    return { request: this.view(entry), audit };
  }

  /** Agent long-poll: records the report, returns undelivered requests at once or waits (bounded). */
  agentPoll(serverId: string, report: AgentLogReport, onClose: (cb: () => void) => void): Promise<Delivered[]> {
    this.cleanup();
    const prev = this.agents.get(serverId);
    if (prev?.waiter) this.release(prev, []); // a newer poll supersedes an older one
    const state: AgentState = { seenAt: this.now(), report, waiter: null };
    this.agents.set(serverId, state);
    const ready = this.takeFor(serverId);
    if (this.closed) return Promise.resolve(ready);
    // Always hold when there is nothing to do (also when the broker is not ok): the Agent re-polls at once after
    // every answer, so an immediate empty answer would turn into a busy loop.
    if (ready.length > 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.release(state, []); }, LOG_LIMITS.agentHoldMs);
      state.waiter = { resolve, timer };
      onClose(() => { if (state.waiter?.resolve === resolve) this.release(state, []); });
    });
  }

  /** The requester's own request (server + service), without waiting — for the access re-check before a read. */
  peek(requestId: string, actorUserId: string): { serverId: string; serviceName: string } | null {
    const e = this.requests.get(requestId);
    return e && e.actorUserId === actorUserId ? { serverId: e.serverId, serviceName: e.serviceName } : null;
  }

  agentResult(serverId: string, requestId: string, result: LogResult): 'recorded' | 'not_found' | 'conflict' {
    this.cleanup();
    const e = this.requests.get(requestId);
    if (!e || e.serverId !== serverId) return 'not_found';
    if (e.state !== 'delivered') return 'conflict';
    e.state = 'done';
    e.result = result;
    e.finishedAt = this.now();
    for (const w of [...e.waiters]) w();
    return 'recorded';
  }

  /**
   * The requester's own request only; waits (bounded) for completion. Unknown/foreign → null, checked before any limit.
   * Waiters are bounded per request, per actor and overall; each one ends exactly once — on the result, the deadline,
   * its own wait timeout, `onClose` (client went away; the shared request itself is not cancelled) or shutdown.
   */
  async get(requestId: string, actorUserId: string, options: { waitMs?: number; onClose?: (cb: () => void) => void } = {}): Promise<GetOutcome> {
    this.cleanup();
    const e = this.requests.get(requestId);
    if (!e || e.actorUserId !== actorUserId) return null;
    if (e.state === 'pending' || e.state === 'delivered') {
      const until = Math.min(e.deadline - this.now(), options.waitMs ?? LOG_LIMITS.userWaitMs);
      if (until > 0 && !this.closed) {
        const byActor = this.actorWaiters.get(actorUserId) ?? 0;
        if (e.waiters.size >= LOG_LIMITS.maxWaitersPerRequest) return 'limit_request';
        if (byActor >= LOG_LIMITS.maxWaitersPerActor) return 'limit_actor';
        if (this.waiters >= LOG_LIMITS.maxWaiters) return 'limit_global';
        this.waiters += 1;
        this.actorWaiters.set(actorUserId, byActor + 1);
        await new Promise<void>((resolve) => {
          let ended = false;
          const end = () => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            e.waiters.delete(end);
            this.waiters -= 1;
            const left = (this.actorWaiters.get(actorUserId) ?? 1) - 1;
            if (left > 0) this.actorWaiters.set(actorUserId, left);
            else this.actorWaiters.delete(actorUserId);
            resolve();
          };
          const timer = setTimeout(end, until);
          e.waiters.add(end);
          options.onClose?.(end);
        });
      }
      this.cleanup();
    }
    return this.view(e);
  }

  private takeFor(serverId: string): Delivered[] {
    const out: Delivered[] = [];
    for (const e of this.requests.values()) {
      if (out.length >= LOG_LIMITS.maxPerPoll) break;
      if (e.serverId === serverId && e.state === 'pending') {
        e.state = 'delivered';
        out.push({ requestId: e.id, targetKey: e.targetKey, lines: e.lines, deadlineAt: new Date(e.deadline).toISOString() });
      }
    }
    return out;
  }

  private release(state: AgentState, requests: Delivered[]): void {
    const w = state.waiter;
    if (!w) return;
    state.waiter = null;
    clearTimeout(w.timer);
    w.resolve(requests);
  }

  private view(e: Entry): RequestView {
    const status: ViewStatus = e.state === 'done' ? 'done' : e.state === 'expired' ? 'expired' : 'pending';
    return { requestId: e.id, serverId: e.serverId, targetKey: e.targetKey, serviceName: e.serviceName, status, deadlineAt: new Date(e.deadline).toISOString(), result: e.state === 'done' ? e.result : null };
  }

  /** Expires overdue requests, drops finished ones after the TTL and prunes the throttling maps. */
  cleanup(): void {
    const now = this.now();
    for (const [id, e] of this.requests) {
      if ((e.state === 'pending' || e.state === 'delivered') && now > e.deadline) {
        e.state = 'expired';
        e.finishedAt = now;
        for (const w of [...e.waiters]) w();
      }
      if (e.finishedAt !== null && now - e.finishedAt > LOG_LIMITS.resultTtlMs) this.requests.delete(id);
    }
    for (const [k, hits] of this.rate) {
      const recent = hits.filter((t) => now - t < 60_000);
      if (recent.length === 0) this.rate.delete(k);
      else this.rate.set(k, recent);
    }
    for (const [k, t] of this.audited) if (now - t >= LOG_LIMITS.auditThrottleMs) this.audited.delete(k);
    for (const [k, a] of this.agents) if (!a.waiter && now - a.seenAt > LOG_LIMITS.agentSeenMs * 10) this.agents.delete(k);
  }
}
