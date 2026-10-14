import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';
import type { AlertThresholds } from './alerts/rules.js';
import { parseSecretKey, type SecretKey } from './alerts/secret.js';
import { type AlertSettingsValues, SETTINGS_RANGES, settingsProblem } from './alerts/settings.js';

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

export interface AuthConfig {
  /** Exact Origin values allowed for state-changing /api requests. Empty → every such request is refused. */
  readonly allowedOrigins: readonly string[];
  /** Secure cookie (and __Host- prefix). false only outside production on a loopback API_HOST. */
  readonly cookieSecure: boolean;
  /** Absolute session lifetime; never extended. */
  readonly sessionTtlSeconds: number;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly auth: AuthConfig;
  /**
   * trustedProxies: exact loopback peer addresses whose X-Forwarded-For is honoured (ADR-014).
   * Empty (default) → Fastify trustProxy is off and forwarded headers are ignored.
   */
  readonly api: { readonly host: string; readonly port: number; readonly trustedProxies: readonly string[] };
  readonly logLevel: LogLevel;
  readonly db: DbConfig;
  readonly readinessTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  /** PM2 process control (ADR-017). false (default) → no command can be created or dispatched. */
  readonly pm2Control: { readonly enabled: boolean };
  /** Alerts engine and Slack delivery (ADR-021). Both off by default. */
  readonly alerts: AlertsConfig;
}

/** Deployment-level alert configuration (ADR-022). Application parameters live in the database. */
export interface AlertsConfig {
  /** Trusted https origin for links in messages (e.g. https://nodecontrol.example); null → no link. */
  readonly publicUrl: string | null;
  /** SECRET (ALERTS_SECRET_KEY): encrypts the Slack webhook at rest; null → no integration can be used (fail-closed). */
  readonly secretKey: SecretKey | null;
  /** One-time initial values for alert_settings when the row does not exist yet (never overwrite saved settings). */
  readonly defaults: AlertSettingsValues;
  /** Pre-ADR-022 variables still present (ignored; reported once, without values). */
  readonly legacy: { readonly webhook: boolean; readonly flags: boolean };
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
  transactionTimeoutMs: 5_000,
  maxAllowedOrigins: 10,
});

export const AUTH_DEFAULTS = Object.freeze({
  AUTH_COOKIE_SECURE: 'true',
  AUTH_SESSION_TTL_MINUTES: '480',
  AUTH_ALLOWED_ORIGINS: '',
});
const SESSION_TTL_MINUTES_RANGE = [15, 1440] as const;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

const MAX_TRUSTED_PROXIES = 4;

/**
 * API_TRUSTED_PROXIES: comma-separated literal loopback IPs of the local reverse proxy (e.g. 127.0.0.1).
 * No hostnames, CIDR ranges, wildcards or non-loopback addresses: the API only listens on loopback,
 * so the only legitimate proxy is the local Nginx. Messages never include the offending value.
 */
export function trustedProxyList(raw: string, issues: string[]): string[] {
  if (raw.trim() === '') return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_PROXIES) {
    issues.push(`API_TRUSTED_PROXIES allows at most ${String(MAX_TRUSTED_PROXIES)} addresses`);
    return [];
  }
  const loopback = (ip: string) => (isIP(ip) === 4 && ip.startsWith('127.')) || (isIP(ip) === 6 && ip === '::1');
  if (!entries.every(loopback)) {
    issues.push('API_TRUSTED_PROXIES must list loopback IP addresses only (e.g. 127.0.0.1); no hostnames or ranges');
    return [];
  }
  return [...new Set(entries)];
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

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

  const nodeEnv = oneOf('NODE_ENV', NODE_ENVS, 'development');
  const trustedProxies = trustedProxyList(value('API_TRUSTED_PROXIES', ''), issues);
  const api = { host: host('API_HOST', CONFIG_DEFAULTS.API_HOST), port: port('API_PORT', CONFIG_DEFAULTS.API_PORT), trustedProxies };
  // Insecure (non-Secure cookie, http origins) is an explicit opt-in that only a loopback development setup may use.
  const insecureAllowed = nodeEnv !== 'production' && isLoopbackHost(api.host);

  const secureRaw = value('AUTH_COOKIE_SECURE', AUTH_DEFAULTS.AUTH_COOKIE_SECURE);
  if (secureRaw !== 'true' && secureRaw !== 'false') issues.push('AUTH_COOKIE_SECURE must be true or false');
  const cookieSecure = secureRaw !== 'false';
  if (!cookieSecure && !insecureAllowed) {
    issues.push('AUTH_COOKIE_SECURE=false is only allowed outside production with a loopback API_HOST');
  }

  const ttlRaw = value('AUTH_SESSION_TTL_MINUTES', AUTH_DEFAULTS.AUTH_SESSION_TTL_MINUTES);
  const ttl = Number(ttlRaw);
  if (!/^\d+$/.test(ttlRaw) || ttl < SESSION_TTL_MINUTES_RANGE[0] || ttl > SESSION_TTL_MINUTES_RANGE[1]) {
    issues.push(`AUTH_SESSION_TTL_MINUTES must be an integer between ${String(SESSION_TTL_MINUTES_RANGE[0])} and ${String(SESSION_TTL_MINUTES_RANGE[1])}`);
  }

  const originsRaw = value('AUTH_ALLOWED_ORIGINS', AUTH_DEFAULTS.AUTH_ALLOWED_ORIGINS);
  const allowedOrigins = originsRaw === '' ? [] : originsRaw.split(',').map((o) => o.trim());
  if (allowedOrigins.length > LIMITS.maxAllowedOrigins) issues.push(`AUTH_ALLOWED_ORIGINS allows at most ${String(LIMITS.maxAllowedOrigins)} origins`);
  for (const origin of allowedOrigins) {
    let url: URL | undefined;
    try { url = new URL(origin); } catch { url = undefined; }
    if (!url || url.origin !== origin) {
      issues.push('AUTH_ALLOWED_ORIGINS entries must be exact origins like https://host[:port] (no path, no trailing slash)');
      break;
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecureAllowed && isLoopbackHost(url.hostname))) {
      issues.push('AUTH_ALLOWED_ORIGINS must use https (http only for loopback origins outside production)');
      break;
    }
  }

  const alerts = loadAlertsConfig(value, issues);

  const controlRaw = value('PM2_CONTROL_ENABLED', 'false');
  if (controlRaw !== 'true' && controlRaw !== 'false') issues.push('PM2_CONTROL_ENABLED must be true or false');

  const config: AppConfig = {
    nodeEnv,
    pm2Control: { enabled: controlRaw === 'true' },
    alerts,
    api,
    auth: { allowedOrigins, cookieSecure, sessionTtlSeconds: ttl * 60 },
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
export function describeConfig(config: AppConfig): Record<string, string | number | boolean> {
  return {
    nodeEnv: config.nodeEnv, host: config.api.host, port: config.api.port, logLevel: config.logLevel,
    trustedProxies: config.api.trustedProxies.length,
    authOrigins: config.auth.allowedOrigins.length, cookieSecure: config.auth.cookieSecure,
    sessionTtlMinutes: config.auth.sessionTtlSeconds / 60,
    pm2ControlEnabled: config.pm2Control.enabled,
    // Booleans only: the secret key is never described. Engine/delivery state is in the database (ADR-022).
    alertsSecretKey: config.alerts.secretKey !== null, alertsPublicUrl: config.alerts.publicUrl !== null,
  };
}

/** ALERTS_* (ADR-022). Issues name keys and ranges only — never values (the secret key is a secret). */
export function loadAlertsConfig(value: (key: string, fallback?: string) => string, issues: string[]): AlertsConfig {
  const int = (key: string, range: readonly [number, number, number]): number => {
    const [min, max, fallback] = range;
    const raw = value(key, String(fallback));
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      issues.push(`${key} must be an integer between ${String(min)} and ${String(max)}`);
      return fallback;
    }
    return n;
  };
  const publicRaw = value('ALERTS_PUBLIC_URL');
  let publicUrl: string | null = null;
  if (publicRaw !== '') {
    let url: URL | undefined;
    try { url = new URL(publicRaw); } catch { url = undefined; }
    if (!url || url.protocol !== 'https:' || url.origin !== publicRaw) issues.push('ALERTS_PUBLIC_URL must be an https origin like https://host (no path, no trailing slash)');
    else publicUrl = url.origin;
  }
  const key = parseSecretKey(value('ALERTS_SECRET_KEY'), value('ALERTS_SECRET_KEY_VERSION'));
  if (key === 'invalid') issues.push('ALERTS_SECRET_KEY must be base64 of exactly 32 bytes and ALERTS_SECRET_KEY_VERSION an integer between 1 and 1000');
  const R = SETTINGS_RANGES;
  const thresholds: AlertThresholds = {
    cpuOpenPercent: int('ALERTS_CPU_OPEN_PERCENT', R.cpuOpenPercent), cpuClosePercent: int('ALERTS_CPU_CLOSE_PERCENT', R.cpuClosePercent),
    memoryOpenPercent: int('ALERTS_MEMORY_OPEN_PERCENT', R.memoryOpenPercent), memoryClosePercent: int('ALERTS_MEMORY_CLOSE_PERCENT', R.memoryClosePercent),
    confirmSamples: int('ALERTS_CONFIRM_SAMPLES', R.confirmSamples), recoverSamples: int('ALERTS_RECOVER_SAMPLES', R.recoverSamples),
    statusConfirmSamples: int('ALERTS_STATUS_CONFIRM_SAMPLES', R.statusConfirmSamples),
    restartsThreshold: int('ALERTS_RESTARTS_THRESHOLD', R.restartsThreshold), restartsWindowSeconds: int('ALERTS_RESTARTS_WINDOW_MINUTES', R.restartsWindowMinutes) * 60,
  };
  const reminderMinutes = value('ALERTS_REMINDER_MINUTES', '0');
  const defaults: AlertSettingsValues = {
    engineEnabled: false, deliveryEnabled: false, thresholds,
    intervalSeconds: int('ALERTS_INTERVAL_SECONDS', R.intervalSeconds), cooldownSeconds: int('ALERTS_COOLDOWN_MINUTES', R.cooldownMinutes) * 60,
    reminderEnabled: reminderMinutes !== '0' && reminderMinutes !== '',
    reminderSeconds: (reminderMinutes === '0' || reminderMinutes === '' ? R.reminderMinutes[2] : int('ALERTS_REMINDER_MINUTES', R.reminderMinutes)) * 60,
    httpTimeoutMs: int('ALERTS_HTTP_TIMEOUT_MS', R.httpTimeoutMs), maxAttempts: int('ALERTS_MAX_ATTEMPTS', R.maxAttempts), queueMax: int('ALERTS_QUEUE_MAX', R.queueMax),
  };
  const problem = settingsProblem(defaults);
  if (problem === 'cpu') issues.push('ALERTS_CPU_CLOSE_PERCENT must be lower than ALERTS_CPU_OPEN_PERCENT');
  if (problem === 'memory') issues.push('ALERTS_MEMORY_CLOSE_PERCENT must be lower than ALERTS_MEMORY_OPEN_PERCENT');
  return {
    publicUrl, secretKey: key === 'invalid' ? null : key, defaults,
    legacy: { webhook: value('ALERTS_SLACK_WEBHOOK_URL') !== '', flags: value('ALERTS_ENABLED') !== '' || value('ALERTS_DELIVERY_ENABLED') !== '' },
  };
}

/** Defaults for tests and the health-only/auth app paths that do not run alerts. */
export const ALERTS_DEFAULTS: AlertsConfig = loadAlertsConfig((_key, fallback = '') => fallback, []);
