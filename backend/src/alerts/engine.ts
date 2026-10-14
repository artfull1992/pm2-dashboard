import type { AlertsConfig } from '../config.js';
import { describeError } from '../errors.js';
import { renderMessage, type SendOutcome, sendToSlack } from './slack.js';
import type { AlertsStore } from './store.js';

// Alerts worker inside the API process (ADR-021): two single-flight loops — evaluation every intervalSeconds and
// delivery every DELIVERY_TICK_MS — scheduled with setTimeout (never overlapping themselves). A failing cycle is
// logged as metadata and the next one runs; the API is never affected. stop() halts scheduling, aborts an in-flight
// Slack request and waits (bounded) for the running cycle, before the database is closed.

export const DELIVERY_TICK_MS = 5_000;
/** Slack: about 1 message per second per webhook. */
export const SEND_SPACING_MS = 1_100;
const BATCH = 5;
const STOP_WAIT_MS = 3_000;

export interface EngineLogger { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void }

export interface EngineStats {
  running: boolean;
  lastEvaluationAt: string | null;
  lastEvaluationOk: boolean | null;
  lastEvaluationError: string | null;
  evaluations: number;
  lastDeliveryAt: string | null;
  lastDeliveryError: string | null;
}

/** Exponential backoff with ±20 % jitter, capped at 30 min; Retry-After (429) is honoured as a lower bound. */
export function backoffSeconds(attempts: number, retryAfterSeconds: number | null, random: () => number = Math.random): number {
  const base = Math.min(30 * 2 ** Math.max(0, attempts - 1), 1800);
  const jittered = Math.round(base * (0.8 + random() * 0.4));
  return Math.max(jittered, retryAfterSeconds ?? 0, 1);
}

export class AlertsEngine {
  private stopped = true;
  private evalTimer: NodeJS.Timeout | null = null;
  private deliveryTimer: NodeJS.Timeout | null = null;
  private evalRunning: Promise<void> | null = null;
  private deliveryRunning: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly s: EngineStats = {
    running: false, lastEvaluationAt: null, lastEvaluationOk: null, lastEvaluationError: null, evaluations: 0, lastDeliveryAt: null, lastDeliveryError: null,
  };

  constructor(
    private readonly store: AlertsStore,
    private readonly config: AlertsConfig,
    private readonly log: EngineLogger,
    private readonly deps: { fetchImpl?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
  ) {}

  stats(): EngineStats { return { ...this.s }; }

  start(): void {
    if (!this.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.s.running = true;
    this.scheduleEval(0);
    if (this.config.deliveryEnabled) this.scheduleDelivery(DELIVERY_TICK_MS);
  }

  /** Idempotent, bounded: stops scheduling, aborts Slack I/O, waits ≤ STOP_WAIT_MS for running cycles. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.s.running = false;
    if (this.evalTimer) clearTimeout(this.evalTimer);
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    this.abort.abort();
    const running = [this.evalRunning, this.deliveryRunning].filter((p): p is Promise<void> => p !== null);
    if (running.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(running), new Promise<void>((r) => { timer = setTimeout(r, STOP_WAIT_MS); })]);
    clearTimeout(timer);
  }

  private scheduleEval(delayMs: number): void {
    if (this.stopped) return;
    this.evalTimer = setTimeout(() => {
      this.evalRunning = this.evaluateNow().finally(() => { this.evalRunning = null; this.scheduleEval(this.config.intervalSeconds * 1000); });
    }, delayMs);
    this.evalTimer.unref();
  }

  private scheduleDelivery(delayMs: number): void {
    if (this.stopped) return;
    this.deliveryTimer = setTimeout(() => {
      this.deliveryRunning = this.deliverNow().finally(() => { this.deliveryRunning = null; this.scheduleDelivery(DELIVERY_TICK_MS); });
    }, delayMs);
    this.deliveryTimer.unref();
  }

  /** One evaluation (also used by tests). Never throws. */
  async evaluateNow(): Promise<void> {
    try {
      const r = await this.store.evaluateOnce(this.config);
      if (r.skipped) return;
      this.s.evaluations += 1;
      this.s.lastEvaluationAt = r.at;
      this.s.lastEvaluationOk = true;
      this.s.lastEvaluationError = null;
      if (r.opened + r.resolved + r.dropped > 0) {
        this.log.info({ opened: r.opened, resolved: r.resolved, enqueued: r.enqueued, dropped: r.dropped }, 'Alerts evaluated');
      }
      if (r.dropped > 0) this.log.warn({ dropped: r.dropped, queueMax: this.config.queueMax }, 'Alert notifications dropped: queue full');
    } catch (error) {
      const meta = describeError(error);
      this.s.lastEvaluationOk = false;
      this.s.lastEvaluationError = meta.category;
      this.log.error({ error: meta }, 'Alerts evaluation failed');
    }
  }

  /** One delivery batch (also used by tests). Never throws; never logs the webhook URL or message text. */
  async deliverNow(): Promise<void> {
    const url = this.config.webhookUrl;
    if (!this.config.deliveryEnabled || url === null) return;
    let items;
    try {
      items = await this.store.claim(BATCH);
    } catch (error) {
      this.s.lastDeliveryError = 'claim_failed';
      this.log.error({ error: describeError(error) }, 'Alert delivery claim failed');
      return;
    }
    const sleep = this.deps.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    }));
    for (const [n, item] of items.entries()) {
      if (n > 0) await sleep(SEND_SPACING_MS, this.abort.signal);
      const outcome: SendOutcome = this.abort.signal.aborted
        ? { kind: 'unknown', code: 'aborted' }
        : await sendToSlack(url, renderMessage(item.kind, item.incident, this.config.publicUrl), {
          timeoutMs: this.config.httpTimeoutMs, signal: this.abort.signal, ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        });
      const last = item.attempts >= this.config.maxAttempts;
      try {
        if (outcome.kind === 'sent') {
          await this.store.finish(item, { status: 'sent' });
          this.s.lastDeliveryAt = new Date().toISOString();
          this.s.lastDeliveryError = null;
        } else if (outcome.kind === 'permanent') {
          await this.store.finish(item, { status: 'failed', code: outcome.code });
          this.s.lastDeliveryError = outcome.code;
        } else if (outcome.kind === 'retry') {
          await this.store.finish(item, last ? { status: 'failed', code: outcome.code } : { status: 'queued', code: outcome.code, delaySeconds: backoffSeconds(item.attempts, outcome.retryAfterSeconds) });
          this.s.lastDeliveryError = outcome.code;
        } else {
          // Unknown outcome (timeout / aborted after sending): retried — at-least-once, a duplicate is possible.
          await this.store.finish(item, last ? { status: 'unknown', code: outcome.code }
            : { status: 'queued', code: outcome.code, delaySeconds: outcome.code === 'aborted' ? 1 : backoffSeconds(item.attempts, null) });
          this.s.lastDeliveryError = outcome.code;
        }
      } catch (error) {
        // The lease expires and the item is retried later; nothing else is affected.
        this.log.error({ error: describeError(error) }, 'Alert delivery result could not be recorded');
      }
      if (outcome.kind !== 'sent') this.log.warn({ outbox: item.id, kind: item.kind, outcome: outcome.kind, code: outcome.code, attempts: item.attempts }, 'Alert delivery not confirmed');
      if (this.abort.signal.aborted) break;
    }
  }
}
