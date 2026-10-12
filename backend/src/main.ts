import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ConfigError, describeConfig, loadConfig, mergeEnv, readEnvFile } from './config.js';
import { createDatabase } from './database.js';
import { createLifecycle, installSignalHandlers } from './lifecycle.js';

// backend/src or backend/dist → repository root. ENV_FILE overrides (e.g. a systemd-managed path).
const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

async function main(): Promise<number> {
  let config;
  try {
    const envFile = process.env.ENV_FILE ?? DEFAULT_ENV_FILE;
    config = loadConfig(mergeEnv(readEnvFile(envFile), process.env));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`Invalid configuration, API not started:\n${error.issues.map((i) => `  - ${i}`).join('\n')}\n`);
    return 1;
  }

  const app = buildApp({
    logLevel: config.logLevel,
    readinessTimeoutMs: config.readinessTimeoutMs,
    createDatabase: (log) => createDatabase(config.db, log),
  });
  const lifecycle = createLifecycle(app, { ...config.api, shutdownTimeoutMs: config.shutdownTimeoutMs });

  // process.exit is needed only if shutdown timed out and handles are still open.
  installSignalHandlers(process, lifecycle, (code) => process.exit(code));

  try {
    await lifecycle.start();
  } catch {
    return 1;
  }
  app.log.info(describeConfig(config), 'API started');
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`Fatal startup error: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}\n`);
    process.exitCode = 1;
  },
);
