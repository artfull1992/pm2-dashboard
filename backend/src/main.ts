import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeEnv, readEnvFile } from './config.js';
import { describeError, formatErrorMeta } from './errors.js';
import { installFatalHandlers } from './lifecycle.js';
import { runServer } from './server.js';

// backend/src or backend/dist → repository root. ENV_FILE overrides (e.g. a systemd-managed path).
const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

const exit = (code: number): void => process.exit(code);
installFatalHandlers(process, process.stderr, exit);

try {
  const env = mergeEnv(readEnvFile(process.env.ENV_FILE ?? DEFAULT_ENV_FILE), process.env);
  const code = await runServer({ env, signals: process, exit, stderr: process.stderr });
  if (code !== 0) process.exitCode = code;
} catch (error) {
  process.stderr.write(`Fatal startup error (${formatErrorMeta(describeError(error))})\n`);
  exit(1);
}
