import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describeError, PublicHttpError } from '../errors.js';
import type { AccessStore, GrantInput } from './access-store.js';
import { AUTH_MESSAGES } from './plugin.js';
import { createRateLimiter, type RateLimiter, USER_ADMIN_LIMITS } from './rate-limit.js';

// Resource grants administration API (ADR-028). users:manage (admin) only; the PUT needs Origin + CSRF (auth plugin).
// The editor sends the complete set of one user's grants with the revision it was based on: the store replaces it
// atomically or answers 409 when someone else changed it meanwhile.

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const NAME_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f]+$';
export const ACCESS_LIMITS = Object.freeze({ maxServers: 1000, maxServicesPerServer: 500, searchLimit: 100, servicesLimit: 500 });

const serviceNameSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: NAME_PATTERN } as const;
const accessViewSchema = {
  type: 'object', additionalProperties: false, required: ['userId', 'email', 'role', 'isActive', 'global', 'revision', 'servers'],
  properties: {
    userId: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, isActive: { type: 'boolean' }, global: { type: 'boolean' },
    revision: { type: 'integer' },
    servers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['serverId', 'serverName', 'serverActive', 'mode', 'grantedAt', 'services'],
        properties: {
          serverId: { type: 'string' }, serverName: { type: 'string' }, serverActive: { type: 'boolean' }, mode: { type: 'string', enum: ['all', 'selected'] },
          grantedAt: { type: 'string' },
          services: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['name', 'available'], properties: { name: { type: 'string' }, available: { type: 'boolean' } } },
          },
        },
      },
    },
  },
} as const;
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } as const;

export const ACCESS_MESSAGES = Object.freeze({
  notFound: 'User not found',
  conflict: 'Access was changed by someone else: reload and apply your changes again',
  roleGlobal: 'Administrators have access to every server and service; grants are not used',
  duplicate_server: 'A server is listed twice',
  unknown_server: 'Unknown server',
  empty_selection: 'Select at least one service, or remove the server',
  services_with_all: 'Mode "all" does not take a list of services',
  unknown_service: 'Unknown service for this server',
});

export interface AccessRoutesOptions { store: AccessStore; limiter?: RateLimiter }

export function registerAccessRoutes(app: FastifyInstance, options: AccessRoutesOptions): void {
  const { store } = options;
  const limiter = options.limiter ?? createRateLimiter(USER_ADMIN_LIMITS.perActor);
  const unavailable = () => new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': '5' });
  const guarded = async <T>(request: FastifyRequest, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PublicHttpError) throw error;
      request.log.error({ error: describeError(error) }, `${what} failed`);
      throw unavailable();
    }
  };

  app.get('/api/users/:id/access', {
    config: { access: { permission: 'users:manage' } },
    schema: { params: idParams, response: { 200: accessViewSchema } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await guarded(request, 'Access lookup', () => store.getAccess(id));
    if (!view) throw new PublicHttpError(404, ACCESS_MESSAGES.notFound);
    return view;
  });

  app.put('/api/users/:id/access', {
    config: { access: { permission: 'users:manage' } },
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['expectedRevision', 'servers'],
        properties: {
          expectedRevision: { type: 'integer', minimum: 0 },
          servers: {
            type: 'array', maxItems: ACCESS_LIMITS.maxServers,
            items: {
              type: 'object', additionalProperties: false, required: ['serverId', 'mode', 'services'],
              properties: {
                serverId: { type: 'string', pattern: UUID_PATTERN }, mode: { type: 'string', enum: ['all', 'selected'] },
                services: { type: 'array', maxItems: ACCESS_LIMITS.maxServicesPerServer, uniqueItems: true, items: serviceNameSchema },
              },
            },
          },
        },
      },
      response: { 200: accessViewSchema },
    },
  }, async (request) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    const retryAfter = limiter.hit(auth.userId);
    if (retryAfter > 0) throw new PublicHttpError(429, 'Too many user administration requests, try again later', { 'retry-after': String(retryAfter) });
    const { id } = request.params as { id: string };
    const body = request.body as { expectedRevision: number; servers: GrantInput[] };
    const result = await guarded(request, 'Access update', () => store.saveAccess({
      actor: { userId: auth.userId, sessionId: auth.sessionId }, userId: id, expectedRevision: body.expectedRevision, servers: body.servers, requestId: request.id,
    }));
    switch (result.status) {
      case 'ok': return result.access;
      case 'not_found': throw new PublicHttpError(404, ACCESS_MESSAGES.notFound);
      case 'revision_conflict': throw new PublicHttpError(409, ACCESS_MESSAGES.conflict);
      case 'role_global': throw new PublicHttpError(409, ACCESS_MESSAGES.roleGlobal);
      case 'actor_revoked': throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
      case 'invalid': throw new PublicHttpError(400, ACCESS_MESSAGES[result.reason]);
    }
  });

  app.get('/api/access/servers', {
    config: { access: { permission: 'users:manage' } },
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: ACCESS_LIMITS.searchLimit, default: 50 },
          afterName: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['items', 'nextAfterName'],
          properties: {
            items: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'isActive'], properties: { id: { type: 'string' }, name: { type: 'string' }, isActive: { type: 'boolean' } } },
            },
            nextAfterName: { type: ['string', 'null'] },
          },
        },
      },
    },
  }, async (request) => {
    const q = request.query as { q?: string; limit: number; afterName?: string };
    const search = q.q?.trim() ? q.q.trim() : null;
    return guarded(request, 'Server search', () => store.searchServers({ q: search, limit: q.limit, afterName: q.afterName ?? null }));
  });

  app.get('/api/access/servers/:id/services', {
    config: { access: { permission: 'users:manage' } },
    schema: {
      params: idParams,
      querystring: { type: 'object', additionalProperties: false, properties: { q: { type: 'string', maxLength: 128 } } },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['serverId', 'items', 'truncated'],
          properties: {
            serverId: { type: 'string' }, truncated: { type: 'boolean' },
            items: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['name', 'processes'], properties: { name: { type: 'string' }, processes: { type: 'integer' } } },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const q = (request.query as { q?: string }).q?.trim();
    const result = await guarded(request, 'Service list', () => store.serverServices({ serverId: id, q: q ? q : null, limit: ACCESS_LIMITS.servicesLimit }));
    if (!result) throw new PublicHttpError(404, 'Server not found');
    return { serverId: id, ...result };
  });
}
