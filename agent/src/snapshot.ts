import os from 'node:os';
import { AGENT_VERSION } from './config.js';

// The ONLY data the Agent sends (ADR-015, ADR-023): identification metadata and the current load average. No env,
// no IPs/interfaces, no processes, no users, no paths — and no host monitoring (memory, OS uptime, CPU count): that
// belongs to the infrastructure's monitoring system (Zabbix). Since 0.5.0 those values are neither read nor sent.

export interface Snapshot {
  agentVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  /** 1/5/15-minute load averages: runnable-queue length, not a CPU percentage. */
  loadAverage: [number, number, number];
}

export interface OsSource {
  hostname(): string;
  platform(): string;
  arch(): string;
  loadavg(): number[];
}

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const clamp = (n: number, max: number) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function collectSnapshot(source: OsSource = os): Snapshot {
  const rawHost = source.hostname();
  const load = source.loadavg();
  return {
    agentVersion: AGENT_VERSION,
    // Values outside the server's contract are replaced, never sent as-is.
    hostname: HOSTNAME_RE.test(rawHost) ? rawHost : 'invalid-hostname',
    platform: /^[a-z0-9]{1,16}$/.test(source.platform()) ? source.platform() : 'unknown',
    arch: /^[a-z0-9_]{1,16}$/.test(source.arch()) ? source.arch() : 'unknown',
    loadAverage: [round2(clamp(load[0] ?? 0, 100_000)), round2(clamp(load[1] ?? 0, 100_000)), round2(clamp(load[2] ?? 0, 100_000))],
  };
}
