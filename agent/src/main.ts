// Entry point: node agent/dist/main.js   (config: ENV_FILE, mode 600, owned by the agent user)
// Exit codes: 0 graceful stop; 2 invalid configuration (systemd should not loop on it); 1 unexpected error.
import { runAgent } from './agent.js';
import { AGENT_VERSION, AgentConfigError, loadAgentConfig, readSecureEnvFile } from './config.js';

const log = (level: 'info' | 'warn' | 'error', event: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...event })}\n`);
};

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log('info', { msg: 'shutdown requested', signal });
    controller.abort();
  });
}

try {
  const file = process.env.ENV_FILE;
  const env = file ? { ...readSecureEnvFile(file), ...pickAgentEnv(process.env) } : pickAgentEnv(process.env);
  const config = loadAgentConfig(env);
  log('info', { msg: 'agent started', version: AGENT_VERSION, apiOrigin: config.apiUrl.origin, intervalSeconds: config.intervalSeconds });
  await runAgent(config, controller.signal, {
    logger: { info: (e) => { log('info', e); }, warn: (e) => { log('warn', e); } },
  });
  log('info', { msg: 'agent stopped' });
} catch (error) {
  if (error instanceof AgentConfigError) {
    log('error', { msg: 'invalid configuration', issues: error.issues });
    process.exitCode = 2;
  } else {
    log('error', { msg: 'unexpected error', name: error instanceof Error ? error.name : 'unknown' });
    process.exitCode = 1;
  }
}

/** Only NC_AGENT_* keys from the process environment override the file (nothing else is read). */
function pickAgentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (key.startsWith('NC_AGENT_') && value !== undefined) out[key] = value;
  return out;
}
