// Entry point: node backend/dist/bootstrap-admin.js --email <email> [--password-stdin]
// Reads DB_* from ENV_FILE (if set) and the process environment (which wins).
import { runBootstrapCli } from './bootstrap-cli.js';
import { mergeEnv, readEnvFile } from './config.js';
import { describeError, formatErrorMeta } from './errors.js';

try {
  const env = mergeEnv(process.env.ENV_FILE ? readEnvFile(process.env.ENV_FILE) : {}, process.env);
  process.exitCode = await runBootstrapCli(process.argv.slice(2), {
    env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`[bootstrap-admin] fatal (${formatErrorMeta(describeError(error))})\n`);
  process.exitCode = 1;
}
