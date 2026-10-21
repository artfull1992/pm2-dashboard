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
  // ADR-028 (review e621e31): the request is bound to the service/definition it was authorised for. Set by the API when
  // the reported target changed before delivery or the requester lost the right; by the broker (v2) when the target
  // it resolves at read time is not the expected one.
  'target_changed', 'identity_changed', 'not_authorized',
] as const;
const MATCH = ['ok', 'not_found', 'ambiguous', 'cluster_unsupported', 'fingerprint_mismatch', 'daemon_unavailable'] as const;
const TARGET_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const ISO_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

export interface LogStream { state: (typeof STREAM_STATES)[number]; text: string; lines: number; truncated: boolean; sizeBytes: number | null; modifiedAt: string | null }
export interface LogTarget {
  targetKey: string; name: string; pmId: number | null; matchStatus: (typeof MATCH)[number];
  /** Version 2 only: definition identity of a matched target (16 hex), null otherwise. */
  identity?: string | null;
}
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

/** Version 2 log target: plus the definition identity, so a request can be bound to it (ADR-028). */
export const logTargetSchemaV2 = {
  ...logTargetSchema,
  required: [...logTargetSchema.required, 'identity'],
  properties: { ...logTargetSchema.properties, identity: { type: ['string', 'null'], pattern: '^[0-9a-f]{16}$' } },
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
        targets: { type: 'array', maxItems: LOG_LIMITS.maxTargetsV2, items: logTargetSchemaV2 },
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
export interface RequestView {
  requestId: string; serverId: string; targetKey: string; serviceName: string; status: ViewStatus; deadlineAt: string; result: LogResult | null;
  /** Delivered to a version-1 Agent: the broker could not verify the target at read time — admins only (ADR-028). */
  legacy: boolean;
}
/** A request handed to the Agent: what it reads (targetKey) and what it must still be (name, identity — version 2). */
export interface Delivered { requestId: string; targetKey: string; lines: number; deadlineAt: string; name: string; identity: string | null; actorUserId: string }
/** null: unknown or not the requester's (no detail); limit_*: refused before any waiter/timer was created. */
export type GetOutcome = RequestView | null | 'limit_request' | 'limit_actor' | 'limit_global';
export type CreateOutcome =
  | { request: RequestView; audit: boolean }
  | 'not_connected' | 'unsupported' | 'broker_unavailable' | 'target_not_allowed' | 'rate_limited' | 'busy';

interface Entry {
  id: string; serverId: string; targetKey: string; serviceName: string; actorUserId: string; lines: number;
  /** Definition identity of the target when the request was authorised (version-2 report), else null. */
  identity: string | null;
  legacy: boolean;
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

  /**
   * `scoped`: the reader is limited to granted services (ADR-028). A version-1 Agent/broker cannot verify at read time
   * that a targetKey still means the authorised service, so scoped readers get no log viewing from it (fail closed).
   */
  status(serverId: string, scoped = false): { state: 'supported' | 'not_connected' | 'unsupported' | 'broker_unavailable'; reportedAt: string | null; targets: LogTarget[] } {
    const a = this.agents.get(serverId);
    if (!a || this.now() - a.seenAt > LOG_LIMITS.agentSeenMs) return { state: 'not_connected', reportedAt: a ? new Date(a.seenAt).toISOString() : null, targets: [] };
    const reportedAt = new Date(a.seenAt).toISOString();
    if (a.report.broker === 'unsupported' || (scoped && a.report.version === 1)) return { state: 'unsupported', reportedAt, targets: [] };
    // An auto broker (version 2) has no allowlist at all; an allowlist broker needs a valid one.
    if (a.report.broker !== 'ok' || (a.report.allowlist !== 'ok' && a.report.mode !== 'auto')) return { state: 'broker_unavailable', reportedAt, targets: [] };
    return { state: 'supported', reportedAt, targets: a.report.targets };
  }

  /** `serviceName`: the service the caller authorised (ADR-028); it must still be the reported name of the target. */
  create(input: { serverId: string; targetKey: string; serviceName: string; actorUserId: string; lines: number; scoped: boolean }): CreateOutcome {
    this.cleanup();
    const st = this.status(input.serverId, input.scoped);
    if (st.state !== 'supported') return st.state;
    const target = st.targets.find((t) => t.targetKey === input.targetKey && t.name === input.serviceName && t.matchStatus === 'ok');
    if (!target) return 'target_not_allowed';
    const now = this.now();
    const hits = (this.rate.get(input.actorUserId) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= LOG_LIMITS.ratePerActorPerMinute) return 'rate_limited';
    const pending = [...this.requests.values()].filter((e) => e.actorUserId === input.actorUserId && (e.state === 'pending' || e.state === 'delivered')).length;
    if (pending >= LOG_LIMITS.maxPendingPerActor || this.requests.size >= LOG_LIMITS.maxRequests) return 'busy';
    hits.push(now);
    this.rate.set(input.actorUserId, hits);
    const entry: Entry = {
      id: randomUUID(), serverId: input.serverId, targetKey: input.targetKey, serviceName: input.serviceName, actorUserId: input.actorUserId, lines: input.lines,
      identity: target.identity ?? null, legacy: false,
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
  peek(requestId: string, actorUserId: string): { serverId: string; serviceName: string; legacy: boolean } | null {
    const e = this.requests.get(requestId);
    return e && e.actorUserId === actorUserId ? { serverId: e.serverId, serviceName: e.serviceName, legacy: e.legacy } : null;
  }

  /**
   * Ends a request that must not be read (target changed, requester no longer allowed) — without any text. Only a
   * request not yet answered by the Agent; a late result for it is then refused as a conflict.
   */
  reject(requestId: string, reason: 'target_changed' | 'identity_changed' | 'not_authorized'): void {
    const e = this.requests.get(requestId);
    if (!e || (e.state !== 'pending' && e.state !== 'delivered')) return;
    this.finish(e, { outcome: 'rejected', reason, readAt: new Date(this.now()).toISOString(), stdout: null, stderr: null });
  }

  private finish(e: Entry, result: LogResult): void {
    e.state = 'done';
    e.result = result;
    e.finishedAt = this.now();
    for (const w of [...e.waiters]) w();
  }

  agentResult(serverId: string, requestId: string, result: LogResult): 'recorded' | 'not_found' | 'conflict' {
    this.cleanup();
    const e = this.requests.get(requestId);
    if (!e || e.serverId !== serverId) return 'not_found';
    if (e.state !== 'delivered') return 'conflict';
    this.finish(e, result);
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

  /**
   * Pending requests of the server, re-checked against the Agent's CURRENT report (ADR-028): the targetKey must still
   * be the authorised service (same name, matched) and — when the request recorded one — the same definition identity.
   * Otherwise the request ends rejected without being read; it is never redirected to whatever the key means now.
   * The requester's current rights are checked by the caller (logs-routes) before anything leaves the API.
   */
  private takeFor(serverId: string): Delivered[] {
    const out: Delivered[] = [];
    const report = this.agents.get(serverId)?.report;
    for (const e of this.requests.values()) {
      if (out.length >= LOG_LIMITS.maxPerPoll) break;
      if (e.serverId !== serverId || e.state !== 'pending') continue;
      const target = report?.targets.find((t) => t.targetKey === e.targetKey);
      if (!target || target.name !== e.serviceName || target.matchStatus !== 'ok') { this.reject(e.id, 'target_changed'); continue; }
      if (e.identity !== null && target.identity !== e.identity) { this.reject(e.id, 'identity_changed'); continue; }
      e.state = 'delivered';
      e.legacy = report?.version !== 2;
      out.push({
        requestId: e.id, targetKey: e.targetKey, lines: e.lines, deadlineAt: new Date(e.deadline).toISOString(),
        name: e.serviceName, identity: e.identity, actorUserId: e.actorUserId,
      });
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
    return {
      requestId: e.id, serverId: e.serverId, targetKey: e.targetKey, serviceName: e.serviceName, status, deadlineAt: new Date(e.deadline).toISOString(),
      result: e.state === 'done' ? e.result : null, legacy: e.legacy,
    };
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
