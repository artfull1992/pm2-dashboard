import type { FastifyInstance } from 'fastify';
import { AUTH_MESSAGES } from '../auth/plugin.js';
import { hasPermission } from '../auth/rbac.js';
import { describeError, PublicHttpError } from '../errors.js';
import type { DashboardStore } from './dashboard-store.js';

// GET /api/dashboard (ADR-020): monitoring:read, read-only (no audit, no mutation). Recent control actions are
// included only for roles with processes:control — decided HERE on the server, not by hiding a UI block.

const nullableString = { type: ['string', 'null'] } as const;
const nullableInt = { type: ['integer', 'null'] } as const;
const SERVER_STATUS = { type: 'string', enum: ['online', 'offline', 'never_connected'] } as const;
const INVENTORY_STATE = { type: 'string', enum: ['current', 'stale', 'unavailable', 'not_reported'] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const count = { type: 'integer', minimum: 0 } as const;
/** Nullable object without anyOf: the serializer then drops unknown keys instead of failing to pick a branch. */
const nullableObj = (properties: Record<string, unknown>) => ({ ...obj(properties), type: ['object', 'null'] }) as const;
const list = (item: unknown) => obj({ items: { type: 'array', items: item }, total: count, limit: count });

export const dashboardResponseSchema = obj({
  generatedAt: { type: 'string' },
  windows: obj({ onlineSeconds: count, inventoryFreshSeconds: count }),
  servers: obj({ total: count, inactive: count, active: count, online: count, offline: count, neverConnected: count }),
  inventory: obj({ current: count, stale: count, unavailable: count, notReported: count }),
  processes: obj({ live: obj({ total: count, online: count, problem: count, transitional: count }), notLive: count }),
  attentionServers: list(obj({
    id: { type: 'string' }, name: { type: 'string' }, status: SERVER_STATUS,
    reason: { type: 'string', enum: ['offline', 'never_connected', 'inventory_unavailable', 'inventory_stale', 'inventory_not_reported'] },
    lastSeenAt: nullableString, inventoryCollectedAt: nullableString,
  })),
  attentionProcesses: list(obj({
    serverId: { type: 'string' }, serverName: { type: 'string' }, pmId: count, name: { type: 'string' }, status: { type: 'string' },
    restarts: nullableInt, uptimeSeconds: nullableInt,
  })),
  serverList: list(obj({
    id: { type: 'string' }, name: { type: 'string' }, status: SERVER_STATUS, lastSeenAt: nullableString,
    metrics: nullableObj({
      hostname: { type: 'string' }, uptimeSeconds: count, cpuCount: count,
      loadAverage: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0 } },
      memory: obj({ totalBytes: count, usedBytes: count, usedPercent: { type: ['number', 'null'] } }),
    }),
    inventory: obj({ state: INVENTORY_STATE, collectedAt: nullableString }),
    processes: nullableObj({ total: count, online: count, problem: count }),
  })),
  recentActions: nullableObj({
    items: {
      type: 'array',
      items: obj({
        id: { type: 'string' }, serverId: { type: 'string' }, serverName: { type: 'string' }, targetKey: { type: 'string' },
        action: { type: 'string' }, status: { type: 'string' }, reason: nullableString, requestedAt: { type: 'string' },
        completedAt: nullableString, requestedByMe: { type: 'boolean' }, overdue: { type: 'boolean' },
      }),
    },
    limit: count,
  }),
});

export function registerDashboardRoutes(app: FastifyInstance, options: { store: DashboardStore }): void {
  app.get('/api/dashboard', {
    config: { access: { permission: 'monitoring:read' } },
    schema: { response: { 200: dashboardResponseSchema } },
  }, async (request) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    try {
      return await options.store.dashboard({ actionsFor: hasPermission(auth.role, 'processes:control') ? auth.userId : null });
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Dashboard query failed');
      throw new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': '5' });
    }
  });
}
