import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';

export type EnvSource = Readonly<Record<string, string | undefined>>;

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface DbConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly queryTimeoutMs: number;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly api: { readonly host: string; readonly port: number };
  readonly logLevel: LogLevel;
  readonly db: DbConfig;
  readonly readinessTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export const CONFIG_DEFAULTS = Object.freeze({
  NODE_ENV: 'development',
  API_HOST: '127.0.0.1',
  API_PORT: '3100',
  LOG_LEVEL: 'info',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
});

// Fixed operational limits; not environment-tunable until there is a real need.
export const LIMITS = Object.freeze({
  poolMax: 5,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 10_000,
  queryTimeoutMs: 2_000,
  readinessTimeoutMs: 2_500,
  shutdownTimeoutMs: 10_000,
});

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Validation failure. Messages name keys and rules only — never the offending values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Reads a dotenv file if present. A missing file is not an error: systemd may supply the environment. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

/** Process environment wins over values from the .env file. */
export function mergeEnv(fileEnv: EnvSource, processEnv: EnvSource): EnvSource {
  const merged: Record<string, string | undefined> = { ...fileEnv };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export function loadConfig(env: EnvSource): AppConfig {
  const issues: string[] = [];
  const value = (key: string, fallback?: string): string => {
    const raw = env[key];
    return raw === undefined || raw === '' ? (fallback ?? '') : raw;
  };

  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = value(key, fallback);
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    issues.push(`${key} must be one of: ${allowed.join(', ')}`);
    return fallback;
  };

  const port = (key: string, fallback?: string): number => {
    const raw = value(key, fallback);
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || parsed < 1 || parsed > 65_535) {
      issues.push(`${key} must be an integer between 1 and 65535`);
      return 0;
    }
    return parsed;
  };

  const host = (key: string, fallback: string): string => {
    const raw = value(key, fallback);
    if (isIP(raw) === 0 && !HOSTNAME_RE.test(raw)) issues.push(`${key} must be an IP address or hostname`);
    return raw;
  };

  const required = (key: string): string => {
    const raw = value(key);
    if (raw === '') issues.push(`${key} is required`);
    return raw;
  };

  const config: AppConfig = {
    nodeEnv: oneOf('NODE_ENV', NODE_ENVS, 'development'),
    api: { host: host('API_HOST', CONFIG_DEFAULTS.API_HOST), port: port('API_PORT', CONFIG_DEFAULTS.API_PORT) },
    logLevel: oneOf('LOG_LEVEL', LOG_LEVELS, 'info'),
    db: {
      host: host('DB_HOST', CONFIG_DEFAULTS.DB_HOST),
      port: port('DB_PORT', CONFIG_DEFAULTS.DB_PORT),
      database: required('DB_NAME'),
      user: required('DB_USER'),
      password: required('DB_PASS'),
      poolMax: LIMITS.poolMax,
      connectionTimeoutMs: LIMITS.connectionTimeoutMs,
      idleTimeoutMs: LIMITS.idleTimeoutMs,
      queryTimeoutMs: LIMITS.queryTimeoutMs,
    },
    readinessTimeoutMs: LIMITS.readinessTimeoutMs,
    shutdownTimeoutMs: LIMITS.shutdownTimeoutMs,
  };

  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

/** The only config fields allowed in logs. */
export function describeConfig(config: AppConfig): Record<string, string | number> {
  return { nodeEnv: config.nodeEnv, host: config.api.host, port: config.api.port, logLevel: config.logLevel };
}
