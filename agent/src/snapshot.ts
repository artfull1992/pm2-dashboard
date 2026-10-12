import os from 'node:os';
import { AGENT_VERSION } from './config.js';

// The ONLY data the Agent sends (ADR-015): no env, no IPs/interfaces, no processes, no users, no paths.

export interface Snapshot {
  agentVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  cpuCount: number;
  loadAverage: [number, number, number];
  memory: { totalBytes: number; freeBytes: number };
}

export interface OsSource {
  hostname(): string;
  platform(): string;
  arch(): string;
  uptime(): number;
  cpus(): unknown[];
  loadavg(): number[];
  totalmem(): number;
  freemem(): number;
}

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const clamp = (n: number, max: number) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function collectSnapshot(source: OsSource = os): Snapshot {
  const rawHost = source.hostname();
  const total = Math.floor(clamp(source.totalmem(), Number.MAX_SAFE_INTEGER));
  const load = source.loadavg();
  return {
    agentVersion: AGENT_VERSION,
    // Values outside the server's contract are replaced, never sent as-is.
    hostname: HOSTNAME_RE.test(rawHost) ? rawHost : 'invalid-hostname',
    platform: /^[a-z0-9]{1,16}$/.test(source.platform()) ? source.platform() : 'unknown',
    arch: /^[a-z0-9_]{1,16}$/.test(source.arch()) ? source.arch() : 'unknown',
    uptimeSeconds: Math.floor(clamp(source.uptime(), 10 ** 10)),
    cpuCount: Math.max(1, Math.min(source.cpus().length, 4096)),
    loadAverage: [round2(clamp(load[0] ?? 0, 100_000)), round2(clamp(load[1] ?? 0, 100_000)), round2(clamp(load[2] ?? 0, 100_000))],
    memory: { totalBytes: total, freeBytes: Math.min(Math.floor(clamp(source.freemem(), Number.MAX_SAFE_INTEGER)), total) },
  };
}
