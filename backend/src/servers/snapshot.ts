// Heartbeat snapshot contract (ADR-015, narrowed by ADR-023). The payload comes from an authenticated Agent but is NOT
// trusted to be true: it is strictly shaped and bounded, and nothing else is accepted.
//
// Host monitoring (memory, OS uptime, CPU count) belongs to the infrastructure's monitoring system (Zabbix), not to
// Node Control. The only host metric kept is the current load average; the rest is identification metadata.
//
// Compatibility period: Agents up to 0.4.x still send `uptimeSeconds`, `cpuCount` and `memory`. Those LEGACY fields are
// accepted only in their exact old shape (still strictly validated — no free-form JSON), are never stored and never
// used. They can be removed from this schema once every managed server runs Agent >= 0.5.0 (ADR-023).

export const SNAPSHOT_LIMITS = Object.freeze({
  maxUptimeSeconds: 10 ** 10,
  maxCpuCount: 4096,
  maxLoad: 100_000,
  maxBytes: 2 ** 53 - 1,
});

export interface ServerSnapshot {
  agentVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  /** 1/5/15-minute load averages: runnable-queue length, NOT a CPU percentage. */
  loadAverage: [number, number, number];
}

/** Fields of Agent <= 0.4.x: validated, then dropped. */
export interface LegacySnapshotFields {
  uptimeSeconds?: number;
  cpuCount?: number;
  memory?: { totalBytes: number; freeBytes: number };
}
export type IncomingSnapshot = ServerSnapshot & LegacySnapshotFields;

const CURRENT_PROPERTIES = {
  agentVersion: { type: 'string', pattern: '^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$' },
  hostname: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' },
  platform: { type: 'string', pattern: '^[a-z0-9]{1,16}$' },
  arch: { type: 'string', pattern: '^[a-z0-9_]{1,16}$' },
  loadAverage: {
    type: 'array', minItems: 3, maxItems: 3,
    items: { type: 'number', minimum: 0, maximum: SNAPSHOT_LIMITS.maxLoad },
  },
} as const;
const REQUIRED = ['agentVersion', 'hostname', 'platform', 'arch', 'loadAverage'] as const;

/** Request body of POST /api/agent/heartbeat: current fields required, legacy fields optional with their old exact shape. */
export const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: REQUIRED,
  properties: {
    ...CURRENT_PROPERTIES,
    uptimeSeconds: { type: 'integer', minimum: 0, maximum: SNAPSHOT_LIMITS.maxUptimeSeconds },
    cpuCount: { type: 'integer', minimum: 1, maximum: SNAPSHOT_LIMITS.maxCpuCount },
    memory: {
      type: 'object',
      additionalProperties: false,
      required: ['totalBytes', 'freeBytes'],
      properties: {
        totalBytes: { type: 'integer', minimum: 0, maximum: SNAPSHOT_LIMITS.maxBytes },
        freeBytes: { type: 'integer', minimum: 0, maximum: SNAPSHOT_LIMITS.maxBytes },
      },
    },
  },
} as const;

/** What the API returns: only the current fields (stored legacy keys never leave the server). */
export const snapshotViewSchema = {
  type: 'object',
  additionalProperties: false,
  required: REQUIRED,
  properties: CURRENT_PROPERTIES,
} as const;

/** Cross-field rules JSON schema cannot express (legacy shape still checked while it is accepted). */
export function snapshotProblem(snapshot: IncomingSnapshot): 'memory_free_exceeds_total' | null {
  return snapshot.memory && snapshot.memory.freeBytes > snapshot.memory.totalBytes ? 'memory_free_exceeds_total' : null;
}

/**
 * Copies only the current contract fields. Used for storage (legacy fields are never written) and for reading rows
 * written before ADR-023, which still contain the legacy keys. Returns null for a stored value of another shape.
 */
export function normalizeSnapshot(s: unknown): ServerSnapshot | null {
  if (typeof s !== 'object' || s === null) return null;
  const v = s as Record<string, unknown>;
  const load = v.loadAverage;
  if (typeof v.agentVersion !== 'string' || typeof v.hostname !== 'string' || typeof v.platform !== 'string' || typeof v.arch !== 'string'
    || !Array.isArray(load) || load.length !== 3 || !load.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
  return {
    agentVersion: v.agentVersion, hostname: v.hostname, platform: v.platform, arch: v.arch,
    loadAverage: [load[0] as number, load[1] as number, load[2] as number],
  };
}
