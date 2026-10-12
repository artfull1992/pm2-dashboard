import type { FastifyInstance } from 'fastify';
import { withTimeout } from './database.js';
import { describeError, type ErrorMeta, formatErrorMeta } from './errors.js';

/** Startup failed. `cleanedUp` is false when closing the app/pool failed or exceeded the shutdown timeout. */
export class StartupError extends Error {
  readonly meta: ErrorMeta;
  readonly cleanedUp: boolean;

  constructor(meta: ErrorMeta, cleanedUp: boolean) {
    super('API failed to start');
    this.name = 'StartupError';
    this.meta = meta;
    this.cleanedUp = cleanedUp;
  }
}

export interface Lifecycle {
  /** Starts listening. On failure closes the app (and its pool) within the timeout and rejects with StartupError. */
  start(): Promise<void>;
  /** Idempotent: every call returns the same promise. Resolves true on a clean close within the timeout. */
  shutdown(reason: string): Promise<boolean>;
}

export interface LifecycleOptions {
  host: string;
  port: number;
  shutdownTimeoutMs: number;
}

export function createLifecycle(app: FastifyInstance, options: LifecycleOptions): Lifecycle {
  let shuttingDown: Promise<boolean> | undefined;

  const close = async (): Promise<boolean> => {
    try {
      await withTimeout(app.close(), options.shutdownTimeoutMs);
      app.log.info('Shutdown complete');
      return true;
    } catch (error) {
      app.log.error({ error: describeError(error) }, 'Shutdown failed or timed out');
      return false;
    }
  };

  const shutdown = (reason: string): Promise<boolean> => {
    if (shuttingDown) {
      app.log.warn({ reason }, 'Shutdown already in progress');
      return shuttingDown;
    }
    app.log.info({ reason }, 'Shutdown started');
    shuttingDown = close();
    return shuttingDown;
  };

  return {
    async start() {
      try {
        await app.listen({ host: options.host, port: options.port });
      } catch (error) {
        const meta = describeError(error);
        app.log.error({ error: meta }, 'Failed to start listener');
        throw new StartupError(meta, await shutdown('startup-failure'));
      }
    },
    shutdown,
  };
}

export interface SignalTarget {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/** Wires SIGINT/SIGTERM to a single shutdown; onExit runs once with 0 (clean) or 1 (failed/timed out). */
export function installSignalHandlers(
  target: SignalTarget,
  lifecycle: Lifecycle,
  onExit: (code: number) => void,
  signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'],
): () => void {
  let exiting = false;
  const handler = (signal: NodeJS.Signals): void => {
    const pending = lifecycle.shutdown(signal);
    if (exiting) return;
    exiting = true;
    void pending.then((ok) => { onExit(ok ? 0 : 1); });
  };
  for (const signal of signals) target.on(signal, handler);
  return () => {
    for (const signal of signals) target.off(signal, handler);
  };
}

export type FatalEvent = 'uncaughtException' | 'unhandledRejection';

export interface FatalTarget {
  on(event: FatalEvent, listener: (error: unknown) => void): unknown;
}

/**
 * Replaces Node's default fatal output (which prints message and stack) with ErrorMeta only, then exits 1.
 * No graceful shutdown: process state is unknown after an uncaught error; the supervisor restarts it.
 */
export function installFatalHandlers(target: FatalTarget, stderr: { write(chunk: string): unknown }, exit: (code: number) => void): void {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    target.on(event, (error) => {
      stderr.write(`Fatal ${event} (${formatErrorMeta(describeError(error))}); exiting\n`);
      exit(1);
    });
  }
}
