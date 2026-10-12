import { readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Agent configuration (ADR-015). One env file (ENV_FILE, mode 600, owned by the agent's service user) holds the
// API URL and the bearer token. Errors name keys and rules only — never values.

export const AGENT_VERSION = '0.1.0';
const TOKEN_RE = /^ncag_[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface AgentConfig {
  apiUrl: URL;
  token: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  /** Upper bound for any backoff / Retry-After wait. */
  maxBackoffSeconds: number;
}

export class AgentConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid agent configuration: ${issues.join('; ')}`);
    this.name = 'AgentConfigError';
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function integer(env: Env, key: string, fallback: number, min: number, max: number, issues: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    issues.push(`${key} must be an integer between ${String(min)} and ${String(max)}`);
    return fallback;
  }
  return Number(raw);
}

export function loadAgentConfig(env: Env): AgentConfig {
  const issues: string[] = [];

  let apiUrl: URL | null = null;
  try {
    apiUrl = new URL(env.NC_AGENT_API_URL ?? '');
  } catch {
    issues.push('NC_AGENT_API_URL must be an absolute URL');
  }
  if (apiUrl) {
    const insecureLoopback = env.NC_AGENT_ALLOW_INSECURE_LOOPBACK === 'true' && apiUrl.protocol === 'http:' && LOOPBACK_HOSTS.has(apiUrl.hostname);
    if (apiUrl.protocol !== 'https:' && !insecureLoopback) {
      issues.push('NC_AGENT_API_URL must use https (http only with NC_AGENT_ALLOW_INSECURE_LOOPBACK=true on a loopback host)');
    }
    if (apiUrl.username !== '' || apiUrl.password !== '' || apiUrl.search !== '' || apiUrl.hash !== '' || (apiUrl.pathname !== '/' && apiUrl.pathname !== '')) {
      issues.push('NC_AGENT_API_URL must be a bare origin (no credentials, path, query or fragment)');
    }
  }

  const token = env.NC_AGENT_TOKEN ?? '';
  if (token === '') issues.push('NC_AGENT_TOKEN is not set (provision a credential in the UI first)');
  else if (!TOKEN_RE.test(token)) issues.push('NC_AGENT_TOKEN has an invalid format');

  const intervalSeconds = integer(env, 'NC_AGENT_INTERVAL_SECONDS', 30, 5, 300, issues);
  const timeoutSeconds = integer(env, 'NC_AGENT_TIMEOUT_SECONDS', 10, 1, 60, issues);
  const maxBackoffSeconds = integer(env, 'NC_AGENT_MAX_BACKOFF_SECONDS', 900, 30, 3600, issues);

  if (issues.length > 0 || !apiUrl) throw new AgentConfigError(issues);
  return { apiUrl, token, intervalSeconds, timeoutSeconds, maxBackoffSeconds };
}

/** The env file holds a secret: refuse it unless it is owned by us and not accessible to group/other. */
export function readSecureEnvFile(path: string, uid: number | undefined = process.getuid?.()): Record<string, string> {
  const stat = statSync(path);
  if (!stat.isFile()) throw new AgentConfigError(['ENV_FILE must be a regular file']);
  if ((stat.mode & 0o077) !== 0) throw new AgentConfigError(['ENV_FILE must not be accessible to group/other (chmod 600)']);
  if (uid !== undefined && stat.uid !== uid) throw new AgentConfigError(['ENV_FILE must be owned by the agent user']);
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}
