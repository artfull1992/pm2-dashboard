// Heartbeat snapshot contract (ADR-015). The payload comes from an authenticated Agent but is NOT trusted to be
// true: it is strictly shaped and bounded, and nothing else is accepted. Shared by the JSON schema (transport)
// and the semantic check (cross-field rules) below.

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
  uptimeSeconds: number;
  cpuCount: number;
  /** 1/5/15-minute load averages: runnable-queue length, NOT a CPU percentage. */
  loadAverage: [number, number, number];
  memory: { totalBytes: number; freeBytes: number };
}

export const snapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentVersion', 'hostname', 'platform', 'arch', 'uptimeSeconds', 'cpuCount', 'loadAverage', 'memory'],
  properties: {
    agentVersion: { type: 'string', pattern: '^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$' },
    hostname: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' },
    platform: { type: 'string', pattern: '^[a-z0-9]{1,16}$' },
    arch: { type: 'string', pattern: '^[a-z0-9_]{1,16}$' },
    uptimeSeconds: { type: 'integer', minimum: 0, maximum: SNAPSHOT_LIMITS.maxUptimeSeconds },
    cpuCount: { type: 'integer', minimum: 1, maximum: SNAPSHOT_LIMITS.maxCpuCount },
    loadAverage: {
      type: 'array', minItems: 3, maxItems: 3,
      items: { type: 'number', minimum: 0, maximum: SNAPSHOT_LIMITS.maxLoad },
    },
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

/** Cross-field rules JSON schema cannot express. Returns a fixed reason code or null. */
export function snapshotProblem(snapshot: ServerSnapshot): 'memory_free_exceeds_total' | null {
  return snapshot.memory.freeBytes > snapshot.memory.totalBytes ? 'memory_free_exceeds_total' : null;
}

/** Copies only the contract fields (defence in depth against extra keys reaching storage). */
export function normalizeSnapshot(s: ServerSnapshot): ServerSnapshot {
  return {
    agentVersion: s.agentVersion,
    hostname: s.hostname,
    platform: s.platform,
    arch: s.arch,
    uptimeSeconds: s.uptimeSeconds,
    cpuCount: s.cpuCount,
    loadAverage: [s.loadAverage[0], s.loadAverage[1], s.loadAverage[2]],
    memory: { totalBytes: s.memory.totalBytes, freeBytes: s.memory.freeBytes },
  };
}
