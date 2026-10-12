import type { FastifyBaseLogger } from 'fastify';
import { buildApp, type LogDestination } from './app.js';
import { type AppConfig, ConfigError, type DbConfig, describeConfig, type EnvSource, loadConfig } from './config.js';
import { createDatabase, type Database } from './database.js';
import { createLifecycle, installSignalHandlers, type SignalTarget, StartupError } from './lifecycle.js';

export const DEFAULT_FORCE_EXIT_DELAY_MS = 2_000;

export interface RunServerOptions {
  env: EnvSource;
  signals: SignalTarget;
  /** Terminates the process. Only the executable passes process.exit; tests pass a spy. */
  exit: (code: number) => void;
  stderr: { write(chunk: string): unknown };
  logStream?: LogDestination;
  /** Test seams; production uses the real pool and configured timeouts. */
  createDatabase?: (config: DbConfig, log: FastifyBaseLogger) => Database;
  shutdownTimeoutMs?: number;
  forceExitDelayMs?: number;
}

/**
 * Executable logic: config → app → listen → signal handling.
 * Resolves 0 once listening, 1 on failure. After a failed start it guarantees termination in bounded time:
 * immediately if cleanup failed/timed out, otherwise via an unref'd timer in case another handle stays open.
 */
export async function runServer(options: RunServerOptions): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig(options.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    options.stderr.write(`Invalid configuration, API not started:\n${error.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 1;
  }

  const makeDatabase = options.createDatabase ?? ((db: DbConfig, log: FastifyBaseLogger) => createDatabase(db, log));
  const app = buildApp({
    logLevel: config.logLevel,
    readinessTimeoutMs: config.readinessTimeoutMs,
    createDatabase: (log) => makeDatabase(config.db, log),
    ...(options.logStream ? { logStream: options.logStream } : {}),
  });
  const lifecycle = createLifecycle(app, {
    ...config.api,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? config.shutdownTimeoutMs,
  });
  const removeSignalHandlers = installSignalHandlers(options.signals, lifecycle, options.exit);

  try {
    await lifecycle.start();
  } catch (error) {
    removeSignalHandlers();
    if (!(error instanceof StartupError) || !error.cleanedUp) {
      options.exit(1);
      return 1;
    }
    setTimeout(() => { options.exit(1); }, options.forceExitDelayMs ?? DEFAULT_FORCE_EXIT_DELAY_MS).unref();
    return 1;
  }

  app.log.info(describeConfig(config), 'API started');
  return 0;
}
