import type { FastifyInstance } from 'fastify';
import { type AuthState } from '../auth/plugin.js';
import { BusyError, createLimiter, type Limiter } from '../auth/password.js';
import { requestScope } from '../auth/scope.js';
import { agentTokenDigest, newAgentToken } from '../auth/tokens.js';
import { describeError, PublicHttpError } from '../errors.js';
import { type IncomingSnapshot, normalizeSnapshot, snapshotProblem, snapshotSchema, snapshotViewSchema } from './snapshot.js';
import { ONLINE_WINDOW_SECONDS, type ServerStore } from './store.js';

// Browser API for the server registry + the Agent heartbeat machine route (ADR-015).

export const HEARTBEAT_INTERVAL_SECONDS = 30;
export const HEARTBEAT_BODY_LIMIT = 4096;
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const unavailable = () => new PublicHttpError(503, 'Service temporarily unavailable', { 'retry-after': '5' });

const summaryProperties = {
  id: { type: 'string' }, name: { type: 'string' }, isActive: { type: 'boolean' }, createdAt: { type: 'string' },
  status: { type: 'string', enum: ['online', 'offline', 'never_connected'] },
  lastSeenAt: { type: ['string', 'null'] }, hasActiveCredential: { type: 'boolean' },
} as const;
const summarySchema = { type: 'object', additionalProperties: false, required: Object.keys(summaryProperties), properties: summaryProperties } as const;
const detailSchema = {
  type: 'object', additionalProperties: false, required: [...Object.keys(summaryProperties), 'snapshot'],
  properties: { ...summaryProperties, snapshot: { anyOf: [{ type: 'null' }, snapshotViewSchema] } },
} as const;
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } as const;

export interface ServerRoutesOptions {
  store: ServerStore;
  /** Bounds concurrent heartbeat transactions; overflow → 503. */
  heartbeatLimiter?: Limiter;
}

function actorOf(auth: AuthState | null, requestId: string) {
  if (!auth) throw new PublicHttpError(401, 'Authentication required');
  return { actorUserId: auth.userId, requestId };
}

async function guarded<T>(log: { error(o: object, m: string): void }, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PublicHttpError) throw error;
    log.error({ error: describeError(error) }, `${what} failed`);
    throw unavailable();
  }
}

export function registerServerRoutes(app: FastifyInstance, options: ServerRoutesOptions): void {
  const { store } = options;
  const heartbeatLimiter = options.heartbeatLimiter ?? createLimiter(8, 16);

  app.get('/api/servers', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, afterId: { type: 'string', pattern: UUID_PATTERN } },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['items', 'nextAfterId', 'onlineWindowSeconds'],
          properties: { items: { type: 'array', items: summarySchema }, nextAfterId: { type: ['string', 'null'] }, onlineWindowSeconds: { type: 'integer' } },
        },
      },
    },
  }, async (request) => {
    const { limit, afterId } = request.query as { limit: number; afterId?: string };
    const scope = requestScope(request.auth);
    const page = await guarded(request.log, 'Server list', () => store.list({ limit, afterId: afterId ?? null, scope }));
    return { ...page, onlineWindowSeconds: ONLINE_WINDOW_SECONDS };
  });

  app.get('/api/servers/:id', {
    config: { access: { permission: 'monitoring:read' } },
    schema: { params: idParams, response: { 200: detailSchema } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const scope = requestScope(request.auth);
    // Missing and not granted look the same (ADR-028: 404 does not disclose existence).
    const server = await guarded(request.log, 'Server lookup', () => store.get(id, scope));
    if (!server) throw new PublicHttpError(404, 'Server not found');
    return server;
  });

  app.post('/api/servers', {
    config: { access: { permission: 'servers:manage' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } },
      },
      response: { 201: summarySchema },
    },
  }, async (request, reply) => {
    const name = (request.body as { name: string }).name.trim();
    if (name === '') throw new PublicHttpError(400, 'Server name is required');
    const result = await guarded(request.log, 'Server creation', () => store.create({ name, ...actorOf(request.auth, request.id) }));
    if (result === 'name_taken') throw new PublicHttpError(409, 'A server with this name already exists');
    return reply.code(201).send(result);
  });

  app.post('/api/servers/:id/agent-credentials', {
    config: { access: { permission: 'servers:manage' } },
    schema: {
      params: idParams,
      response: {
        201: {
          type: 'object', additionalProperties: false, required: ['serverId', 'token', 'issuedAt', 'rotated'],
          properties: { serverId: { type: 'string' }, token: { type: 'string' }, issuedAt: { type: 'string' }, rotated: { type: 'boolean' } },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // The plaintext token exists only in this response (no-store) — never logged, stored or shown again.
    const token = newAgentToken();
    const result = await guarded(request.log, 'Credential issue', () =>
      store.issueCredential({ serverId: id, tokenHash: agentTokenDigest(token), ...actorOf(request.auth, request.id) }));
    if (result === 'not_found') throw new PublicHttpError(404, 'Server not found');
    if (result === 'inactive') throw new PublicHttpError(409, 'Server is inactive');
    return reply.code(201).send({ serverId: id, token, issuedAt: result.issuedAt.toISOString(), rotated: result.rotated });
  });

  app.post('/api/servers/:id/agent-credentials/revoke', {
    config: { access: { permission: 'servers:manage' } },
    schema: {
      params: idParams,
      response: { 200: { type: 'object', additionalProperties: false, required: ['serverId', 'revoked'], properties: { serverId: { type: 'string' }, revoked: { type: 'boolean' } } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await guarded(request.log, 'Credential revoke', () => store.revokeCredential({ serverId: id, ...actorOf(request.auth, request.id) }));
    if (result === 'not_found') throw new PublicHttpError(404, 'Server not found');
    return { serverId: id, revoked: result.revoked };
  });

  app.post('/api/agent/heartbeat', {
    config: { access: { machine: 'agent' } },
    bodyLimit: HEARTBEAT_BODY_LIMIT,
    // Ajv coerces "1.5" → 1.5; the load average is the one host metric left (ADR-023) and must be real JSON numbers.
    preValidation: (request, _reply, done) => {
      const load = (request.body as { loadAverage?: unknown } | null)?.loadAverage;
      if (Array.isArray(load) && !load.every((v) => typeof v === 'number')) { done(new PublicHttpError(400, 'Invalid snapshot')); return; }
      done();
    },
    schema: {
      body: snapshotSchema,
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['status', 'receivedAt', 'intervalSeconds'],
          properties: { status: { type: 'string', enum: ['accepted'] }, receivedAt: { type: 'string' }, intervalSeconds: { type: 'integer' } },
        },
      },
    },
  }, async (request) => {
    const agent = request.agent;
    if (!agent) throw new PublicHttpError(401, 'Agent credential missing or invalid');
    const incoming = request.body as IncomingSnapshot;
    if (snapshotProblem(incoming)) throw new PublicHttpError(400, 'Invalid snapshot');
    // Only the current fields are stored; legacy fields of older Agents were validated above and are dropped here.
    const snapshot = normalizeSnapshot(incoming);
    if (!snapshot) throw new PublicHttpError(400, 'Invalid snapshot');
    let result;
    try {
      // Server identity comes from the credential (agent.tokenHash), never from the payload.
      result = await heartbeatLimiter.run(() => store.recordHeartbeat({ tokenHash: agent.tokenHash, snapshot }));
    } catch (error) {
      if (error instanceof BusyError) throw unavailable();
      request.log.error({ error: describeError(error) }, 'Heartbeat write failed');
      throw unavailable();
    }
    if (result === 'unauthorized') throw new PublicHttpError(401, 'Agent credential missing or invalid');
    return { status: 'accepted', receivedAt: result.receivedAt.toISOString(), intervalSeconds: HEARTBEAT_INTERVAL_SECONDS };
  });
}
