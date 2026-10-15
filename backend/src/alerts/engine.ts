import { describeError } from '../errors.js';
import { type OpenError, open, type SecretKey } from './secret.js';
import { type AlertSettings, evaluationConfig } from './settings.js';
import type { SettingsStore } from './settings-store.js';
import { renderMessage, type SendOutcome, sendToSlack } from './slack.js';
import type { AlertsStore } from './store.js';

// Alerts worker inside the API process (ADR-021/022). Two single-flight loops (evaluation, delivery) tick every
// TICK_MS and read ONE consistent settings + integration snapshot per cycle from the database, so changes made in
// the admin UI apply without a restart: switching off stops new work at the next tick, a new interval applies to the
// next due check. start() creates a fresh AbortController each time (enable → disable → enable is safe); stop() halts
// scheduling, aborts in-flight Slack I/O and waits (bounded) for running cycles — before the database is closed.

export const TICK_MS = 5_000;
/** Slack: about 1 message per second per webhook. */
export const SEND_SPACING_MS = 1_100;
const BATCH = 5;
const STOP_WAIT_MS = 3_000;

export interface EngineLogger { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void }

export interface AlertsRuntime {
  settings: AlertSettings;
  integration: { generation: number; state: 'not_configured' | 'configured' | 'error'; error: OpenError | null; webhook: string | null };
}
export interface RuntimeSource { load(): Promise<AlertsRuntime> }

/** Settings + decrypted webhook (fail-closed: no key / wrong key / tampered → state "error", no webhook). */
export function createRuntimeSource(settings: SettingsStore, key: SecretKey | null): RuntimeSource {
  return {
    async load() {
      // Sequential: a failing read never leaves another promise unobserved.
      const s = await settings.getSettings();
      const i = await settings.getIntegration();
      if (!i.sealed) return { settings: s, integration: { generation: i.generation, state: 'not_configured', error: null, webhook: null } };
      const opened = open(i.sealed, i.generation, key);
      return opened.ok
        ? { settings: s, integration: { generation: i.generation, state: 'configured', error: null, webhook: opened.value } }
        : { settings: s, integration: { generation: i.generation, state: 'error', error: opened.error, webhook: null } };
    },
  };
}

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
  /** Fresh per start(): an aborted controller is never reused. */
  private abort = new AbortController();
  private lastEvaluationStartedMs: number | null = null;
  private readonly s: EngineStats = {
    running: false, lastEvaluationAt: null, lastEvaluationOk: null, lastEvaluationError: null, evaluations: 0, lastDeliveryAt: null, lastDeliveryError: null,
  };

  constructor(
    private readonly store: AlertsStore,
    private readonly source: RuntimeSource,
    private readonly publicUrl: string | null,
    private readonly log: EngineLogger,
    private readonly deps: { fetchImpl?: typeof fetch; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number } = {},
  ) {}

  stats(): EngineStats { return { ...this.s }; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.s.running = true;
    this.scheduleEval(0);
    this.scheduleDelivery(TICK_MS);
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
      this.evalRunning = this.evaluateTick().finally(() => { this.evalRunning = null; this.scheduleEval(TICK_MS); });
    }, delayMs);
    this.evalTimer.unref();
  }

  private scheduleDelivery(delayMs: number): void {
    if (this.stopped) return;
    this.deliveryTimer = setTimeout(() => {
      this.deliveryRunning = this.deliverNow().finally(() => { this.deliveryRunning = null; this.scheduleDelivery(TICK_MS); });
    }, delayMs);
    this.deliveryTimer.unref();
  }

  private async loadRuntime(): Promise<AlertsRuntime | null> {
    try {
      return await this.source.load();
    } catch (error) {
      this.log.error({ error: describeError(error) }, 'Alert settings could not be loaded');
      return null;
    }
  }

  /** Runs an evaluation when the engine is enabled and the configured interval has passed since the last one. */
  async evaluateTick(): Promise<void> {
    const rt = await this.loadRuntime();
    if (!rt?.settings.engineEnabled) return;
    const now = (this.deps.now ?? Date.now)();
    if (this.lastEvaluationStartedMs !== null && now - this.lastEvaluationStartedMs < rt.settings.intervalSeconds * 1000) return;
    this.lastEvaluationStartedMs = now;
    await this.evaluateNow(rt);
  }

  /** One evaluation with a given (or freshly loaded) snapshot. Never throws. */
  async evaluateNow(runtime?: AlertsRuntime): Promise<void> {
    const rt = runtime ?? await this.loadRuntime();
    if (!rt) return;
    try {
      const config = evaluationConfig(rt.settings, { usable: rt.integration.state === 'configured', generation: rt.integration.state === 'configured' ? rt.integration.generation : null });
      const r = await this.store.evaluateOnce(config);
      if (r.skipped) return;
      this.s.evaluations += 1;
      this.s.lastEvaluationAt = r.at;
      this.s.lastEvaluationOk = true;
      this.s.lastEvaluationError = null;
      if (r.opened + r.resolved + r.dropped + r.retired > 0) this.log.info({ opened: r.opened, resolved: r.resolved, enqueued: r.enqueued, dropped: r.dropped, retired: r.retired }, 'Alerts evaluated');
      if (r.dropped > 0) this.log.warn({ dropped: r.dropped, queueMax: config.queueMax }, 'Alert notifications dropped: queue full');
    } catch (error) {
      const meta = describeError(error);
      this.s.lastEvaluationOk = false;
      this.s.lastEvaluationError = meta.category;
      this.log.error({ error: meta }, 'Alerts evaluation failed');
    }
  }

  /** One delivery batch for the CURRENT integration generation. Never throws; never logs the URL or message text. */
  async deliverNow(runtime?: AlertsRuntime): Promise<void> {
    const rt = runtime ?? await this.loadRuntime();
    if (!rt) return;
    const { settings, integration } = rt;
    if (!settings.deliveryEnabled || integration.state !== 'configured' || integration.webhook === null) {
      if (settings.deliveryEnabled && integration.state === 'error') this.s.lastDeliveryError = integration.error;
      return;
    }
    const url = integration.webhook;
    const signal = this.abort.signal;
    let items;
    try {
      items = await this.store.claim(BATCH, integration.generation);
    } catch (error) {
      this.s.lastDeliveryError = 'claim_failed';
      this.log.error({ error: describeError(error) }, 'Alert delivery claim failed');
      return;
    }
    const sleep = this.deps.sleep ?? ((ms: number, sig: AbortSignal) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      sig.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
    }));
    for (const [n, item] of items.entries()) {
      if (n > 0) await sleep(SEND_SPACING_MS, signal);
      const outcome: SendOutcome = signal.aborted
        ? { kind: 'unknown', code: 'aborted' }
        : await sendToSlack(url, renderMessage(item.kind, item.incident, this.publicUrl), {
          timeoutMs: settings.httpTimeoutMs, signal, ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        });
      const last = item.attempts >= settings.maxAttempts;
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
        // The lease expires and the item is retried later (if still current); nothing else is affected.
        this.log.error({ error: describeError(error) }, 'Alert delivery result could not be recorded');
      }
      if (outcome.kind !== 'sent') this.log.warn({ outbox: item.id, kind: item.kind, outcome: outcome.kind, code: outcome.code, attempts: item.attempts }, 'Alert delivery not confirmed');
      if (signal.aborted) break;
    }
  }
}
