import type { FastifyInstance } from 'fastify';
import { BusyError, createLimiter, type Limiter } from '../auth/password.js';
import { describeError, PublicHttpError } from '../errors.js';
import { cursorContext, decodeCursor, INVENTORY_BODY_LIMIT, INVENTORY_FRESH_SECONDS, INVENTORY_INTERVAL_SECONDS, inventoryReportSchema, normalizeSearch, PROCESS_STATUSES, type ProcessStatus, type SchemaValidReport, toInventoryReport } from './inventory.js';
import type { InventoryStore } from './inventory-store.js';

// Read-only PM2 inventory API (ADR-016): one machine route for the Agent, two browser read routes. There are no
// process-control routes — PM2 start/stop/restart/delete are not implemented.

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const unavailable = () => new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '5' });
const nullableString = { type: ['string', 'null'] } as const;
const nullableNumber = { type: ['number', 'null'] } as const;
const SERVER_STATUSES = ['online', 'offline', 'never_connected'] as const;

const appItemSchema = {
  type: 'object', additionalProperties: false,
  required: ['key', 'serverId', 'serverName', 'serverStatus', 'source', 'pmId', 'name', 'status', 'uptimeSeconds', 'restarts',
    'cpuPercent', 'memoryBytes', 'execMode', 'firstSeenAt', 'inventoryState', 'capturedAt', 'collectedAt'],
  properties: {
    key: { type: 'string' }, serverId: { type: 'string' }, serverName: { type: 'string' }, serverStatus: { type: 'string', enum: SERVER_STATUSES },
    source: { type: 'string' }, pmId: { type: 'integer' }, name: { type: 'string' }, status: { type: 'string', enum: PROCESS_STATUSES },
    uptimeSeconds: nullableNumber, restarts: nullableNumber, cpuPercent: nullableNumber, memoryBytes: nullableNumber,
    execMode: { type: ['string', 'null'], enum: ['fork', 'cluster', null] }, firstSeenAt: { type: 'string' },
    inventoryState: { type: 'string', enum: ['current', 'stale', 'unavailable'] }, capturedAt: nullableString, collectedAt: nullableString,
  },
} as const;

export interface InventoryRoutesOptions {
  store: InventoryStore;
  /** Bounds concurrent inventory transactions; overflow → 503. */
  inventoryLimiter?: Limiter;
}

export function registerInventoryRoutes(app: FastifyInstance, options: InventoryRoutesOptions): void {
  const { store } = options;
  const limiter = options.inventoryLimiter ?? createLimiter(4, 8);

  app.get('/api/applications', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          cursor: { type: 'string', minLength: 1, maxLength: 400, pattern: '^[A-Za-z0-9_-]+$' },
          serverId: { type: 'string', pattern: UUID_PATTERN },
          status: { type: 'string', enum: PROCESS_STATUSES },
          q: { type: 'string', maxLength: 512 },
        },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['items', 'nextCursor', 'freshWindowSeconds'],
          properties: { items: { type: 'array', items: appItemSchema }, nextCursor: nullableString, freshWindowSeconds: { type: 'integer' } },
        },
      },
    },
  }, async (request) => {
    const q = request.query as { limit: number; cursor?: string; serverId?: string; status?: ProcessStatus; q?: string };
    const search = normalizeSearch(q.q);
    if (search === null) throw new PublicHttpError(400, 'Invalid search');
    const filter = { serverId: q.serverId ?? null, status: q.status ?? null, q: search ?? null };
    const context = cursorContext(filter);
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    if (q.cursor !== undefined && !cursor) throw new PublicHttpError(400, 'Invalid cursor');
    // A cursor belongs to the filters it was issued for; one of another list is refused (start again from page 1).
    // Cursors issued before name search existed carry no context and keep working for the same filters.
    if (cursor?.context && cursor.context !== context) throw new PublicHttpError(400, 'Invalid cursor');
    if (cursor && !cursor.context && filter.q !== null) throw new PublicHttpError(400, 'Invalid cursor');
    try {
      const page = await store.listApplications({ limit: q.limit, cursor, ...filter, context });
      return { ...page, freshWindowSeconds: INVENTORY_FRESH_SECONDS };
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Application list failed');
      throw unavailable();
    }
  });

  app.get('/api/servers/:id/applications', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['serverId', 'serverStatus', 'inventory', 'items', 'freshWindowSeconds'],
          properties: {
            serverId: { type: 'string' }, serverStatus: { type: 'string', enum: SERVER_STATUSES },
            inventory: {
              type: 'object', additionalProperties: false,
              required: ['state', 'reason', 'source', 'capturedAt', 'collectedAt', 'reportedAt', 'processCount'],
              properties: {
                state: { type: 'string', enum: ['not_reported', 'current', 'stale', 'unavailable'] }, reason: nullableString, source: nullableString,
                capturedAt: nullableString, collectedAt: nullableString, reportedAt: nullableString, processCount: { type: ['integer', 'null'] },
              },
            },
            items: { type: 'array', items: appItemSchema }, freshWindowSeconds: { type: 'integer' },
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    let result;
    try {
      result = await store.serverApplications(id);
    } catch (error) {
      request.log.error({ error: describeError(error) }, 'Server applications lookup failed');
      throw unavailable();
    }
    if (!result) throw new PublicHttpError(404, 'Server not found');
    return { ...result, freshWindowSeconds: INVENTORY_FRESH_SECONDS };
  });

  app.post('/api/agent/inventory', {
    config: { access: { machine: 'agent' } },
    bodyLimit: INVENTORY_BODY_LIMIT,
    schema: {
      body: inventoryReportSchema,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['status', 'receivedAt', 'intervalSeconds'],
          properties: { status: { type: 'string', enum: ['accepted', 'ignored'] }, receivedAt: { type: 'string' }, intervalSeconds: { type: 'integer' } },
        },
      },
    },
  }, async (request) => {
    const agent = request.agent;
    if (!agent) throw new PublicHttpError(401, 'Agent credential missing or invalid');
    const report = toInventoryReport(request.body as SchemaValidReport);
    if (!report) throw new PublicHttpError(400, 'Invalid inventory report');
    let result;
    try {
      // Server identity comes from the credential (agent.tokenHash), never from the payload.
      result = await limiter.run(() => store.recordInventory({ tokenHash: agent.tokenHash, report }));
    } catch (error) {
      if (error instanceof BusyError) throw unavailable();
      request.log.error({ error: describeError(error) }, 'Inventory write failed');
      throw unavailable();
    }
    if (result === 'unauthorized') throw new PublicHttpError(401, 'Agent credential missing or invalid');
    return { status: result.status, receivedAt: result.receivedAt.toISOString(), intervalSeconds: INVENTORY_INTERVAL_SECONDS };
  });
}
