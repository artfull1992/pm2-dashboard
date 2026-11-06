import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUTH_MESSAGES } from '../auth/plugin.js';
import { createRateLimiter, type RateLimiter, USER_ADMIN_LIMITS } from '../auth/rate-limit.js';
import { requestScope } from '../auth/scope.js';
import { describeError, PublicHttpError } from '../errors.js';
import { normalizeProjectInfo, PROJECT_INFO_LIMITS } from './project-info.js';
import type { ProjectInfoStore } from './project-info-store.js';

// Project information API (ADR-036): reference links and a short description of ONE service of a server. Reading:
// monitoring:read + the resource scope of that service; saving: servers:manage (admin), Origin + CSRF (auth plugin).
// The service name is a query parameter (GET) or a body field (PUT), never a path segment: any valid PM2 name is
// transported as data. Saving stores text only — nothing is fetched, opened, deployed or sent to an Agent.

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const NAME_PATTERN = '^[^\\u0000-\\u001f\\u007f-\\u009f]+$';
const serviceNameSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: NAME_PATTERN } as const;
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: UUID_PATTERN } } } as const;
const nullableText = (max: number) => ({ type: ['string', 'null'], maxLength: max } as const);
const viewSchema = {
  type: 'object', additionalProperties: false,
  required: ['serverId', 'serviceName', 'revision', 'githubUrl', 'projectUrl', 'description', 'updatedAt'],
  properties: {
    serverId: { type: 'string' }, serviceName: { type: 'string' }, revision: { type: 'integer' },
    githubUrl: { type: ['string', 'null'] }, projectUrl: { type: ['string', 'null'] }, description: { type: ['string', 'null'] },
    updatedAt: { type: ['string', 'null'] },
  },
} as const;

export const PROJECT_INFO_MESSAGES = Object.freeze({
  notFound: 'Application not found',
  conflict: 'Project information was changed by someone else: reload it and apply your changes again',
  invalid_github: 'GitHub must be a repository address: https://github.com/<owner>/<repository>',
  invalid_url: 'Project address must be an explicit http:// or https:// URL without credentials',
  invalid_text: 'Description must be plain text',
  too_long: 'Value is too long',
});

export interface ProjectInfoRoutesOptions { store: ProjectInfoStore; limiter?: RateLimiter }

export function registerProjectInfoRoutes(app: FastifyInstance, options: ProjectInfoRoutesOptions): void {
  const { store } = options;
  const limiter = options.limiter ?? createRateLimiter(USER_ADMIN_LIMITS.perActor);
  const guarded = async <T>(request: FastifyRequest, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      request.log.error({ error: describeError(error) }, `${what} failed`);
      throw new PublicHttpError(503, AUTH_MESSAGES.unavailable, { 'retry-after': '5' });
    }
  };

  app.get('/api/servers/:id/project-info', {
    config: { access: { permission: 'monitoring:read' } },
    schema: {
      params: idParams,
      querystring: { type: 'object', additionalProperties: false, required: ['service'], properties: { service: serviceNameSchema } },
      response: { 200: viewSchema },
    },
  }, async (request) => {
    const scope = requestScope(request.auth);
    const { id } = request.params as { id: string };
    const { service } = request.query as { service: string };
    const view = await guarded(request, 'Project information lookup', () => store.get({ serverId: id, serviceName: service, scope }));
    if (!view) throw new PublicHttpError(404, PROJECT_INFO_MESSAGES.notFound);
    return view;
  });

  app.put('/api/servers/:id/project-info', {
    config: { access: { permission: 'servers:manage' } },
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['serviceName', 'expectedRevision', 'githubUrl', 'projectUrl', 'description'],
        properties: {
          serviceName: serviceNameSchema,
          expectedRevision: { type: 'integer', minimum: 0 },
          githubUrl: nullableText(PROJECT_INFO_LIMITS.url),
          projectUrl: nullableText(PROJECT_INFO_LIMITS.url),
          // Room for CRLF line breaks: the limit applies to the normalized text below.
          description: nullableText(PROJECT_INFO_LIMITS.description * 2),
        },
      },
      response: { 200: viewSchema },
    },
  }, async (request) => {
    const auth = request.auth;
    if (!auth) throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    const retryAfter = limiter.hit(auth.userId);
    if (retryAfter > 0) throw new PublicHttpError(429, 'Too many changes, try again later', { 'retry-after': String(retryAfter) });
    const { id } = request.params as { id: string };
    const body = request.body as { serviceName: string; expectedRevision: number; githubUrl: string | null; projectUrl: string | null; description: string | null };
    const normalized = normalizeProjectInfo(body);
    if (!normalized.ok) throw new PublicHttpError(400, PROJECT_INFO_MESSAGES[normalized.problem]);
    const result = await guarded(request, 'Project information update', () => store.save({
      actor: { userId: auth.userId, sessionId: auth.sessionId }, serverId: id, serviceName: body.serviceName,
      expectedRevision: body.expectedRevision, value: normalized.value, requestId: request.id,
    }));
    switch (result.status) {
      case 'ok': return result.info;
      case 'not_found': throw new PublicHttpError(404, PROJECT_INFO_MESSAGES.notFound);
      case 'revision_conflict': throw new PublicHttpError(409, PROJECT_INFO_MESSAGES.conflict);
      case 'actor_revoked': throw new PublicHttpError(401, AUTH_MESSAGES.unauthenticated);
    }
  });
}
