import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { parseEnv } from 'node:util';

// Agent configuration (ADR-015). One env file (ENV_FILE, mode 600, owned by the agent's service user) holds the
// API URL and the bearer token. Errors name keys and rules only — never values.

export const AGENT_VERSION = '0.5.0';
const TOKEN_RE = /^ncag_[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface AgentConfig {
  apiUrl: URL;
  token: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  /** Upper bound for any backoff / Retry-After wait. */
  maxBackoffSeconds: number;
  /** PM2 inventory reporting (ADR-016); null = disabled (no NC_AGENT_INVENTORY_FILE). */
  inventory: InventoryConfig | null;
  /** PM2 control via the local broker (ADR-017); null = disabled (no NC_AGENT_CONTROL_SOCKET). */
  control: { socket: string } | null;
}

export interface InventoryConfig {
  /** Absolute path of the exporter's snapshot file (read-only for the Agent). */
  file: string;
  intervalSeconds: number;
  /** An exporter snapshot older than this is reported as stale, never as a fresh collection. */
  maxAgeSeconds: number;
  /**
   * Local E2E only: accept a snapshot owned by the Agent's own user. Allowed only together with the insecure
   * loopback API mode; in production the Agent must never be able to write (forge) its own inventory.
   */
  allowSameOwner: boolean;
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

  let inventory: InventoryConfig | null = null;
  const inventoryFile = env.NC_AGENT_INVENTORY_FILE;
  const allowSameOwner = env.NC_AGENT_INVENTORY_ALLOW_SAME_OWNER === 'true';
  const loopbackDev = env.NC_AGENT_ALLOW_INSECURE_LOOPBACK === 'true' && apiUrl?.protocol === 'http:' && LOOPBACK_HOSTS.has(apiUrl.hostname);
  if (allowSameOwner && !loopbackDev) issues.push('NC_AGENT_INVENTORY_ALLOW_SAME_OWNER is only allowed with the insecure loopback test mode');
  if (inventoryFile !== undefined && inventoryFile !== '') {
    if (!isAbsolute(inventoryFile) || normalize(inventoryFile) !== inventoryFile || inventoryFile.includes('\0')) {
      issues.push('NC_AGENT_INVENTORY_FILE must be a normalized absolute path');
    }
    inventory = {
      file: inventoryFile,
      intervalSeconds: integer(env, 'NC_AGENT_INVENTORY_INTERVAL_SECONDS', 60, 30, 600, issues),
      maxAgeSeconds: integer(env, 'NC_AGENT_INVENTORY_MAX_AGE_SECONDS', 120, 30, 3600, issues),
      allowSameOwner,
    };
  }

  let control: { socket: string } | null = null;
  const controlSocket = env.NC_AGENT_CONTROL_SOCKET;
  if (controlSocket !== undefined && controlSocket !== '') {
    if (!isAbsolute(controlSocket) || normalize(controlSocket) !== controlSocket || controlSocket.includes('\0')) {
      issues.push('NC_AGENT_CONTROL_SOCKET must be a normalized absolute path');
    }
    control = { socket: controlSocket };
  }

  if (issues.length > 0 || !apiUrl) throw new AgentConfigError(issues);
  return { apiUrl, token, intervalSeconds, timeoutSeconds, maxBackoffSeconds, inventory, control };
}

/** The env file holds a secret: refuse it unless it is owned by us and not accessible to group/other. */
export function readSecureEnvFile(path: string, uid: number | undefined = process.getuid?.()): Record<string, string> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    // Missing/unreadable file (e.g. no credential provisioned yet) is a configuration problem: exit 2, no restart loop.
    throw new AgentConfigError(['ENV_FILE is missing or not accessible']);
  }
  if (!stat.isFile()) throw new AgentConfigError(['ENV_FILE must be a regular file']);
  if ((stat.mode & 0o077) !== 0) throw new AgentConfigError(['ENV_FILE must not be accessible to group/other (chmod 600)']);
  if (uid !== undefined && stat.uid !== uid) throw new AgentConfigError(['ENV_FILE must be owned by the agent user']);
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}
