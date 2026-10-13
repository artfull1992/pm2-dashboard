import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UI_ORIGIN } from './env.js';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Starts the compiled Agent with a 600 env file; output is captured, never printed (it must not contain the token).
 * `extra` adds NC_AGENT_* settings (e.g. the inventory file for Task 008).
 */
export function startAgent(token: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-e2e-agent-'));
  const envFile = join(dir, 'agent.env');
  writeFileSync(envFile, [
    `NC_AGENT_API_URL=${UI_ORIGIN}`, 'NC_AGENT_ALLOW_INSECURE_LOOPBACK=true', `NC_AGENT_TOKEN=${token}`,
    'NC_AGENT_INTERVAL_SECONDS=5', 'NC_AGENT_TIMEOUT_SECONDS=5', 'NC_AGENT_MAX_BACKOFF_SECONDS=30',
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ].join('\n') + '\n', { mode: 0o600 });
  const child: ChildProcess = spawn(process.execPath, [join(ROOT, 'agent', 'dist', 'main.js')], {
    env: { PATH: process.env.PATH ?? '', ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => { output += c.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return {
    output: () => output,
    stop: async () => { child.kill('SIGTERM'); const code = await exited; rmSync(dir, { recursive: true, force: true }); return code; },
  };
}
