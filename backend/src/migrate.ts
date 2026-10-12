// Entry point: node backend/dist/migrate.js <status|up>
// Reads DB_* from ENV_FILE (if set) and the process environment (which wins). Never started by the API.
import { mergeEnv, readEnvFile } from './config.js';
import { describeError, formatErrorMeta } from './errors.js';
import { runMigrateCli } from './migrate-cli.js';

try {
  const env = mergeEnv(process.env.ENV_FILE ? readEnvFile(process.env.ENV_FILE) : {}, process.env);
  process.exitCode = await runMigrateCli(process.argv.slice(2), { env, stdout: process.stdout, stderr: process.stderr });
} catch (error) {
  process.stderr.write(`[migrate] fatal (${formatErrorMeta(describeError(error))})\n`);
  process.exitCode = 1;
}
